import path from 'node:path';
import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger, type Logger } from '../../lib/logger.js';
import { ExternalServiceError, errorMessage } from '../../lib/errors.js';
import { withWorkDir } from '../../lib/workdir.js';
import { mapWithConcurrency } from '../../lib/concurrency.js';
import { getStorage } from '../../services/storage/s3.js';
import { attachThumbnails } from '../../services/media/thumbnails.js';
import { recordModelUsage } from '../../db/repositories/usage.js';
import { UsageTally } from '../../services/usageTally.js';
import {
  isContentFilterRejection,
  resetVideoCallPeak,
  searchVideoChunk,
  videoCallStats,
} from '../../services/search/openrouterVideo.js';
import { isCorrection } from '../../services/search/rescanPolicy.js';
import { assertVideoInputSupported } from '../../services/search/modelCapabilities.js';
import { resolveSearchMode } from '../../services/search/instructionMode.js';
import { aggregateMatches } from '../../services/search/aggregateMatches.js';
import type { TranscriptLine } from '../../services/search/prompt.js';
import {
  mapGlobalRangeToChunk,
  mapLocalRangeToGlobal,
  mergeOverlappingRanges,
} from '../../services/timestamps.js';
import { getVideo, listChunks } from '../../db/repositories/videos.js';
import { listTranscriptSegmentsInRange } from '../../db/repositories/transcripts.js';
import {
  claimClipRequestAttempt,
  finishClipRequest,
  getClipRequest,
  getPreviousClipRequest,
  insertMatches,
  listMatches,
  recordChunkCompleted,
  recordChunkDegraded,
  recordChunkFailure,
  recordConversationalAnswer,
  recordDeckAvailability,
  recordDeckPlan,
  recordRetrievalOutcome,
  recordCorrection,
  recordUncertainMatches,
  releaseDeckAndComplete,
  startClipRequest,
  type NewClipMatch,
} from '../../db/repositories/clipRequests.js';
import { enqueueClipSearch, type ClipSearchJob } from '../../queues/index.js';
import {
  needsVerticalDerivative,
  resolvePlatformIntent,
  type PlatformIntent,
} from '../../services/search/platformIntent.js';
import { clearUnkeptMatchesForRequest } from '../../db/repositories/verticalMedia.js';
import { verticalForRework } from '../../services/search/presentationTarget.js';
import { PREPARATION_TIMED_OUT_MESSAGE, preparationWait } from '../../services/search/readiness.js';
import type {
  ChunkDegradation,
  ClipRequest,
  ChunkFailureCode,
  MatchSource,
  AnsweredFrom,
  FallbackReason,
  ResolvedSearchMode,
  RetrievalSystem,
  UncertainMatch,
  Video,
  VideoChunk,
} from '../../domain/types.js';

/**
 * Names why a chunk went unsearched.
 *
 * The distinction that matters is between a provider refusing this input on
 * policy grounds — which will happen again identically, and means a window of
 * the video is simply unavailable to this provider — and an ordinary transient
 * failure, which is worth another attempt. Reporting both as "failed" left the
 * user with no way to tell a bad moment from a bad minute.
 */
function classifyChunkFailure(reason: unknown): ChunkFailureCode {
  if (isContentFilterRejection(reason)) return 'provider_content_filter';
  if (!(reason instanceof ExternalServiceError)) return 'unknown';
  if (/timed out/i.test(reason.message)) return 'timeout';
  if (/request failed:/i.test(reason.message)) return 'transport';
  if (/status \d{3}/i.test(reason.message)) return 'provider_error';
  return 'unknown';
}

/**
 * Runs the user's instruction against every analysis chunk.
 *
 * The instruction is passed through verbatim — there are no predefined clip
 * categories. Each chunk is searched independently, and a chunk that fails is
 * recorded and skipped rather than failing the whole request.
 */
import { writeConversationalAnswer } from '../../services/search/conversationalAnswer.js';
import { getSimpleMemIndex } from '../../db/repositories/simplememIndex.js';
import { simplememQuery } from '../../services/retrieval/simplemem/client.js';
import { decideFallback, mapCandidates, uncaptionedRanges } from '../../services/retrieval/simplemem/candidates.js';
import { rerankSimpleMemCandidates } from '../../services/retrieval/simplemem/rerank.js';
import {
  WATCH_MAX_EVENTS,
  analyzeUploadedVideo,
  placeMomentsOnChunks,
  type UploadedVideoAnalysis,
} from '../../services/retrieval/uploadedVideo.js';

