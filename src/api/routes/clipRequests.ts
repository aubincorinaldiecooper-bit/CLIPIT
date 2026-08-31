import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { formatTimecode } from '../../services/timestamps.js';
import {
  getClipRequest,
  listMatches,
  listMatchesByIds,
  setMatchFeedback,
} from '../../db/repositories/clipRequests.js';
import { getRootClipByMatchId, listClipsForRequest, upsertClipForMatch } from '../../db/repositories/clips.js';
import { approveClip } from '../../db/repositories/verticalMedia.js';
import { keepAction, retentionClassFor } from '../../services/media/keepApproval.js';
import { claimReclip, clearReclipPending, latestVersionsForMatches } from '../../db/repositories/reclips.js';
import { getVideo } from '../../db/repositories/videos.js';
import { enqueueClipGeneration, enqueueReclip } from '../../queues/index.js';
import { assertOwnership, requireSession } from '../auth.js';
import { enforceRateLimits, HOUR, MINUTE } from '../rateLimit.js';
import {
  creatorVisibleDeck,
  searchCoverage,
  serializeClip,
  serializeClipRequest,
  serializeMatch,
  type SearchCoverage,
} from '../serializers.js';
import { parse } from '../validation.js';
import { MATCH_FEEDBACK_REASONS, type Clip, type MatchFeedbackReason } from '../../domain/types.js';

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

