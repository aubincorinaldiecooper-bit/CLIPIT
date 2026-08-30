import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import type { FastifyRequest } from 'fastify';
import {
  deleteClipRow,
  getClip,
  insertDerivedClip,
  listClipsForPrincipal,
  listWorkspacesForClip,
  setClipRenderPending,
  setClipTitle,
} from '../../db/repositories/clips.js';
import { listActivePostsForClip } from '../../db/repositories/social.js';
import { listWaitingScheduledPostsForClip } from '../../db/repositories/scheduledPosts.js';
import { getStorage } from '../../services/storage/s3.js';
import { getVideo } from '../../db/repositories/videos.js';
import { captionsSchema } from '../../services/media/captions.js';
import { enqueueClipGeneration } from '../../queues/index.js';
import { logger } from '../../lib/logger.js';
import { assertOwnership, ownerScope, requireSession } from '../auth.js';
import { enforceRateLimits, MINUTE } from '../rateLimit.js';
import { serializeClip, serializeLibraryClip } from '../serializers.js';
import { parse } from '../validation.js';
import type { Clip } from '../../domain/types.js';

/**
 * May this caller open this clip?
 *
 * Two ways in, and the second is the whole point of sending a clip to a room:
 * it is theirs (or a workspace-mate's), OR it has been sent to a room they
 * are in. A clip lives in its maker's library, so without the second check a
 * teammate would see it listed in the room and get "not found" on click.
 *
 * The share lookup only runs when the cheap check has already failed, so the
 * common case costs nothing.
 */
export async function assertClipAccess(request: FastifyRequest, clip: Clip): Promise<void> {
  try {
    assertOwnership(request, clip, 'Clip');
    return;
  } catch (cause) {
    const rooms = request.principal?.workspaceIds ?? [];
    if (rooms.length === 0) throw cause;
    const sharedWith = await listWorkspacesForClip(clip.id);
    if (!sharedWith.some((workspaceId) => rooms.includes(workspaceId))) throw cause;
  }
}