export async function handleClipSearch(job: Job<ClipSearchJob>): Promise<void> {
  const { clipRequestId } = job.data;
  const log = logger.child({ job: 'clip-search', clipRequestId });

  const request = await getClipRequest(clipRequestId);
  if (!request) {
    log.warn('clip request no longer exists, dropping job');
    return;
  }
  if (request.status === 'completed') {
    log.info('clip request already completed, skipping');
    return;
  }

  // Claimed before anything can fail, so every exit from this delivery is
  // fenced by a claim it actually holds. Minting it at deck-planning time
  // left the checks below unclaimed, and a redelivery failing there could not
  // record its own failure if a dead run had left a token behind.
  const deckAttemptId = await claimClipRequestAttempt(clipRequestId);
  if (!deckAttemptId) {
    // Gone, or finished by another delivery between the read above and this
    // claim. Either way this delivery has nothing to say about it.
    log.info('clip request is no longer claimable; another delivery owns the answer');
    return;
  }

  const video = await getVideo(request.videoId);
  if (!video) {
    const wrote = await finishClipRequest(
      clipRequestId, 'failed', 'Video no longer exists', null, deckAttemptId,
    );
    if (!wrote) {
      log.warn('another attempt owns this request; leaving its outcome alone', { clipRequestId });
    }
    return;
  }

  const tally = new UsageTally();
  // Per-request latency lives in model_usage; this is the number the user
  // actually waits through, and the one that says whether chunk size and
  // concurrency need changing before any further architecture does.
  const searchStartedAt = performance.now();
  // Captured as they are decided so the cost line can be emitted from the
  // failure path too, where neither is in scope.
  let chunkCount = 0;
  let searchMode: ResolvedSearchMode | null = null;
  let outcome: 'completed' | 'failed' = 'failed';
  // What the request asked for, read once. Both the search and the render
  // must never form separate opinions about whether this is a TikTok ask.
  let intent = resolvePlatformIntent(request.instruction, env.MAX_CLIP_SECONDS, {
    maxCount: env.VERTICAL_CANDIDATE_CEILING,
  });
  /** Milliseconds this question has already spent parked for the transcript, across every re-queue. */
  const waitedMs = job.data.waitedMs ?? 0;
  /**
   * Milliseconds spent parked for the video's preparation, counted apart
   * from the transcript wait. A large upload can spend minutes preparing;
   * that time must not consume the separate allowance for speech readiness.
   */
  const preparationWaitedMs = job.data.preparationWaitedMs ?? 0;

  try {
    // A question is accepted the moment the video's bytes have landed; the
    // answer waits here for the video to be prepared — its analysis segments
    // — before retrieval or transcript-dependent search can proceed.
    // Bounded, so a preparation that never finishes still ends in an answer:
    // a refusal, said plainly, rather than a question parked for good.
    const preparation = preparationWait(video.status, preparationWaitedMs, env.PREPARATION_WAIT_TIMEOUT_MS);
    if (preparation === 'wait') {
      log.info('waiting for the video to be prepared', { preparationWaitedMs, videoStatus: video.status });
      await enqueueClipSearch(
        { clipRequestId, waitedMs, preparationWaitedMs: preparationWaitedMs + env.PREPARATION_WAIT_POLL_MS },
        { delay: env.PREPARATION_WAIT_POLL_MS },
      );
      outcome = 'completed';
      return;
    }
    if (preparation === 'timed_out') throw new Error(PREPARATION_TIMED_OUT_MESSAGE);
    if (video.status !== 'ready') {
      // Failed, or a status this handler does not know.
      throw new Error(
        video.status === 'failed'
          ? `Video processing failed: ${video.errorMessage ?? 'unknown error'}`
          : `Video is not ready for search (status: ${video.status})`,
      );
    }

    const chunks = await listChunks(video.id);
    if (chunks.length === 0) throw new Error('Video has no analysis chunks');

    /**
     * A correction is not a new question.
     *
     * "Are you sure?" describes no moment, so searching it literally can only
     * fail — and the failure is indistinguishable from the app ignoring the
     * user. What it means is: your last answer was wrong. So the previous
     * question is re-run and goes straight to actual footage rather than
     * trusting a previous retrieval result.
     */
    let instruction = request.instruction;
    let correcting = false;

    if (isCorrection(instruction)) {
      const previous = await getPreviousClipRequest({
        videoId: request.videoId,
        sessionId: request.sessionId,
        userId: request.userId,
        before: request.createdAt,
      });

      if (!previous) {
        // Nothing to look at again. Saying so is better than searching the
        // video for the words "are you sure" and reporting an absence.
        await finishClipRequest(
          clipRequestId,
          'failed',
          'There is nothing to look at again yet — ask about a moment first.',
          null,
          deckAttemptId,
        );
        outcome = 'completed';
        return;
      }

      instruction = previous.instruction;
      correcting = true;
      // "Are you sure?" names no platform. Reading the intent from those
      // three words would answer a TikTok question with a list of
      // timestamps — so the intent is re-read from the question actually
      // being looked at again, exactly as the search itself is.
      intent = resolvePlatformIntent(instruction, env.MAX_CLIP_SECONDS, {
        maxCount: env.VERTICAL_CANDIDATE_CEILING,
      });
      // The strongest signal there is — a person saying our answer was wrong.
      // Stored so it survives the footage and can be counted later.
      await recordCorrection(clipRequestId, previous.id);
      log.info('treating this as a correction rather than a new question', {
        said: request.instruction,
        lookingAgainFor: instruction,
      });
    }

    // Declare what this request owes BEFORE any path can answer it.
    //
    // The ordering is load-bearing, not tidiness. The creator-facing gate asks
    // the request row "do you owe a finished deck, and does it stand yet?" If
    // that first answer were still unwritten while clips were becoming ready,
    // a client polling in the gap would fall through to the legacy path and be
    // handed one finished card — the progressive reveal the whole rule forbids,
    // appearing only under timing nobody tests for.
    //
    // It sits above the retrieval path deliberately. Answering from SimpleMem is
    // a real answer and reaches completion on its own; if the plan were recorded
    // further down, a memory answer would never be marked as owing a deck at all.
    //
    // It also CLEARS any previous completion, so a retrying job cannot serve
    // last run's finished deck while it rebuilds this one.
    const planned = await recordDeckPlan(clipRequestId, {
      presentationTarget: needsVerticalDerivative(intent) ? 'vertical' : 'original',
      // A number in the question is the target. Without one, the answer is
      // every moment the search finds — a two-minute clip can only hold so
      // many, and the footage decides that, not a default (owner, 2026-09-02).
      // Not a number until the search has run, so none is recorded yet.
      requestedResultCount: intent.countExplicit ? intent.requestedCount : null,
    }, deckAttemptId);
    if (!planned) {
      // Another delivery claimed this request while we were getting here.
      // It owns the answer now; carrying on would spend renders whose every
      // write is refused.
      log.warn('superseded before planning; standing down', { clipRequestId });
      outcome = 'completed';
      return;
    }

    // Decide what to search. A transcript that is still being built is worth a
    // bounded wait, because falling back to visual-only silently would give the
    // user a worse answer for a spoken-word instruction.
    const transcriptPending = video.transcriptStatus === 'pending' || video.transcriptStatus === 'queued' || video.transcriptStatus === 'running';
    const transcriptReady = video.transcriptStatus === 'ready' && video.transcriptSegmentCount > 0;

    const desired = resolveSearchMode({
      instruction,
      requested: request.mode,
      transcriptAvailable: transcriptReady || transcriptPending,
    });

    if (desired.mode !== 'visual' && transcriptPending && waitedMs < env.TRANSCRIPT_WAIT_TIMEOUT_MS) {
      log.info('waiting for transcript before searching', {
        waitedMs,
        transcriptStatus: video.transcriptStatus,
      });
      await enqueueClipSearch(
        { clipRequestId, waitedMs: waitedMs + env.TRANSCRIPT_WAIT_POLL_MS },
        { delay: env.TRANSCRIPT_WAIT_POLL_MS },
      );
      return;
    }

    // Re-resolve now that waiting is over: the transcript may have failed, or
    // never arrived, in which case we search visually rather than not at all.
    const resolved = resolveSearchMode({
      instruction,
      requested: request.mode,
      transcriptAvailable: transcriptReady,
    });

    log.info('starting clip search', {
      mode: resolved.mode,
      rationale: resolved.rationale,
      chunks: chunks.length,
      instruction,
      // How long the question sat before this delivery began (the queue), and
      // how long it has been parked waiting for the video across re-queues.
      queueWaitMs: Math.max(0, (job.processedOn ?? Date.now()) - job.timestamp),
      waitedMs,
      preparationWaitedMs,
      ...(correcting ? { correctionOf: request.instruction } : {}),
    });

    /**
     * Omni-SimpleMem is the memory/retrieval layer. A confident candidate is
     * verified against actual footage before it can become evidence. A miss or
     * unavailable index falls through to the full actual-footage search; memory
     * is never allowed to prove absence by itself.
     */
    const fromSimpleMem = await answerFromSimpleMem({
      clipRequestId,
      deckAttemptId,
      requestedResultCount: intent.countExplicit ? intent.requestedCount : null,
      video,
      chunks,
      instruction,
      mode: resolved.mode,
      correcting,
      log,
    });
    if (fromSimpleMem.matchCount > 0) {
      await recordRetrievalOutcome(clipRequestId, {
        primary: env.RETRIEVAL_PRIMARY === 'videochat3' ? 'videochat3' : 'simplemem',
        system: 'simplemem',
        fallbackReason: null,
        primaryOutcome: fromSimpleMem.outcome,
      });
      outcome = 'completed';
      searchMode = resolved.mode;
      chunkCount = 0;
      return;
    }
    if (env.RETRIEVAL_PRIMARY === 'videochat3') {
      if (fromSimpleMem.fallback !== 'disabled') {
        log.info('Omni-SimpleMem handed the question on; watching the footage', { reason: fromSimpleMem.fallback });
      }
      // The footage is read the way an internet video is read: VideoChat3
      // watches, Qwen embeds and reranks, VideoChat3 verifies. A miss in
      // memory was never an answer; this is the read that can be one.
      const fromVideoChat3 = await answerFromVideoChat3({
        clipRequestId,
        deckAttemptId,
        requestedResultCount: intent.countExplicit ? intent.requestedCount : null,
        video,
        chunks,
        instruction,
        mode: resolved.mode,
        log,
      });
      const primaryOutcome = {
        simplemem: fromSimpleMem.fallback === 'disabled'
          ? null
          : { fallback: fromSimpleMem.fallback, ...(fromSimpleMem.outcome ?? {}) },
        videochat3: fromVideoChat3.outcome,
      };
      if (fromVideoChat3.answered) {
        await recordRetrievalOutcome(clipRequestId, {
          primary: 'videochat3',
          system: 'videochat3',
          fallbackReason: null,
          primaryOutcome,
        });
        outcome = 'completed';
        searchMode = resolved.mode;
        chunkCount = 0;
        return;
      }
      await recordRetrievalOutcome(clipRequestId, {
        primary: 'videochat3',
        system: null,
        fallbackReason: fromVideoChat3.fallback,
        primaryOutcome,
      });
      log.info('VideoChat3 handed the question on to the direct footage search', { reason: fromVideoChat3.fallback });
    } else if (env.RETRIEVAL_PRIMARY === 'simplemem') {
      await recordRetrievalOutcome(clipRequestId, {
        primary: 'simplemem',
        system: null,
        fallbackReason: fromSimpleMem.fallback,
        primaryOutcome: fromSimpleMem.outcome,
      });
      log.info('Omni-SimpleMem handed the question on', { reason: fromSimpleMem.fallback });
    }

    // One cheap check before uploading megabytes per chunk: a model without
    // video endpoints refuses every chunk identically, and finding that out
    // once is worth more than finding it out N times.
    if (resolved.mode !== 'transcript') await assertVideoInputSupported();

    await startClipRequest(clipRequestId, { chunksTotal: chunks.length, resolvedMode: resolved.mode });
    // So the peak reported at the end belongs to this search.
    resetVideoCallPeak();
    // Reading the footage is the only path that can report a real absence, so
    // it is the only one that runs when the memory could not settle the request.
    // Clear anything from a previous attempt so a retry cannot double-insert,
    // taking its rendered media with it rather than orphaning it.
    await clearPreviousAttempt(clipRequestId, log, deckAttemptId);

    // (the deck plan is declared earlier — see above, before the retrieval path)

    chunkCount = chunks.length;
    searchMode = resolved.mode;

    let completed = 0;
    let totalMatches = 0;
    let answeredWithoutThinking = 0;
    const degradations: ChunkDegradation[] = [];

    await withWorkDir(`search-${clipRequestId}`, async (dir) => {
      const results = await mapWithConcurrency(chunks, env.OPENROUTER_VIDEO_CONCURRENCY, async (chunk) => {
        const found = await searchSingleChunk({
          chunk,
          chunkCount: chunks.length,
          instruction,
          mode: resolved.mode,
          videoId: video.id,
          clipRequestId,
          workDir: dir,
          tally,
          log,
          onAnsweredWithoutThinking: () => {
            answeredWithoutThinking += 1;
          },
          onDegraded: async (degradation) => {
            degradations.push(degradation);
            // Persisted, not just tallied for the log line: the API derives
            // coverage from the row, so a degradation left in memory would
            // report a recovered chunk as clean once the worker moved on —
            // the exact silent coverage loss this work exists to remove.
            await recordChunkDegraded(clipRequestId, degradation);
          },
        });

        if (found.length > 0) await insertMatches(clipRequestId, found);
        await recordChunkCompleted(clipRequestId);

        completed += 1;
        totalMatches += found.length;
        await job.updateProgress({
          stage: 'searching',
          percent: Math.round((100 * completed) / chunks.length),
          chunksCompleted: completed,
          chunksTotal: chunks.length,
          matches: totalMatches,
        });

        return found.length;
      });

      for (const [index, result] of results.entries()) {
        if (result.status !== 'rejected') continue;
        const chunk = chunks[index]!;
        const message = errorMessage(result.reason);
        const code = classifyChunkFailure(result.reason);
        log.warn('chunk search failed', {
          chunkIndex: chunk.chunkIndex,
          covers: `${chunk.globalStartSeconds.toFixed(0)}-${chunk.globalEndSeconds.toFixed(0)}s`,
          code,
          err: result.reason,
        });
        await recordChunkFailure(clipRequestId, {
          chunkIndex: chunk.chunkIndex,
          chunkId: chunk.id,
          message,
          code,
          // Carried so the client can say WHICH seconds went unsearched. Without
          // it "chunk 7 failed" cannot tell a user whether the moment they asked
          // about was inside the gap.
          globalStartSeconds: chunk.globalStartSeconds,
          globalEndSeconds: chunk.globalEndSeconds,
        }, deckAttemptId);
        completed += 1;
        await job.updateProgress({
          stage: 'searching',
          percent: Math.round((100 * completed) / chunks.length),
          chunksCompleted: completed,
          chunksTotal: chunks.length,
          matches: totalMatches,
        });
      }

      const rejections = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
      const failed = rejections.length;

      if (failed === chunks.length) {
        // A bare count is unactionable: "10/10 failed" reads as a bug in the
        // search when it is usually one dependency saying the same thing ten
        // times. Carry the reason so it reaches the user's screen.
        const detail = errorMessage(rejections[0]);
        // Only worth another attempt if something in there could go differently.
        const retryable = rejections.some(
          (reason) => !(reason instanceof ExternalServiceError) || reason.retryable,
        );
        throw new ExternalServiceError(
          'openrouter-video',
          `Every chunk failed to search (${failed}/${chunks.length}): ${detail}`,
          { retryable, cause: rejections[0] },
        );
      }

      // Chunks were searched independently, so the same moment can appear
      // twice — including as two pieces either side of a chunk boundary. Fold
      // duplicates together before the search is reported complete.
      const finalCount = await aggregateStoredMatches(clipRequestId, chunks, deckAttemptId);

      // After aggregation, because merging rewrites match rows and their ids.
      await attachSearchThumbnails({ clipRequestId, video, workDir: dir, log });

      // The moments are the answer. They are released the moment they have
      // their pictures — nothing is cut, framed or encoded until somebody
      // keeps one.
      const released = await completeRequest({
        clipRequestId, answeredFrom: 'footage', deckAttemptId, log,
        requestedResultCount: intent.countExplicit ? intent.requestedCount : null,
        question: instruction,
      });
      if (!released) {
        // Another delivery owns the answer now; this one stands down.
        outcome = 'completed';
        return;
      }
      const elapsedMs = Math.round(performance.now() - searchStartedAt);

      log.info('clip search complete', {
        matches: finalCount,
        mergedFrom: totalMatches,
        failedChunks: failed,
        platform: intent.platform,
        requestedResultCount: intent.countExplicit ? intent.requestedCount : null,
        // Coverage, not just outcome: how much of the video was actually
        // examined, and how much of it with less than the intended evidence.
        chunksSearchedWithoutTranscript: degradations.length,
        // Chunks that returned nothing until thinking was switched off. Zero is
        // the expected value; anything else says the reasoning budget is too
        // tight for this material, and it is the number to raise it from.
        chunksAnsweredWithoutThinking: answeredWithoutThinking,
        elapsedMs,
        reasoningMaxTokens: env.OPENROUTER_VIDEO_REASONING_MAX_TOKENS,
        // The three inputs that set wall-clock, logged alongside it so a slow
        // search can be read without correlating against config elsewhere.
        chunks: chunks.length,
        // Allowed versus achieved. The second is the measurement; the first is
        // only what we asked for, and the two have disagreed before.
        concurrencyAllowed: videoCallStats().limit,
        concurrencyReached: videoCallStats().peak,
        chunkSeconds: env.ANALYSIS_CHUNK_SECONDS,
        model: env.OPENROUTER_VIDEO_MODEL,
      });
    });
    outcome = 'completed';
  } catch (error) {
    const message = errorMessage(error);
    log.error('clip search failed', { err: error });
    // Fenced like every other terminal write: a stalled delivery failing
    // late must not overwrite the outcome of the run that replaced it.
    await finishClipRequest(clipRequestId, 'failed', message, null, deckAttemptId);
    throw error;
  } finally {
    // A failed attempt still paid for whatever it managed to call, and BullMQ
    // retries with a fresh tally — so a cost logged only on success omits every
    // attempt that came before it, and the surviving number reads as the whole
    // cost of the request. Emitted from here so no exit skips it.
    if (tally.calls > 0) {
      // Cost of one search attempt, complete enough to price from on its own:
      // the recurring per-query cost, next to the video length it scales with.
      log.info('clip search cost', {
        outcome,
        // Sum across attempts for what the request truly cost.
        attempt: job.attemptsMade + 1,
        ...tally.summary(),
        usdPerSourceMinute: tally.perSourceMinute(video.durationSeconds),
        videoDurationSeconds: video.durationSeconds,
        chunks: chunkCount,
        mode: searchMode,
        model: env.OPENROUTER_VIDEO_MODEL,
        elapsedMs: Math.round(performance.now() - searchStartedAt),
      });
    }
  }
}