const feedbackSchema = z.object({
  /** `null` clears an earlier verdict rather than recording a third state. */
  verdict: z.enum(['approved', 'rejected']).nullable(),
  /**
   * Optional, and only meaningful with a rejection: why this moment was
   * waved away. The interaction stays two buttons — a reason is offered
   * after a thumbs-down, never demanded. 'missed_moment' is the one that
   * matters most: it is the closest live signal to "the moment I wanted
   * was not found", which no per-moment thumbs-down can otherwise express.
   */
  reason: z.enum(MATCH_FEEDBACK_REASONS as [MatchFeedbackReason, ...MatchFeedbackReason[]]).nullish(),
});

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

    const [allMatches, allClips] = await Promise.all([listMatches(requestId), listClipsForRequest(requestId)]);
    const clipsByMatchId = new Map<string, Clip>(allClips.map((clip) => [clip.clipMatchId, clip]));

    // A post-ready request renders more candidates than it shows, so the
    // answer is the finished set — not everything the search happened to
    // store. Requests that never pre-rendered anything are untouched.
    const visible = creatorVisibleDeck(clipRequest, allMatches, clipsByMatchId);
    if (visible.withheld > 0) {
      logger.info('withheld unfinished moments from a creator response', {
        requestId, shown: visible.matches.length, withheld: visible.withheld,
      });
    }

    return reply.send({
      clipRequest: await serializeClipRequest(clipRequest, visible.matches, clipsByMatchId),
      clips: await Promise.all(visible.clips.map((clip: Clip) => serializeClip(clip))),
    });
  });

  /**
   * Records what a person thought of one match.
   *
   * The only judgement in the system that is not the model's own. `null`
   * clears it, so a mis-tap is recoverable — a thumbs-down takes a moment off
   * the user's screen, and nothing that easy to hit should be permanent.
   */
  app.post('/api/clip-requests/:requestId/matches/:matchId/feedback', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const { requestId, matchId } = parse(
      z.object({ requestId: uuidSchema, matchId: uuidSchema }),
      request.params,
      'path parameters',
    );
    const { verdict, reason } = parse(feedbackSchema, request.body ?? {});

    const clipRequest = await getClipRequest(requestId);
    if (!clipRequest) throw HttpError.notFound('Clip request not found');
    assertOwnership(request, clipRequest, 'Clip request');

    // Scoped to the request as well as the match, so a guessed id cannot mark
    // a moment belonging to someone else's search.
    const match = await setMatchFeedback(requestId, matchId, verdict, reason ?? null);
    if (!match) throw HttpError.notFound('Match not found');

    const versions = await latestVersionsForMatches([matchId]);
    return reply.send({ match: await serializeMatch(match, null, versions.get(matchId) ?? null) });
  });

  /**
   * Asks the system to reconsider this SAME moment: a wider window of the
   * surrounding footage is re-read and a better standalone cut of the same
   * moment replaces the boundaries. This is the automated answer to "the
   * timing is off" — the person never repairs timestamps by hand.
   *
   * Bounded on purpose: each press is a paid model call on GPU time, so the
   * per-moment ceiling and the pending-claim below keep a double-tap, an
   * impatient retry, or a stuck queue from turning one tap into many calls.
   */
  app.post('/api/clip-requests/:requestId/matches/:matchId/reclip', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      {
        scope: 'generate',
        perSession: env.RATE_LIMIT_GENERATE_PER_SESSION_HOURLY,
        perIp: env.RATE_LIMIT_GENERATE_PER_IP_HOURLY,
        windowSeconds: HOUR,
      },
    ]);

    const { requestId, matchId } = parse(
      z.object({ requestId: uuidSchema, matchId: uuidSchema }),
      request.params,
      'path parameters',
    );

    const clipRequest = await getClipRequest(requestId);
    if (!clipRequest) throw HttpError.notFound('Clip request not found');
    assertOwnership(request, clipRequest, 'Clip request');

    const [match] = await listMatchesByIds(requestId, [matchId]);
    if (!match) throw HttpError.notFound('Match not found');

    const video = await getVideo(clipRequest.videoId);
    if (!video?.proxyStorageKey) {
      throw HttpError.conflict('The footage for this video is no longer stored, so it cannot be re-examined.');
    }

    // A moment whose clip is mid-render cannot take new boundaries — say so
    // now, before any GPU time is spent finding boundaries it cannot apply.
    const clip = await getRootClipByMatchId(matchId);
    if (clip && clip.status !== 'ready' && clip.status !== 'failed') {
      throw HttpError.conflict('This clip is still rendering — try Re-clip when it finishes.');
    }

    // The claim is the whole cost gate: it refuses a moment already
    // re-evaluating AND consumes one attempt from the lifetime allowance in
    // the same statement — a double-tap gets a truthful 409, and failed paid
    // calls count against the ceiling exactly like successful ones.
    const claimed = await claimReclip(matchId, env.MAX_RECLIPS_PER_MOMENT);
    if (!claimed) {
      if (match.reclipStatus === 'pending') {
        throw HttpError.conflict('A Re-clip for this moment is already running.');
      }
      throw HttpError.conflict('This moment has used all its Re-clip attempts.');
    }

    try {
      await enqueueReclip({ matchId, clipRequestId: requestId });
    } catch (cause) {
      // No job means nothing will ever clear the pending state — put the
      // moment back exactly as it was and say the tap did not take.
      await clearReclipPending(matchId);
      logger.error('reclip rolled back: job could not be queued', { matchId, err: cause });
      throw HttpError.serviceUnavailable('Re-clip could not be queued. Nothing was changed — try again in a moment.');
    }

    const [updated] = await listMatchesByIds(requestId, [matchId]);
    const versions = await latestVersionsForMatches([matchId]);
    logger.info('reclip queued', { requestId, matchId, attempt: (match.reclipAttempts ?? 0) + 1 });
    return reply.code(202).send({ match: await serializeMatch(updated ?? match, null, versions.get(matchId) ?? null) });
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

    // An explicit list is taken at its word — asking for a match by id is a
    // deliberate act, even one previously waved off. Generating "everything",
    // though, must not spend a render on a moment the user has already said is
    // wrong; on their screen it is gone.
    const all = body.matchIds?.length
      ? await listMatchesByIds(requestId, body.matchIds)
      : await listMatches(requestId);
    const matches = body.matchIds?.length ? all : all.filter((match) => match.feedback !== 'rejected');

    // Telling someone to rephrase when the search worked and they simply waved
    // every result away would send them to fix the one thing that was fine.
    if (matches.length === 0 && all.length > 0) {
      throw HttpError.unprocessable(
        'Every match here was marked as wrong. Undo a thumbs-down, or try a different instruction.',
      );
    }

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

    // A re-clipped moment's cut must use its CURRENT boundaries. The match
    // row keeps the original prediction untouched; the version history says
    // where the moment stands now.
    const currentBounds = await latestVersionsForMatches(matches.map((match) => match.id));

    const clips: Clip[] = [];
    let approved = 0;
    let queued = 0;

    for (const match of matches) {
      const bounds = currentBounds.get(match.id);
      const clip = await upsertClipForMatch({
        videoId: clipRequest.videoId,
        clipMatchId: match.id,
        sessionId: clipRequest.sessionId,
        userId: clipRequest.userId,
        startSeconds: bounds?.startSeconds ?? match.globalStartSeconds,
        endSeconds: bounds?.endSeconds ?? match.globalEndSeconds,
      });

      // What Keep means now depends on whether the media already exists.
      //
      // On the post-ready path the file was made before the card was ever
      // shown, so Keep is an APPROVAL. Re-rendering would spend a second GPU
      // call re-deciding framing that was already decided, and could hand
      // back a differently-cropped clip from the one the person just chose:
      // they would have kept one clip and received another.
      //
      // Everywhere else Keep still cuts the clip, exactly as before.
      const action = keepAction({
        preRendered: clip.preRendered,
        derivativeStatus: clip.derivativeStatus,
        derivativeStorageKey: clip.derivativeStorageKey,
        posterStorageKey: clip.posterStorageKey,
        clipStatus: clip.status,
      });

      if (action.kind === 'reject') {
        // A pre-rendered card should never have reached anyone in this state.
        // Refusing surfaces the invariant violation; regenerating would
        // quietly paper over it.
        logger.error('keep refused on an unfinished pre-rendered moment', {
          requestId, clipId: clip.id, reason: action.reason,
        });
        throw HttpError.unprocessable('That moment is not finished yet. Ask again to rebuild it.');
      }

      if (action.kind === 'approve') {
        // retentionClassFor's decision, applied. Approval is what promotes a
        // file from temporary to owned, and is the reason the retention
        // sweep will leave it alone.
        const took = await approveClip(clip.id);
        if (!took) {
          logger.error('approval did not take', { requestId, clipId: clip.id });
          throw HttpError.unprocessable('That moment is not finished yet. Ask again to rebuild it.');
        }
        approved += 1;
        clips.push({
          ...clip,
          approvedAt: clip.approvedAt ?? new Date(),
          retentionClass: retentionClassFor({ approved: true, preRendered: true }),
        });
        continue;
      }

      clips.push(clip);
      // A clip that is already rendered does not need to be cut again.
      if (clip.status !== 'ready') {
        await enqueueClipGeneration({ clipId: clip.id });
        queued += 1;
      }
    }

    logger.info('keep handled', { requestId, clips: clips.length, approved, queued });

    return reply.code(202).send({
      clips: await Promise.all(clips.map((clip) => serializeClip(clip))),
    });
  });
}
