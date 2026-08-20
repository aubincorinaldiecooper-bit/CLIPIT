import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { formatTimecode } from '../../services/timestamps.js';
import { getClipRequest, listMatches, listMatchesByIds } from '../../db/repositories/clipRequests.js';
import { listClipsForRequest, upsertClipForMatch } from '../../db/repositories/clips.js';
import { getVideo } from '../../db/repositories/videos.js';
import { enqueueClipGeneration } from '../../queues/index.js';
import { assertOwnership, requireSession } from '../auth.js';
import { enforceRateLimits, HOUR, MINUTE } from '../rateLimit.js';
import { searchCoverage, serializeClip, serializeClipRequest, type SearchCoverage } from '../serializers.js';
import { parse } from '../validation.js';
import type { Clip } from '../../domain/types.js';

const uuidSchema = z.string().uuid('must be a UUID');

/**
 * Says why nothing was found, without blaming the instruction for something
 * the instruction did not cause.
 *
 * Telling a user to rephrase is only fair when the whole video was actually
 * searched. When a provider refused part of it, rewording hits the same
 * filter — so the advice cannot work, and the real answer is that a stretch of
 * video was never looked at.
 */
function explainNoMatches(coverage: SearchCoverage): string {
  if (coverage.complete) return 'No matches to generate. Try a different instruction.';

  if (!coverage.locatable || coverage.unsearchedSeconds === 0) {
    // The duration is unknown, not zero. Saying "00:00:00 could not be
    // examined" would read as nothing having been missed at all.
    return 'No matches to generate. Part of this video could not be examined, so the moment may be in a stretch that was never searched.';
  }

  return `No matches to generate. ${formatTimecode(coverage.unsearchedSeconds)} of this video could not be examined, so the moment may be in a stretch that was never searched.`;
}

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
      clipRequest: await serializeClipRequest(clipRequest, matches, clipsByMatchId),
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

    // Generation waits for the search to finish, even though partial matches
    // are already readable. The aggregation pass at the end of a search
    // rewrites the match rows, and `clips.clip_match_id` cascades on delete —
    // so a clip generated from a partial result would be deleted out from
    // under its own running job.
    if (clipRequest.status !== 'completed') {
      throw HttpError.conflict('The search is still running — wait for it to complete before generating clips');
    }

    const video = await getVideo(clipRequest.videoId);
    if (!video) throw HttpError.notFound('Video not found');

    const matches = body.matchIds?.length
      ? await listMatchesByIds(requestId, body.matchIds)
      : await listMatches(requestId);

    if (matches.length === 0) {
      // Blaming the instruction is only fair when the whole video was actually
      // searched. If a provider refused part of it, telling the user to
      // rephrase sends them to fix something that was never wrong.
      const coverage = searchCoverage(clipRequest);
      throw HttpError.unprocessable(explainNoMatches(coverage), { coverage });
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