/**
 * Re-reads every match stored for a request, merges the ones describing the
 * same moment, and writes the result back.
 *
 * A merged match keeps the chunk of its earliest contributor, so its local
 * timestamps stay anchored to a real chunk; when a moment spans a boundary the
 * local range extends past that chunk's end, which is the honest description of
 * what was found. Clips are always cut using the global range.
 */
async function aggregateStoredMatches(
  clipRequestId: string,
  chunks: VideoChunk[],
  deckAttemptId: string | null,
): Promise<number> {
  const stored = await listMatches(clipRequestId);
  if (stored.length <= 1) return stored.length;

  const merged = aggregateMatches(
    stored.map((match) => ({
      chunkId: match.chunkId,
      globalStartSeconds: match.globalStartSeconds,
      globalEndSeconds: match.globalEndSeconds,
      description: match.description,
      confidence: match.confidence,
      source: match.source,
      quote: match.quote,
    })),
    {
      gapSeconds: env.MATCH_MERGE_GAP_SECONDS,
      minOverlapRatio: env.MATCH_MERGE_MIN_OVERLAP_RATIO,
      maxDurationSeconds: env.MAX_CLIP_SECONDS,
    },
  );

  if (merged.length === stored.length) return stored.length;

  const chunkById = new Map(chunks.map((chunk) => [chunk.id, chunk]));

  // One search runs on one lane, so every stored match carries the same
  // attribution; merging two of them loses nothing by taking the first's.
  // Rows from before the evaluation layer carry none, and none is re-created.
  const attribution = {
    provider: stored[0]?.provider ?? null,
    model: stored[0]?.model ?? null,
    promptVersion: stored[0]?.promptVersion ?? null,
  };

  const rows: NewClipMatch[] = merged.flatMap((match) => {
    const anchor = chunkById.get(match.chunkId);
    if (!anchor) return [];

    return [
      {
        chunkId: match.chunkId,
        localStartSeconds: Number((match.globalStartSeconds - anchor.globalStartSeconds).toFixed(3)),
        localEndSeconds: Number((match.globalEndSeconds - anchor.globalStartSeconds).toFixed(3)),
        globalStartSeconds: match.globalStartSeconds,
        globalEndSeconds: match.globalEndSeconds,
        description: match.description,
        confidence: match.confidence,
        source: match.source,
        quote: match.quote,
        ...attribution,
      } satisfies NewClipMatch,
    ];
  });

  // Merging rewrites match rows and their ids, so the clips of the old ids
  // are stale. That used to be free — clips came only from the Keep endpoint,
  // which cannot run before the search completes — and is not free now that
  // the search renders its own media.
  // A match whose clip somebody kept survives this, by design — its row is
  // their library entry. On a retry that means a kept moment can end up
  // alongside a freshly merged one covering the same seconds: a duplicate in
  // the deck, which is a great deal better than reaching into someone's
  // library and deleting what they chose.
  await clearPreviousAttempt(clipRequestId, logger.child({ clipRequestId }), deckAttemptId);
  await insertMatches(clipRequestId, rows);

  logger.info('merged overlapping matches', {
    clipRequestId,
    before: stored.length,
    after: rows.length,
  });

  return rows.length;
}