export async function registerClipRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The caller's clip library: every finished clip they can still play,
   * newest first, each carrying the moment it shows and the video it came
   * from. Signed in, it spans every session they have ever had.
   */
  app.get('/api/clips', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const { before } = parse(
      z.object({ before: z.coerce.date().optional() }),
      request.query ?? {},
      'query parameters',
    );

    // One extra row answers "is there more?" without a second count query. A
    // library must never truncate silently: older clips exist, and the client
    // is told exactly where the next page starts.
    const pageSize = 30;
    const entries = await listClipsForPrincipal(ownerScope(request), {
      limit: pageSize + 1,
      ...(before ? { before } : {}),
    });

    const pageEntries = entries.slice(0, pageSize);
    const nextBefore =
      entries.length > pageSize ? pageEntries[pageEntries.length - 1]!.clip.createdAt.toISOString() : null;

    return reply.send({
      clips: await Promise.all(pageEntries.map((entry) => serializeLibraryClip(entry))),
      nextBefore,
    });
  });

  /** A single clip, with a freshly signed playback URL once it is ready. */
  app.get('/api/clips/:clipId', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const { clipId } = parse(
      z.object({ clipId: z.string().uuid('must be a UUID') }),
      request.params,
      'path parameters',
    );

    const clip = await getClip(clipId);
    if (!clip) throw HttpError.notFound('Clip not found');
    await assertClipAccess(request, clip);

    // The source's true shape rides along so the caption editor can lay
    // text out against the real frame even before (or without) the video
    // file itself loading — a portrait source must never be previewed as
    // 16:9 guesswork.
    const video = await getVideo(clip.videoId);

    return reply.send({
      clip: {
        ...(await serializeClip(clip)),
        sourceWidth: video?.width ?? null,
        sourceHeight: video?.height ?? null,
        // Replacing re-renders someone's file in place; the editor only
        // offers it to the person whose clip it is.
        canReplace: Boolean(clip.userId && clip.userId === request.principal?.userId),
      },
    });
  });

  /**
   * Caption a clip: burn styled text into the footage.
   *
   * Two outcomes, in the owner's words. "Save new clip" makes a DERIVED clip
   * in the caller's own library — same moment, its own file — so captioning
   * something a teammate sent never alters theirs. "Replace existing one"
   * re-renders in place, and only the person who cut the clip may do that.
   *
   * Every render starts from the pristine source, so editing again never
   * stacks text on text — and a replace with an empty caption list is how
   * captions come OFF a clip.
   */
  app.post('/api/clips/:clipId/captions', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'generate', perSession: env.RATE_LIMIT_GENERATE_PER_SESSION_HOURLY, windowSeconds: 60 * 60 },
    ]);

    const { clipId } = parse(
      z.object({ clipId: z.string().uuid('must be a UUID') }),
      request.params,
      'path parameters',
    );
    const body = parse(
      z.object({ mode: z.enum(['new', 'replace']), captions: captionsSchema }),
      request.body ?? {},
    );

    const clip = await getClip(clipId);
    if (!clip) throw HttpError.notFound('Clip not found');
    await assertClipAccess(request, clip);

    // Rendering needs the source footage; without it there is nothing to
    // draw on, and saying so beats a job that fails in the background.
    const video = await getVideo(clip.videoId);
    if (!video?.originalStorageKey || video.footageExpiredAt) {
      throw HttpError.conflict("The source footage for this clip has been removed, so captions can't be rendered.");
    }

    if (body.mode === 'replace') {
      if (!clip.userId || clip.userId !== request.principal?.userId) {
        throw HttpError.forbidden('Only the person who cut this clip can replace it — save as a new clip instead.');
      }
      // One render at a time. A second replace while one is in flight would
      // be silently swallowed by the queue's duplicate-job id and leave the
      // row describing captions the file never got.
      if (clip.status !== 'ready') {
        throw HttpError.conflict('This clip is still rendering — try again when it finishes.');
      }
      // The new spec rides in the JOB and is written to the row only when
      // its render succeeds; until then the row keeps describing the file
      // that actually exists, and a failure hands the working clip back.
      await setClipRenderPending(clipId);
      await enqueueClipGeneration({ clipId, captions: body.captions });
      logger.info('clip re-render queued', { clipId, captions: body.captions.length });
      return reply.code(202).send({ clip: await serializeClip({ ...clip, status: 'pending' }, false) });
    }

    if (body.captions.length === 0) {
      throw HttpError.badRequest('A new clip needs at least one caption — otherwise it would be a plain copy.');
    }

    const derived = await insertDerivedClip({
      sourceClip: clip,
      sessionId: request.principal?.sessionId ?? null,
      userId: request.principal?.userId ?? null,
      workspaceId: request.principal?.ownWorkspaceId ?? null,
      captions: body.captions,
    });
    await enqueueClipGeneration({ clipId: derived.id });
    logger.info('captioned copy queued', { clipId, derivedClipId: derived.id });
    return reply.code(202).send({ clip: await serializeClip(derived, false) });
  });

  /**
   * Rename a clip. The name is the person's own and rides above the
   * moment's description everywhere clips are listed; an empty string takes
   * the custom name back and the description shows again. Owner-only — a
   * room-mate can watch a shared clip, not rename it under its maker.
   */
  app.patch('/api/clips/:clipId', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);
    const { clipId } = parse(
      z.object({ clipId: z.string().uuid('must be a UUID') }),
      request.params,
      'path parameters',
    );
    const body = parse(z.object({ title: z.string().trim().max(200) }), request.body ?? {}, 'body');

    const clip = await getClip(clipId);
    if (!clip) throw HttpError.notFound('Clip not found');
    assertOwnership(request, clip, 'Clip');

    const updated = await setClipTitle(clipId, body.title === '' ? null : body.title);
    if (!updated) throw HttpError.notFound('Clip not found');
    return reply.send({ clip: await serializeClip(updated) });
  });

  /**
   * Delete a clip. Refused while anything still depends on the file: a
   * publish being submitted or shaped right now, or a scheduled post
   * waiting on it — deleting under those would leave a promise that can
   * only fail, hours later, for a reason the person deleted on purpose.
   * The files go best-effort after the row; see deleteClipRow.
   */
  app.delete('/api/clips/:clipId', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);
    const { clipId } = parse(
      z.object({ clipId: z.string().uuid('must be a UUID') }),
      request.params,
      'path parameters',
    );

    const clip = await getClip(clipId);
    if (!clip) throw HttpError.notFound('Clip not found');
    assertOwnership(request, clip, 'Clip');

    const activePosts = await listActivePostsForClip(clipId);
    if (activePosts.length > 0) {
      throw HttpError.conflict('This clip is being published right now. Try again in a minute.');
    }
    const waiting = await listWaitingScheduledPostsForClip(clipId);
    if (waiting.length > 0) {
      throw HttpError.conflict(
        'This clip has a scheduled post waiting. Cancel the scheduled post first, then delete the clip.',
      );
    }

    const removed = await deleteClipRow(clipId);
    if (!removed) throw HttpError.notFound('Clip not found');

    // Files after the row, best-effort: an orphaned object costs pennies; a
    // row for a file that is gone would keep a dead clip in the library.
    const keys = [removed.storageKey, ...removed.variantKeys].filter((key): key is string => Boolean(key));
    for (const key of keys) {
      await getStorage()
        .remove(key)
        .catch((cause: unknown) =>
          logger.warn('clip file removal failed; object orphaned', { clipId, key, err: cause }),
        );
    }
    logger.info('clip deleted', { clipId, files: keys.length });
    return reply.send({ deleted: true });
  });
}
