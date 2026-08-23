import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import type { FastifyRequest } from 'fastify';
import { getClip, listClipsForPrincipal, listWorkspacesForClip } from '../../db/repositories/clips.js';
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

    return reply.send({ clip: await serializeClip(clip) });
  });
}