/**
 * Gives every match a still from its own moment.
 *
 * A list of timecodes and sentences asks the reader to picture each one and
 * then select it to find out; a frame answers that directly. Extracted from
 * the low-resolution proxy already in storage rather than the original, and
 * from a single download rather than one per match.
 *
 * Best-effort throughout. The search has already found and stored its results
 * by this point, and a missing picture must never cost a real match — every
 * failure here is logged and swallowed.
 */
/**
 * Gives every match of this search a still. Runs after aggregation, because
 * merging rewrites match rows and their ids — anything extracted earlier would
 * be attached to rows that no longer exist.
 */
/**
 * Clear a previous attempt's matches, reclaiming any media they hold first.
 *
 * clips.clip_match_id is ON DELETE CASCADE, so deleting matches deletes the
 * clip rows under them — and every collector in this system finds objects by
 * reading keys off a clip row. Dropping the rows first would leave the files
 * with nothing pointing at them: not the unkept-media sweep, not the
 * video-level footage expiry, nothing but a listing of the whole bucket.
 *
 * This was safe while clips came only from the Keep endpoint, which cannot
 * run before a search completes. It stopped being safe when the search itself
 * started rendering: a retried job re-runs from the top, and the deck the
 * previous attempt finished would become nine unreferenced objects.
 *
 * Best-effort on the deletes and loud when they fail, for the same reason the
 * pipeline's own cleanup is: an orphan nobody names is an orphan forever.
 */
async function clearPreviousAttempt(
  clipRequestId: string,
  log: Logger,
  /** Fenced: a superseded run must not clear the work of the run that replaced it. */
  attemptId: string | null,
): Promise<void> {
  // Clears the matches and returns the files they held, in one statement, and
  // never touches a moment the creator kept — see clearUnkeptMatchesForRequest
  // for why all three of those have to be true together.
  //
  // If it throws, nothing is deleted and the job retries. That is the
  // recoverable outcome: proceeding blind would cascade away clip rows whose
  // files we never learned the names of, and an orphan is forever.
  const keys = await clearUnkeptMatchesForRequest(clipRequestId, attemptId);
  if (keys.length === 0) return;

  const storage = getStorage();
  let deleted = 0;
  for (const storageKey of keys) {
    try {
      await storage.remove(storageKey);
      deleted += 1;
    } catch (error) {
      // Logged rather than thrown: the rows are already gone, so refusing
      // here would wedge every future retry of this request and change
      // nothing. The key is named because that log line is now the only
      // thing that can ever find this object again.
      log.error('a previous attempt\'s file could not be deleted and is now an orphan', {
        clipRequestId, storageKey, err: error,
      });
    }
  }

  log.info('reclaimed media from a previous attempt', {
    clipRequestId, objects: keys.length, deleted,
  });
}

/**
 * Finish a request the same way whichever path answered it.
 *
 * Retrieval and actual-footage paths can both reach completion. Both owe
 * the creator the same thing: verified moments, with their pictures,
 * as soon as they exist. Exported for focused tests of the boundary.
 *
 * Nothing is rendered here. That is the change this function carries, and it
 * is worth stating plainly because the previous version of it did the
 * opposite: every moment a search found was cut, framed and encoded — one
 * after another, a model call and an encode each — before a single one was
 * shown. In the session that prompted this, four moments were found in
 * fifteen seconds and shown after four and a half minutes, and three of the
 * four were then thrown away. A moment is evidence: a stretch of the source
 * video, a description and a still. It is shown from the source it was found
 * in, and its file is made when a person keeps it (the /generate route and
 * handleClipGeneration).
 *
 * What is recorded is what was found: `available_candidate_count` and
 * `effective_deck_target` both carry the count of moments released, and
 * `deck_completed_at` — kept under its old name so no migration is needed —
 * now marks the instant the answer was released. The fence is unchanged: a
 * superseded delivery finds the token changed and releases nothing.
 */
