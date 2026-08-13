import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { getClipRequest, listMatches, listMatchesByIds } from '../../db/repositories/clipRequests.js';
import { listClipsForRequest, upsertClipForMatch } from '../../db/repositories/clips.js';
import { getVideo } from '../../db/repositories/videos.js';
import { enqueueClipGeneration } from '../../queues/index.js';
import { assertOwnership, requireSession } from '../auth.js';
import { enforceRateLimits, HOUR, MINUTE } from '../rateLimit.js';
import { serializeClip, serializeClipRequest } from '../serializers.js';
import { parse } from '../validation.js';
import type { Clip } from '../../domain/types.js';

const uuidSchema = z.string().uuid('must be a UUID');

const generateSchema = z
  .object({
    /** Omit to generate every match found by the search. */
    matchIds: z.array(uuidSchema).max(100).optional(),
  })
  .optional()
  .default({});

export async function registerClipRequestRoutes(app: FastifyInstance): Promise<void> {
  /** Search status, progress, and the matches found so far. */
  app.get('/api/clip-requests/:requestId', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const { requestId } = parse(z.object({ requestId: uuidSchema }), request.params, 'path parameters');

    const clipRequest = await getClipRequest(requestId);
    if (!clipRequest) throw HttpError.notFound('Clip request not found');
    assertOwnership(request, clipRequest, 'Clip request');

    const [matches, clips] = await Promise.all([listMatches(requestId), listClipsForRequest(requestId)]);
    const clipsByMatchId = new Map<string, Clip>(clips.map((clip) => [clip.clipMatchId, clip]));

    return reply.send({
      clipRequest: serializeClipRequest(clipRequest, matches, clipsByMatchId),
      clips: await Promise.all(clips.map((clip) => serializeClip(clip))),
    });
  });

  /**
   * Turns matches into real MP4s. Generation happens in the worker; this
   * returns immediately with clip records to poll.
   */
  app.post('/api/clip-requests/:requestId/generate', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      {
        scope: 'generate',
        perSession: env.RATE_LIMIT_GENERATE_PER_SESSION_HOURLY,
        perIp: env.RATE_LIMIT_GENERATE_PER_IP_HOURLY,
        windowSeconds: HOUR,
      },
    ]);

    const { requestId } = parse(z.object({ requestId: uuidSchema }), request.params, 'path parameters');
    const body = parse(generateSchema, request.body ?? {});

    const clipRequest = await getClipRequest(requestId);
    if (!clipRequest) throw HttpError.notFound('Clip request not found');
    assertOwnership(request, clipRequest, 'Clip request');

    if (clipRequest.status === 'failed') {
      throw HttpError.conflict(`Search failed: ${clipRequest.errorMessage ?? 'unknown error'}`);
    }

    const video = await getVideo(clipRequest.videoId);
    if (!video) throw HttpError.notFound('Video not found');

    const matches = body.matchIds?.length
      ? await listMatchesByIds(requestId, body.matchIds)
      : await listMatches(requestId);

    if (matches.length === 0) {
      throw HttpError.unprocessable(
        clipRequest.status === 'searching'
          ? 'The search is still running — wait for it to complete before generating clips'
          : 'No matches to generate. Try a different instruction.',
      );
    }

    if (body.matchIds?.length && matches.length !== body.matchIds.length) {
      const found = new Set(matches.map((match) => match.id));
      throw HttpError.badRequest('Some matchIds do not belong to this clip request', {
        unknownMatchIds: body.matchIds.filter((id) => !found.has(id)),
      });
    }

    const clips: Clip[] = [];
    for (const match of matches) {
      const clip = await upsertClipForMatch({
        videoId: clipRequest.videoId,
        clipMatchId: match.id,
        sessionId: clipRequest.sessionId,
        startSeconds: match.globalStartSeconds,
        endSeconds: match.globalEndSeconds,
      });
      clips.push(clip);

      // A clip that is already rendered does not need to be cut again.
      if (clip.status !== 'ready') await enqueueClipGeneration({ clipId: clip.id });
    }

    logger.info('clip generation queued', { requestId, clips: clips.length });

    return reply.code(202).send({
      clips: await Promise.all(clips.map((clip) => serializeClip(clip))),
    });
  });
}