export async function completeRequest(input: {
  clipRequestId: string;
  answeredFrom: AnsweredFrom;
  /**
   * Which system answered, when the kind of evidence does not say. A
   * VideoChat3 answer is from the footage, like the per-chunk search's; the
   * row still records which of the two read it.
   */
  retrievalSystem?: RetrievalSystem;
  /** The token from recordDeckPlan — the release is fenced to it. */
  deckAttemptId: string | null;
  /** A number the person wrote, or null: the only cap there is. */
  requestedResultCount: number | null;
  /** The effective question, which differs from the stored words for a correction. */
  question?: string;
  /** A retrieval-specific limitation that cannot be inferred from chunk failures. */
  coverageNote?: string | null;
  /** Persisted failures already described by coverageNote; prevents reporting the same gap twice. */
  coverageFailuresDescribed?: number;
  log: Logger;
}): Promise<boolean> {
  const { clipRequestId, log } = input;

  // What the search found, and how many will be shown. No product cap: the
  // answer is what the evidence supports (owner, 2026-09-05), and finding
  // none is a finished answer too, never padded and never hidden. A number
  // the person WROTE is the one limit — "give me 3" shows the best three of
  // whatever qualified (visibleMatches), and three asked for with two found
  // is two. A moment longer than a platform would take is still a moment:
  // whether it exists and whether it already suits TikTok are different
  // questions, and discovery answers only the first.
  const found = await listMatches(clipRequestId);
  if (!input.deckAttemptId) {
    log.warn('answer has no active attempt; refusing to spend an unfenced model call', { clipRequestId });
    return false;
  }
  const request = await getClipRequest(clipRequestId);
  if (!request) throw new Error('Clip request disappeared before its answer could be written');
  const shownCount = input.requestedResultCount !== null && input.requestedResultCount > 0
    ? Math.min(found.length, input.requestedResultCount)
    : found.length;
  // Use the exact same confidence selection as the API. listMatches is in
  // timeline order, so slicing it here used to let the answer cite early
  // cards while the UI displayed the strongest cards instead.
  const shownIds = new Set([...found]
    .sort((a, b) => b.confidence - a.confidence || a.id.localeCompare(b.id))
    .slice(0, shownCount)
    .map((match) => match.id));
  const shown = found.filter((match) => shownIds.has(match.id));
  const evidence = shown.map((match) => ({
      id: match.id,
      startSeconds: match.globalStartSeconds,
      endSeconds: match.globalEndSeconds,
      description: match.description,
      quote: match.quote,
      source: match.source,
    }));
  const undescribedFailures = Math.max(0, request.chunksFailed - (input.coverageFailuresDescribed ?? 0));
  const chunkCoverageNote = undescribedFailures > 0
    ? `${undescribedFailures} section(s) of the video could not be examined.`
    : null;
  // Retrieval systems can leave different holes in the same answer. Never
  // let one warning win merely because it was discovered first.
  const coverageNote = [input.coverageNote, chunkCoverageNote].filter(Boolean).join(' ') || null;
  let answer;
  try {
    answer = await writeConversationalAnswer({
      question: input.question ?? request.instruction,
      evidence,
      coverageNote,
      onUsage: (usage) => {
        void recordModelUsage({ ...usage, stage: 'answer', videoId: request.videoId, clipRequestId });
      },
    });
  } catch (error) {
    // Answer prose is an enhancement, not the owner of retrieval. Preserve
    // the already-found, thumbnailed evidence when that final model is down.
    log.warn('answer model failed; releasing the grounded moments without generated prose', { clipRequestId, err: error });
    answer = {
      text: `${shown.length === 0 ? 'No verified moments were found.' : `Found ${shown.length} verified moment${shown.length === 1 ? '' : 's'}.`}${coverageNote ? ` ${coverageNote}` : ''}`,
      citationIds: shown.map((match) => match.id),
      provider: 'clipit',
      model: 'deterministic-fallback',
      promptVersion: 'answer-fallback-v1',
    };
  }
  const answerStored = await recordConversationalAnswer(clipRequestId, input.deckAttemptId, answer);
  if (!answerStored) {
    log.warn('answer was superseded while Qwen Flash was writing it', { clipRequestId });
    return false;
  }
  await recordDeckAvailability(clipRequestId, {
    availableCandidateCount: found.length,
    effectiveDeckTarget: shown.length,
  }, input.deckAttemptId);

  // Released and completed together, in one statement, so there is no
  // instant in which the moments are on the creator's screen while the
  // request still says 'searching' and a stale delivery could claim it.
  // Which system answered goes in with the release itself: one fenced
  // statement, so it cannot name an answer that was superseded and cannot be
  // lost if this process stops. SimpleMem is the memory path; direct footage
  // search is Clipit's grounding fallback.
  const released = input.deckAttemptId
    ? await releaseDeckAndComplete(
        clipRequestId,
        input.deckAttemptId,
        input.answeredFrom,
        input.retrievalSystem ?? (input.answeredFrom === 'simplemem' ? 'simplemem' : 'clipit'),
      )
    : false;
  if (!released) {
    log.warn('answer was superseded before it could be released', {
      clipRequestId, answeredFrom: input.answeredFrom,
    });
    return false;
  }


  log.info('moments released', {
    clipRequestId,
    answeredFrom: input.answeredFrom,
    found: found.length,
    shown: shown.length,
  });
  return true;
}

async function attachSearchThumbnails(input: {
  clipRequestId: string;
  video: Video;
  workDir: string;
  log: Logger;
}): Promise<void> {
  const { clipRequestId, video, workDir, log } = input;
  if (!video.proxyStorageKey) return;

  // The request row already says how its moments will be delivered; the
  // thumbnail is cut to the same shape so the card never shows a frame the
  // export will not keep.
  const request = await getClipRequest(clipRequestId);
  const matches = await listMatches(clipRequestId);
  await attachThumbnails({
    videoId: video.id,
    proxyStorageKey: video.proxyStorageKey,
    playbackStorageKey: video.playbackStorageKey ?? null,
    // Vertical whatever the stored row says. A request from before the
        // always-vertical rule carries 'source', and re-cutting from it would
        // hand back the landscape clip the rule exists to stop.
        presentation: verticalForRework(),
    matches,
    workDir,
    log,
  });
}

interface SearchSingleChunkInput {
  chunk: VideoChunk;
  chunkCount: number;
  instruction: string;
  mode: ResolvedSearchMode;
  videoId: string;
  clipRequestId: string;
  workDir: string;
  tally: UsageTally;
  /** Records that a chunk was searched with less evidence than intended. */
  onDegraded: (degradation: ChunkDegradation) => Promise<void>;
  /**
   * Records that a chunk answered only after thinking was switched off. Not a
   * coverage degradation — the model still saw the whole chunk and its
   * transcript — but the signal that the thinking budget is too tight, which
   * is only readable if it is counted per search rather than per chunk.
   */
  onAnsweredWithoutThinking: () => void;
  /**
   * The request-scoped logger, not the root one. Searches run concurrently
   * (`CLIP_SEARCH_CONCURRENCY`), so two of them emit chunk 0 of the same
   * source window at the same time; without the request on every line, a
   * diagnostic cannot be attributed to the search being diagnosed.
   */
  log: Logger;
}

const MATCH_SOURCE: Record<ResolvedSearchMode, MatchSource> = {
  visual: 'visual',
  transcript: 'transcript',
  both: 'multimodal',
};

/** Ask Omni-SimpleMem first when configured, falling through on every miss. */
async function answerFromSimpleMem(input: {
  clipRequestId: string;
  deckAttemptId: string | null;
  requestedResultCount: number | null;
  video: Video;
  chunks: VideoChunk[];
  instruction: string;
  mode: ResolvedSearchMode;
  correcting: boolean;
  log: Logger;
}): Promise<{
  matchCount: number;
  released: boolean;
  fallback: FallbackReason | null;
  outcome: Record<string, unknown> | null;
}> {
  // Memory is consulted when it is the primary, and when VideoChat3 is the
  // primary but a memory is being built for every upload: a hit there is
  // verified against the footage and saves a full watch; a miss is not an
  // answer, and the footage is watched.
  const consultMemory = env.RETRIEVAL_PRIMARY === 'simplemem'
    || (env.RETRIEVAL_PRIMARY === 'videochat3' && env.SIMPLEMEM_INDEX_ENABLED);
  if (!consultMemory) {
    return { matchCount: 0, released: false, fallback: 'disabled', outcome: null };
  }
  const index = await getSimpleMemIndex(input.video.id);
  const indexState = index?.status ?? 'missing';
  const before = decideFallback({ indexState, mode: input.mode, correcting: input.correcting });
  if (before.use === 'fallback') {
    return { matchCount: 0, released: false, fallback: before.reason, outcome: null };
  }
  await startClipRequest(input.clipRequestId, { chunksTotal: 0, resolvedMode: input.mode });
  let reply;
  try {
    reply = await simplememQuery({ videoId: input.video.id, query: input.instruction, topK: env.SIMPLEMEM_TOP_K });
  } catch (error) {
    const detail = errorMessage(error);
    input.log.warn('Omni-SimpleMem query failed; using Clipit retrieval', { err: error });
    return { matchCount: 0, released: false, fallback: 'primary_failed', outcome: { error: detail } };
  }
  const mapping = mapCandidates(reply.items, {
    fps: index?.fps ?? env.SIMPLEMEM_FRAME_FPS,
    groupGapSeconds: env.SIMPLEMEM_GROUP_GAP_SECONDS,
    minScore: env.SIMPLEMEM_MIN_SCORE,
    durationSeconds: input.video.durationSeconds,
  });
  const baseOutcome = {
    retrievedCandidates: mapping.candidates.length,
    totalCandidates: reply.totalCandidates,
    ignored: mapping.ignored,
    elapsedMs: reply.elapsedMs,
    coveredThroughSeconds: index?.coveredThroughSeconds ?? null,
  };
  const decision = decideFallback({ indexState, mode: input.mode, correcting: input.correcting, mapping });
  if (decision.use === 'fallback') {
    return { matchCount: 0, released: false, fallback: decision.reason, outcome: baseOutcome };
  }

  if (!input.video.proxyStorageKey) {
    return {
      matchCount: 0,
      released: false,
      fallback: 'primary_failed',
      outcome: { ...baseOutcome, rerankError: 'Video has no analysis proxy to verify' },
    };
  }

  let verified;
  try {
    const object = await getStorage().head(input.video.proxyStorageKey);
    const videoUrl = await getStorage().createDownloadUrl(input.video.proxyStorageKey, {
      expiresInSeconds: Math.max(60, Math.ceil(env.OPENROUTER_REQUEST_TIMEOUT_MS / 1000) + 60),
    });
    verified = await rerankSimpleMemCandidates({
      query: input.instruction,
      candidates: mapping.candidates,
      videoUrl,
      videoKey: input.video.proxyStorageKey,
      expectedBytes: object?.sizeBytes ?? input.video.sizeBytes ?? 0,
      onUsage: (usage) => {
        void recordModelUsage({
          ...usage,
          stage: 'search',
          videoId: input.video.id,
          clipRequestId: input.clipRequestId,
        });
      },
    });
  } catch (error) {
    const detail = errorMessage(error);
    input.log.warn('Omni-SimpleMem candidates could not be verified against the actual footage; using fallback retrieval', { err: error });
    return {
      matchCount: 0,
      released: false,
      fallback: 'primary_failed',
      outcome: { ...baseOutcome, verificationError: detail },
    };
  }

  const outcome = {
    ...baseOutcome,
    verifiedCandidates: verified.candidates.length,
    verificationFailures: verified.failed.length,
    verificationModel: verified.result.model,
    verificationRevision: verified.result.revision,
    verificationMetrics: verified.result.metrics,
  };
  if (verified.candidates.length === 0) {
    return { matchCount: 0, released: false, fallback: 'no_candidates', outcome };
  }
  await clearPreviousAttempt(input.clipRequestId, input.log, input.deckAttemptId);
  const unreadTail = input.video.durationSeconds !== null
      && index?.coveredThroughSeconds !== null
      && index?.coveredThroughSeconds !== undefined
      && index.coveredThroughSeconds + 0.001 < input.video.durationSeconds
    ? { startSeconds: Math.max(0, index.coveredThroughSeconds), endSeconds: input.video.durationSeconds }
    : null;
  if (unreadTail) {
    const chunk = input.chunks.find((item) =>
      unreadTail.startSeconds >= item.globalStartSeconds && unreadTail.startSeconds < item.globalEndSeconds,
    ) ?? input.chunks.at(-1);
    if (chunk) {
      const stillOwned = await recordChunkFailure(input.clipRequestId, {
        chunkIndex: chunk.chunkIndex,
        chunkId: chunk.id,
        message: 'Omni-SimpleMem indexing stopped before the end of the video.',
        code: 'not_read_yet',
        globalStartSeconds: unreadTail.startSeconds,
        globalEndSeconds: unreadTail.endSeconds,
      }, input.deckAttemptId!);
      if (!stillOwned) {
        input.log.info('another delivery owns this request; discarding stale SimpleMem coverage');
        return { matchCount: verified.candidates.length, released: false, fallback: null, outcome };
      }
    }
  }
  for (const failure of verified.failed) {
    const chunk = input.chunks.find((item) =>
      failure.startSeconds >= item.globalStartSeconds && failure.startSeconds < item.globalEndSeconds,
    ) ?? input.chunks.at(-1);
    if (!chunk) continue;
    const stillOwned = await recordChunkFailure(input.clipRequestId, {
      chunkIndex: chunk.chunkIndex,
      chunkId: chunk.id,
      message: `Omni-SimpleMem found this candidate, but the actual footage watcher could not verify it: ${failure.reason}`,
      code: 'not_read_yet',
      globalStartSeconds: failure.startSeconds,
      globalEndSeconds: failure.endSeconds,
    }, input.deckAttemptId!);
    if (!stillOwned) {
      input.log.info('another delivery owns this request; discarding stale SimpleMem coverage');
      return { matchCount: verified.candidates.length, released: false, fallback: null, outcome };
    }
  }
  // Frames whose caption never arrived are remembered by what they look
  // like only. Each such stretch is recorded as unexamined, so an answer
  // from memory never implies those seconds were read in full.
  const undescribed = uncaptionedRanges(index?.config, {
    fps: index?.fps ?? env.SIMPLEMEM_FRAME_FPS,
    durationSeconds: input.video.durationSeconds,
  });
  for (const range of undescribed) {
    const chunk = input.chunks.find((item) =>
      range.startSeconds >= item.globalStartSeconds && range.startSeconds < item.globalEndSeconds,
    ) ?? input.chunks.at(-1);
    if (!chunk) continue;
    const stillOwned = await recordChunkFailure(input.clipRequestId, {
      chunkIndex: chunk.chunkIndex,
      chunkId: chunk.id,
      message: `Omni-SimpleMem remembered this stretch (${range.frames} frame${range.frames === 1 ? '' : 's'}) without a description: the caption model returned no text, so it could only be found by what it looks like.`,
      code: 'not_read_yet',
      globalStartSeconds: range.startSeconds,
      globalEndSeconds: range.endSeconds,
    }, input.deckAttemptId!);
    if (!stillOwned) {
      input.log.info('another delivery owns this request; discarding stale SimpleMem coverage');
      return { matchCount: verified.candidates.length, released: false, fallback: null, outcome };
    }
  }
  const wanted = input.requestedResultCount ?? verified.candidates.length;
  const found = placeMomentsOnChunks(
    verified.candidates.slice(0, wanted).map((candidate) => ({
      startSeconds: candidate.startSeconds,
      endSeconds: candidate.endSeconds,
      confidence: candidate.score,
      description: candidate.description,
    })),
    input.chunks,
    {
      instruction: input.instruction,
      provider: 'omni-simplemem',
      model: typeof index?.config?.visual === 'string' ? index.config.visual : 'Omni-SimpleMem',
    },
  );
  if (found.length === 0) return { matchCount: 0, released: false, fallback: 'no_candidates', outcome };
  await insertMatches(input.clipRequestId, found);
  const finalCount = await aggregateStoredMatches(input.clipRequestId, input.chunks, input.deckAttemptId);
  await withWorkDir(`simplemem-${input.clipRequestId}`, async (dir) => {
    await attachSearchThumbnails({ clipRequestId: input.clipRequestId, video: input.video, workDir: dir, log: input.log });
  });
  const released = await completeRequest({
    clipRequestId: input.clipRequestId,
    answeredFrom: 'simplemem',
    deckAttemptId: input.deckAttemptId,
    requestedResultCount: input.requestedResultCount,
    question: input.instruction,
    coverageNote: [
      unreadTail
        ? `Omni-SimpleMem only examined the first ${Math.round(unreadTail.startSeconds)} of ${Math.round(unreadTail.endSeconds)} seconds.`
        : null,
      undescribed.length > 0
        ? `${undescribed.length} stretch${undescribed.length === 1 ? '' : 'es'} of the video ${undescribed.length === 1 ? 'was' : 'were'} remembered without a description and could only be matched by appearance.`
        : null,
    ].filter(Boolean).join(' ') || null,
    // The unread tail and the undescribed stretches are persisted above for
    // the structured API and have their precise prose notes here; reranker
    // failures remain undescribed and therefore retain their warning.
    coverageFailuresDescribed: (unreadTail ? 1 : 0) + undescribed.length,
    log: input.log,
  });
  input.log.info('answered from Omni-SimpleMem', { matches: finalCount, released, undescribedStretches: undescribed.length, ...outcome });
  return { matchCount: finalCount, released, fallback: null, outcome };
}


/**
 * How long the footage's signed URL stays valid for the VideoChat3 pipeline.
 *
 * Every stage downloads the proxy again — watch, embed, rerank and verify are
 * separate Modal calls — and a long watch runs up to its 1800 s function
 * timeout before the rest begin. A URL scoped to one call's timeout would
 * expire under the later stages, which would then fail as a download error.
 */
const VIDEOCHAT3_SOURCE_URL_SECONDS = 2 * 60 * 60;

/**
 * Read the footage the way an internet video is read.
 *
 * VideoChat3 watches the analysis proxy for the question, Qwen embeddings and
 * the Qwen reranker order what it flagged, and VideoChat3 re-opens each
 * candidate before it becomes evidence. The whole video is read at one frame
 * a second, so "nothing verified" is a finding about the footage rather than a
 * memory's silence, and it completes the request. Two things hand on to the
 * direct per-chunk search instead: a question about speech, which this
 * watcher cannot hear, and the pipeline itself failing.
 */
async function answerFromVideoChat3(input: {
  clipRequestId: string;
  deckAttemptId: string | null;
  requestedResultCount: number | null;
  video: Video;
  chunks: VideoChunk[];
  instruction: string;
  mode: ResolvedSearchMode;
  log: Logger;
}): Promise<{
  /** True when this path finished the request — with moments, or with an honest none. */
  answered: boolean;
  matchCount: number;
  fallback: FallbackReason | null;
  outcome: Record<string, unknown> | null;
}> {
  if (input.mode === 'transcript') {
    return {
      answered: false,
      matchCount: 0,
      fallback: 'unsupported_mode',
      outcome: { detail: 'the question is about speech, and VideoChat3 watches without sound' },
    };
  }
  if (!input.video.proxyStorageKey) {
    return {
      answered: false,
      matchCount: 0,
      fallback: 'primary_failed',
      outcome: { error: 'Video has no analysis proxy to watch' },
    };
  }

  await startClipRequest(input.clipRequestId, { chunksTotal: 0, resolvedMode: input.mode });
  let analysis: UploadedVideoAnalysis;
  try {
    const object = await getStorage().head(input.video.proxyStorageKey);
    const videoUrl = await getStorage().createDownloadUrl(input.video.proxyStorageKey, {
      expiresInSeconds: VIDEOCHAT3_SOURCE_URL_SECONDS,
    });
    analysis = await analyzeUploadedVideo({
      query: input.instruction,
      videoUrl,
      videoKey: input.video.proxyStorageKey,
      expectedBytes: object?.sizeBytes ?? input.video.sizeBytes ?? undefined,
      durationSeconds: input.video.durationSeconds,
    });
  } catch (error) {
    const detail = errorMessage(error);
    input.log.warn('the VideoChat3 pipeline could not read the footage; using the direct footage search', { err: error });
    return { answered: false, matchCount: 0, fallback: 'primary_failed', outcome: { error: detail } };
  }

  const outcome = {
    watchedEvents: analysis.watchedEvents,
    watchedThroughSeconds: analysis.watchedThroughSeconds,
    unwatched: analysis.unwatched,
    verifiedMoments: analysis.verified.length,
    failures: analysis.failures.length,
    model: analysis.model,
    revision: analysis.revision,
    metrics: analysis.metrics,
  };

  // A retry must not keep a previous attempt's moments beside this one's.
  await clearPreviousAttempt(input.clipRequestId, input.log, input.deckAttemptId);

  // Coverage is written before the answer, so the record never says "nothing
  // there" about seconds the watcher did not reach or could not verify.
  const chunkAt = (seconds: number) =>
    input.chunks.find((item) => seconds >= item.globalStartSeconds && seconds < item.globalEndSeconds)
      ?? input.chunks.at(-1);
  const gaps: Array<{ startSeconds: number; endSeconds: number; message: string }> = [];
  if (analysis.unwatched) {
    gaps.push({
      ...analysis.unwatched,
      message: `VideoChat3 stopped watching at ${Math.round(analysis.unwatched.startSeconds)}s: it had flagged ${WATCH_MAX_EVENTS} moments, the most one read may hold.`,
    });
  }
  for (const failure of analysis.failures) {
    if (failure.startSeconds === undefined || failure.endSeconds === undefined) continue;
    gaps.push({
      startSeconds: failure.startSeconds,
      endSeconds: failure.endSeconds,
      message: `VideoChat3 flagged this stretch, but it could not be verified: ${failure.reason}`,
    });
  }
  for (const gap of gaps) {
    const chunk = chunkAt(gap.startSeconds);
    if (!chunk) continue;
    const stillOwned = await recordChunkFailure(input.clipRequestId, {
      chunkIndex: chunk.chunkIndex,
      chunkId: chunk.id,
      message: gap.message,
      code: 'not_read_yet',
      globalStartSeconds: gap.startSeconds,
      globalEndSeconds: gap.endSeconds,
    }, input.deckAttemptId!);
    if (!stillOwned) {
      input.log.info('another delivery owns this request; discarding stale VideoChat3 coverage');
      return { answered: true, matchCount: 0, fallback: null, outcome };
    }
  }

  const wanted = input.requestedResultCount ?? analysis.verified.length;
  const found = placeMomentsOnChunks(analysis.verified.slice(0, wanted), input.chunks, {
    instruction: input.instruction,
    provider: 'modal',
    model: analysis.model,
  });
  let finalCount = 0;
  if (found.length > 0) {
    await insertMatches(input.clipRequestId, found);
    finalCount = await aggregateStoredMatches(input.clipRequestId, input.chunks, input.deckAttemptId);
    await withWorkDir(`videochat3-${input.clipRequestId}`, async (dir) => {
      await attachSearchThumbnails({ clipRequestId: input.clipRequestId, video: input.video, workDir: dir, log: input.log });
    });
  }
  const durationSeconds = input.video.durationSeconds ?? analysis.durationSeconds;
  const released = await completeRequest({
    clipRequestId: input.clipRequestId,
    answeredFrom: 'footage',
    retrievalSystem: 'videochat3',
    deckAttemptId: input.deckAttemptId,
    requestedResultCount: input.requestedResultCount,
    question: input.instruction,
    coverageNote: analysis.unwatched
      ? `VideoChat3 only watched the first ${Math.round(analysis.unwatched.startSeconds)} of ${Math.round(durationSeconds)} seconds.`
      : null,
    // The unwatched tail is persisted above for the structured API and has
    // its precise prose note here; verification failures keep their warning.
    coverageFailuresDescribed: analysis.unwatched ? 1 : 0,
    log: input.log,
  });
  input.log.info('answered from VideoChat3', { matches: finalCount, released, ...outcome });
  return { answered: true, matchCount: finalCount, fallback: null, outcome };
}


async function searchSingleChunk(input: SearchSingleChunkInput): Promise<NewClipMatch[]> {
  const { chunk } = input;
  const chunkDir = path.join(input.workDir, `chunk-${chunk.chunkIndex}`);

  // Visual evidence is the actual MP4 chunk, not sampled-frame summaries.
  let chunkPath: string | undefined;
  let downloadMs = 0;
  if (input.mode !== 'transcript') {
    chunkPath = path.join(chunkDir, 'chunk.mp4');
    // Timed because it was the leading suspect for a four-minute search and
    // could not be ruled out from the logs — every other stage was measured.
    const startedAt = performance.now();
    await getStorage().downloadToFile(chunk.storageKey, chunkPath);
    downloadMs = Math.round(performance.now() - startedAt);
  }

  // Evidence 2: the slice of the (already global) transcript covering this chunk,
  // rebased to chunk-local time so the model reports local timestamps.
  let transcript: TranscriptLine[] = [];
  if (input.mode !== 'visual') {
    const segments = await listTranscriptSegmentsInRange(
      input.videoId,
      chunk.globalStartSeconds,
      chunk.globalEndSeconds,
    );
    transcript = segments.map((segment) => ({
      localStartSeconds: Math.max(0, segment.startSeconds - chunk.globalStartSeconds),
      localEndSeconds: Math.min(chunk.durationSeconds, segment.endSeconds - chunk.globalStartSeconds),
      text: segment.text,
    }));
  }

  const call = (withTranscript: boolean) =>
    searchVideoChunk({
      instruction: input.instruction,
      // Dropping the transcript makes this a visual search of the same chunk.
      mode: withTranscript ? input.mode : 'visual',
      chunkIndex: chunk.chunkIndex,
      chunkCount: input.chunkCount,
      chunkDurationSeconds: chunk.durationSeconds,
      videoPath: chunkPath,
      videoStorageKey: chunk.storageKey,
      transcript: withTranscript ? transcript : [],
      onUsage: (usage) => {
        // Both attempts are billed, so both are tallied. A retry that recovers
        // a chunk is cheaper than losing it, but it is not free.
        input.tally.add(usage);
        void recordModelUsage({
          ...usage,
          stage: 'search',
          videoId: input.videoId,
          clipRequestId: input.clipRequestId,
        });
      },
    });

  let response: Awaited<ReturnType<typeof searchVideoChunk>>;
  let degraded = false;
  try {
    response = await call(true);
  } catch (error) {
    // The provider objected to the TEXT, so the video is still searchable.
    // Retrying without the transcript recovers the window rather than losing
    // it — with weaker evidence, which the caller records rather than hides.
    if (!chunkPath || transcript.length === 0 || !isContentFilterRejection(error)) throw error;

    input.log.warn('retrying chunk without its transcript after a content-filter rejection', {
      chunkIndex: chunk.chunkIndex,
      covers: `${chunk.globalStartSeconds.toFixed(0)}-${chunk.globalEndSeconds.toFixed(0)}s`,
      transcriptLines: transcript.length,
    });
    response = await call(false);
    degraded = true;
    await input.onDegraded({
      chunkIndex: chunk.chunkIndex,
      globalStartSeconds: chunk.globalStartSeconds,
      globalEndSeconds: chunk.globalEndSeconds,
      reason: 'transcript_omitted',
    });
  }

  // The chunk was recovered by the client asking again without thinking. It
  // was searched with everything it should have been; only the deliberation
  // was cut, so this is counted rather than reported as a coverage gap.
  if (response.reasoningDisabled) input.onAnsweredWithoutThinking();

  if (response.warnings.length > 0) {
    input.log.warn('model output warnings', {
      chunkIndex: chunk.chunkIndex,
      warnings: response.warnings.slice(0, 5),
    });
  }

  // A match the model DID report, thrown away by our own threshold, reads
  // downstream as "the video does not contain that" — the one failure the user
  // cannot tell apart from a real absence. Say so explicitly, with the
  // confidence that was too low, so a threshold problem is never mistaken for
  // a model problem.
  const belowConfidence = response.matches.filter((match) => match.confidence < env.MIN_MATCH_CONFIDENCE);
  if (belowConfidence.length > 0) {
    // Recorded, not just logged. The log told US; the user was told nothing
    // matched, which is indistinguishable from their video not containing it.
    await recordUncertainMatches(
      input.clipRequestId,
      belowConfidence.flatMap((match) => {
        const range = mapLocalRangeToGlobal(
          chunk,
          { startSeconds: match.startSeconds, endSeconds: match.endSeconds },
          { minDurationSeconds: env.MIN_CLIP_SECONDS, maxDurationSeconds: env.MAX_CLIP_SECONDS },
        );
        if (!range) return [];
        return [{
          globalStartSeconds: range.globalStartSeconds,
          globalEndSeconds: range.globalEndSeconds,
          confidence: match.confidence,
          description: match.description,
        }];
      }),
    );

    input.log.warn('discarded low-confidence matches', {
      chunkIndex: chunk.chunkIndex,
      threshold: env.MIN_MATCH_CONFIDENCE,
      dropped: belowConfidence.slice(0, 5).map((match) => ({
        globalStart: Number((chunk.globalStartSeconds + match.startSeconds).toFixed(1)),
        globalEnd: Number((chunk.globalStartSeconds + match.endSeconds).toFixed(1)),
        confidence: match.confidence,
        description: match.description,
      })),
    });
  }

  // Validate, then map chunk-local timestamps onto the source timeline.
  const mapped = response.matches
    .filter((match) => match.confidence >= env.MIN_MATCH_CONFIDENCE)
    .flatMap((match) => {
      const range = mapLocalRangeToGlobal(
        chunk,
        { startSeconds: match.startSeconds, endSeconds: match.endSeconds },
        { minDurationSeconds: env.MIN_CLIP_SECONDS, maxDurationSeconds: env.MAX_CLIP_SECONDS },
      );
      if (!range) {
        input.log.warn('discarding out-of-range match', {
          chunkIndex: chunk.chunkIndex,
          start: match.startSeconds,
          end: match.endSeconds,
          chunkDuration: chunk.durationSeconds,
        });
        return [];
      }
      return [
        {
          startSeconds: range.globalStartSeconds,
          endSeconds: range.globalEndSeconds,
          confidence: match.confidence,
          description: match.description,
          quote: match.quote,
        },
      ];
    });

  // A model often reports the same moment twice within one chunk.
  const deduped = mergeOverlappingRanges(mapped);

  // One line per chunk, carrying the source window it covers so a specific
  // moment can be looked up directly. "Nothing found" is the answer that needs
  // explaining, so the model's own words are attached only in that case —
  // otherwise an empty result is indistinguishable from a broken one.
  input.log.info('chunk searched', {
    chunkIndex: chunk.chunkIndex,
    covers: `${chunk.globalStartSeconds.toFixed(0)}-${chunk.globalEndSeconds.toFixed(0)}s`,
    reported: response.matches.length,
    belowConfidence: belowConfidence.length,
    kept: deduped.length,
    // Present only when the first attempt answered nothing and the chunk was
    // recovered by asking again without thinking. Worth a per-chunk record:
    // if this starts appearing often, the thinking budget is too tight.
    ...(response.reasoningDisabled ? { recoveredWithoutThinking: true } : {}),
    // Completes the per-chunk time budget: fetching the evidence, versus the
    // model working on it. Together with headersMs/bodyMs nothing is untimed.
    downloadMs,
    ...(response.matches.length === 0
      ? { rawResponse: response.rawResponse.slice(0, 500) }
      : {}),
  });

  return deduped.flatMap((range) => {
    const local = mapGlobalRangeToChunk(
      chunk,
      { startSeconds: range.startSeconds, endSeconds: range.endSeconds },
      { minDurationSeconds: env.MIN_CLIP_SECONDS, maxDurationSeconds: env.MAX_CLIP_SECONDS },
    );
    if (!local) return [];

    return [
      {
        chunkId: chunk.id,
        localStartSeconds: local.localStartSeconds,
        localEndSeconds: local.localEndSeconds,
        globalStartSeconds: local.globalStartSeconds,
        globalEndSeconds: local.globalEndSeconds,
        description: range.description,
        confidence: range.confidence ?? 0,
        // The retry that recovered this chunk saw no transcript, so labelling
        // its matches "multimodal" would claim evidence the model never had.
        source: MATCH_SOURCE[degraded ? 'visual' : input.mode],
        quote: range.quote,
        // Whichever service actually watched this chunk — the answer says,
        // rather than the configuration being trusted to describe it.
        provider: response.provider,
        model: response.model,
        promptVersion: response.promptVersion || null,
      } satisfies NewClipMatch,
    ];
  });
}
