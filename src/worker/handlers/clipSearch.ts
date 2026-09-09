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
import { searchNotes } from '../../services/search/noteSearch.js';
import { isCorrection } from '../../services/search/rescanPolicy.js';
import { assertVideoInputSupported } from '../../services/search/modelCapabilities.js';
import { resolveSearchMode } from '../../services/search/instructionMode.js';
import { aggregateMatches } from '../../services/search/aggregateMatches.js';
import type { NoteLine, TranscriptLine } from '../../services/search/prompt.js';
import {
  findUncoveredRanges,
  mapGlobalRangeToChunk,
  mapLocalRangeToGlobal,
  mergeOverlappingRanges,
} from '../../services/timestamps.js';
import { getVideo, listChunks } from '../../db/repositories/videos.js';
import { listTranscriptSegments, listTranscriptSegmentsInRange } from '../../db/repositories/transcripts.js';
import { listScenes, sceneProgress } from '../../db/repositories/scenes.js';
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
  recordSearchApproach,
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
import { getMediaIndexStatus, listIndexedWindows } from '../../db/repositories/mediaIndex.js';
import {
  decideIndexAnswer,
  footageWasReplaced,
  IndexProvenanceChanged,
  searchMediaIndex,
  type IndexFallbackReason,
  type IndexSearchCall,
} from '../../services/mediaIndex/search.js';
import { sourceIdentity } from '../../services/mediaIndex/sourceIdentity.js';
import { unreadRanges } from '../../services/mediaIndex/coverage.js';
import { planWindows, windowKey } from '../../services/mediaIndex/windows.js';
import { estimateGpuCostUsd, gpuMsFrom } from '../../services/mediaIndex/cost.js';
import { writeConversationalAnswer } from '../../services/search/conversationalAnswer.js';
import { getSimpleMemIndex } from '../../db/repositories/simplememIndex.js';
import { simplememQuery } from '../../services/retrieval/simplemem/client.js';
import { decideFallback, mapCandidates } from '../../services/retrieval/simplemem/candidates.js';
import { rerankSimpleMemCandidates } from '../../services/retrieval/simplemem/rerank.js';

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
  /** Milliseconds this question has already spent parked for the notes or the transcript, across every re-queue. */
  const waitedMs = job.data.waitedMs ?? 0;
  /**
   * Milliseconds spent parked for the video's preparation, counted apart
   * from the notes' and the transcript's allowances. A six-minute
   * preparation (a 4 GB file, 2026-09-04) must not use up the four minutes
   * the notes are allowed afterwards, or a slow file would be sent to the
   * footage — fifty times the cost — for an answer the notes were about to
   * give (Devin's finding on #95).
   */
  const preparationWaitedMs = job.data.preparationWaitedMs ?? 0;

  try {
    // A question is accepted the moment the video's bytes have landed; the
    // answer waits here for the video to be prepared — its analysis segments
    // — the same way it waits for the notes and the transcript further down.
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
     * question is re-run, and it goes straight to the footage, because the
     * notes have already had their turn and did not settle it.
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
      await recordSearchApproach(clipRequestId, { notesConsulted: false, correctionOf: previous.id });
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
    // It sits above the notes path deliberately. Answering from memory is a
    // real answer and reaches finishClipRequest on its own; if the plan were
    // recorded further down, a question answered from the notes would never be
    // marked as owing a deck at all.
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

    /**
     * Waiting for the video to finish being read.
     *
     * A question asked while indexing is still running used to fall straight
     * through to the footage: ten calls carrying MP4 bytes, two minutes, and
     * fifty times the cost of the same question asked ninety seconds later.
     * Nobody chose that — it was just what happened when the notes were not
     * ready yet, and the screen told the user we would wait.
     *
     * So we wait, which is what it already said. The wall clock is no worse —
     * reading the footage takes about as long as finishing the notes — and it
     * costs a fraction. A correction skips this: it is going to the footage
     * anyway, so the notes finishing changes nothing for it.
     */
    const indexPending =
      video.indexStatus === 'pending' || video.indexStatus === 'queued' || video.indexStatus === 'running';

    /**
     * Notes are written chunk by chunk, so a read in progress still has some.
     * Try them: a question about the first five minutes can be answered while
     * the last five are still being read, and the part not yet read is named
     * in the answer rather than passed off as searched.
     *
     * Only if that finds nothing do we wait — and waiting beats falling
     * through to the footage, which costs about the same time and fifty times
     * the money for an answer the notes are about to be able to give.
     */
    if (!correcting && indexPending && waitedMs < env.INDEX_WAIT_TIMEOUT_MS) {
      const readSoFar = await sceneProgress(video.id);

      if (readSoFar.count > 0) {
        const answered = await answerFromNotes({
          clipRequestId,
          deckAttemptId,
          requestedResultCount: intent.countExplicit ? intent.requestedCount : null,
          video,
          chunks,
          instruction,
          mode: desired.mode,
          tally,
          log,
          readComplete: false,
        });

        if (answered.matchCount > 0) {
          if (answered.released) {
            log.info('answered from the part read so far', {
              matches: answered.matchCount,
              readThroughSeconds: Math.round(readSoFar.readThroughSeconds),
              ofSeconds: Math.round(video.durationSeconds ?? 0),
            });
          } else {
            log.warn('answered from the part read so far, but the answer was superseded', {
              matches: answered.matchCount,
              readThroughSeconds: Math.round(readSoFar.readThroughSeconds),
              ofSeconds: Math.round(video.durationSeconds ?? 0),
            });
          }
          outcome = 'completed';
          searchMode = desired.mode;
          chunkCount = 0;
          return;
        }
      }

      log.info('waiting for the video to finish being read', {
        waitedMs,
        indexStatus: video.indexStatus,
        readThroughSeconds: Math.round(readSoFar.readThroughSeconds),
        scenesSoFar: readSoFar.count,
      });
      await enqueueClipSearch(
        { clipRequestId, waitedMs: waitedMs + env.INDEX_WAIT_POLL_MS },
        { delay: env.INDEX_WAIT_POLL_MS },
      );
      return;
    }

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
     * Memory before a full footage read.
     *
     * The video was read once at upload; a question it can answer costs a
     * second and a fraction of a cent instead of re-reading the whole video.
     * A partial set of in-progress notes was already tried above; that lets an
     * early question finish without waiting. Corrections skip every memory.
     *
     * Finding nothing here is NOT an answer. The notes are what the indexer
     * thought worth writing down, so their silence means "not mentioned", not
     * "not present" — and the search falls through to the footage rather than
     * reporting an absence it cannot vouch for.
     */
    // Recorded whether or not the notes are consulted, because the two cases
    // answer different questions later: notes read and silent says reading at
    // upload is not covering what people ask, while no notes at all says
    // nothing about the reading and everything about the video's age.
    /**
     * Omni-SimpleMem first once upload-time reading has settled.
     *
     * Another memory, asked before the notes because it holds a different
     * thing: the notes say what a model thought worth writing down, while its
     * timestamped visual memories describe selected frames. Anything but
     * a confident hit hands the question straight on to the notes below, with
     * the reason recorded — the index is never allowed to end a search by
     * finding nothing.
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
        primary: 'simplemem',
        system: 'simplemem',
        fallbackReason: null,
        primaryOutcome: fromSimpleMem.outcome,
      });
      outcome = 'completed';
      searchMode = resolved.mode;
      chunkCount = 0;
      return;
    }
    if (env.RETRIEVAL_PRIMARY === 'simplemem') {
      await recordRetrievalOutcome(clipRequestId, {
        primary: 'simplemem',
        system: null,
        fallbackReason: fromSimpleMem.fallback,
        primaryOutcome: fromSimpleMem.outcome,
      });
      log.info('Omni-SimpleMem handed the question on', { reason: fromSimpleMem.fallback });
    }

    const fromIndex = await answerFromMediaIndex({
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
    if (fromIndex.matchCount > 0) {
      await recordRetrievalOutcome(clipRequestId, {
        primary: env.RETRIEVAL_PRIMARY === 'simplemem' ? 'simplemem' : 'media_index',
        system: 'media_index',
        fallbackReason: env.RETRIEVAL_PRIMARY === 'simplemem' ? fromSimpleMem.fallback : null,
        primaryOutcome: env.RETRIEVAL_PRIMARY === 'simplemem' ? fromSimpleMem.outcome : fromIndex.outcome,
      });
      outcome = 'completed';
      searchMode = resolved.mode;
      chunkCount = 0;
      return;
    }
    // Written to the row, not only the log. Every claim made for this design
    // — how often the index answers, why it hands a question on, whether the
    // fallback did better — can only be checked if the reason is durable. A
    // reason that lives in a log line is not a record.
    if (env.MEDIA_INDEX_ENABLED && env.RETRIEVAL_PRIMARY !== 'simplemem') {
      // The reason and what the index produced, but NOT a claim about who
      // answered: the fallback has not run yet, and it can still fail. A row
      // saying Clipit answered a question nothing answered is worse than a
      // row that says nothing. completeRequest fills the system in when a
      // path actually succeeds.
      await recordRetrievalOutcome(clipRequestId, {
        primary: 'media_index',
        system: null,
        fallbackReason: fromIndex.fallback,
        primaryOutcome: fromIndex.outcome,
      });
    } else if (env.MEDIA_INDEX_ENABLED && env.RETRIEVAL_PRIMARY === 'simplemem') {
      // There is one primary/fallback column pair, so retain the nested media
      // fallback inside the primary outcome instead of overwriting the reason
      // SimpleMem handed off. This makes both decisions durable.
      await recordRetrievalOutcome(clipRequestId, {
        primary: 'simplemem',
        system: null,
        fallbackReason: fromSimpleMem.fallback,
        primaryOutcome: {
          ...(fromSimpleMem.outcome ?? {}),
          mediaIndexFallback: fromIndex.fallback,
          mediaIndexOutcome: fromIndex.outcome,
        },
      });
    }
    if (env.MEDIA_INDEX_ENABLED && fromIndex.fallback && fromIndex.fallback !== 'disabled') {
      log.info('the media index handed the question on', { reason: fromIndex.fallback });
    }

    const notesAvailable = !correcting && video.indexStatus === 'ready';
    if (!correcting) await recordSearchApproach(clipRequestId, { notesConsulted: notesAvailable });

    if (notesAvailable) {
      const answered = await answerFromNotes({
        clipRequestId,
        deckAttemptId,
        requestedResultCount: intent.countExplicit ? intent.requestedCount : null,
        video,
        chunks,
        instruction,
        mode: resolved.mode,
        tally,
        log,
        readComplete: true,
      });

      if (answered.matchCount > 0) {
        outcome = 'completed';
        searchMode = resolved.mode;
        chunkCount = 0;
        return;
      }
    }

    // One cheap check before uploading megabytes per chunk: a model without
    // video endpoints refuses every chunk identically, and finding that out
    // once is worth more than finding it out N times.
    if (resolved.mode !== 'transcript') await assertVideoInputSupported();

    await startClipRequest(clipRequestId, { chunksTotal: chunks.length, resolvedMode: resolved.mode });
    // So the peak reported at the end belongs to this search.
    resetVideoCallPeak();
    // Reading the footage is the only path that can report a real absence, so
    // it is the only one that runs when the notes came up empty.
    // Clear anything from a previous attempt so a retry cannot double-insert,
    // taking its rendered media with it rather than orphaning it.
    await clearPreviousAttempt(clipRequestId, log, deckAttemptId);

    // (the deck plan is declared earlier — see above, before the notes path)

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
        });
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
 * Two paths reach a completed request: the notes, and the footage. Both owe
 * the creator the same thing: the moments they found, with their pictures,
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
  /** The token from recordDeckPlan — the release is fenced to it. */
  deckAttemptId: string | null;
  /** A number the person wrote, or null: the only cap there is. */
  requestedResultCount: number | null;
  /** The effective question, which differs from the stored words for a correction. */
  question?: string;
  /** A retrieval-specific limitation that cannot be inferred from chunk failures. */
  coverageNote?: string | null;
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
  const chunkCoverageNote = request.chunksFailed > 0
    ? `${request.chunksFailed} section(s) of the video could not be examined.`
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
  // lost if this process stops. Notes and footage are both Clipit's own
  // search; only the external retrieval systems are the other thing.
  const released = input.deckAttemptId
    ? await releaseDeckAndComplete(
        clipRequestId,
        input.deckAttemptId,
        input.answeredFrom,
        input.answeredFrom === 'media_index'
          ? 'media_index'
          : input.answeredFrom === 'simplemem'
            ? 'simplemem'
            : 'clipit',
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

/**
 * A hole in the notes shorter than this is not worth telling anyone about —
 * it is the rounding between one scene ending and the next beginning, not a
 * stretch of video nobody described.
 */
const NOTES_GAP_TOLERANCE_SECONDS = 5;

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
  if (env.RETRIEVAL_PRIMARY !== 'simplemem') {
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
    const source = await sourceIdentity(input.video.proxyStorageKey);
    const videoUrl = await getStorage().createDownloadUrl(input.video.proxyStorageKey, {
      expiresInSeconds: env.MEDIA_INDEX_REQUEST_TIMEOUT_SECONDS,
    });
    const startedAt = new Date();
    const began = performance.now();
    verified = await rerankSimpleMemCandidates({
      query: input.instruction,
      candidates: mapping.candidates,
      videoUrl,
      videoKey: source.identity,
      expectedBytes: source.sizeBytes,
    });
    await recordModelUsage({
      videoId: input.video.id,
      clipRequestId: input.clipRequestId,
      provider: 'modal',
      model: verified.result.model,
      stage: 'rerank',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: estimateGpuCostUsd(gpuMsFrom([verified.result.metrics])),
      latencyMs: Math.round(performance.now() - began),
      metrics: { ...verified.result.metrics, source: 'simplemem' },
      startedAt,
    }).catch(() => undefined);
  } catch (error) {
    const detail = errorMessage(error);
    input.log.warn('Omni-SimpleMem candidates could not be verified; using fallback retrieval', { err: error });
    return {
      matchCount: 0,
      released: false,
      fallback: 'primary_failed',
      outcome: { ...baseOutcome, rerankError: detail },
    };
  }

  const outcome = {
    ...baseOutcome,
    verifiedCandidates: verified.candidates.length,
    rerankFailures: verified.failed.length,
    rerankModel: verified.result.model,
    rerankRevision: verified.result.revision,
    rerankMetrics: verified.result.metrics,
  };
  if (verified.candidates.length === 0) {
    return { matchCount: 0, released: false, fallback: 'no_candidates', outcome };
  }
  await clearPreviousAttempt(input.clipRequestId, input.log, input.deckAttemptId);
  if (input.video.durationSeconds !== null
      && index?.coveredThroughSeconds !== null
      && index?.coveredThroughSeconds !== undefined
      && index.coveredThroughSeconds + 0.001 < input.video.durationSeconds) {
    const startSeconds = Math.max(0, index.coveredThroughSeconds);
    const chunk = input.chunks.find((item) =>
      startSeconds >= item.globalStartSeconds && startSeconds < item.globalEndSeconds,
    ) ?? input.chunks.at(-1);
    if (chunk) {
      await recordChunkFailure(input.clipRequestId, {
        chunkIndex: chunk.chunkIndex,
        chunkId: chunk.id,
        message: 'Omni-SimpleMem indexing stopped before the end of the video.',
        code: 'not_read_yet',
        globalStartSeconds: startSeconds,
        globalEndSeconds: input.video.durationSeconds,
      });
    }
  }
  for (const failure of verified.failed) {
    const chunk = input.chunks.find((item) =>
      failure.startSeconds >= item.globalStartSeconds && failure.startSeconds < item.globalEndSeconds,
    ) ?? input.chunks.at(-1);
    if (!chunk) continue;
    await recordChunkFailure(input.clipRequestId, {
      chunkIndex: chunk.chunkIndex,
      chunkId: chunk.id,
      message: `Omni-SimpleMem found this candidate, but the reranker could not verify it: ${failure.reason}`,
      code: 'not_read_yet',
      globalStartSeconds: failure.startSeconds,
      globalEndSeconds: failure.endSeconds,
    });
  }
  const wanted = input.requestedResultCount ?? verified.candidates.length;
  const found: NewClipMatch[] = [];
  for (const candidate of verified.candidates.slice(0, wanted)) {
    const chunk = input.chunks.find((item) =>
      candidate.startSeconds >= item.globalStartSeconds && candidate.startSeconds < item.globalEndSeconds,
    ) ?? input.chunks.at(-1);
    if (!chunk) continue;
    const local = mapGlobalRangeToChunk(chunk, candidate);
    if (!local) continue;
    found.push({
      chunkId: chunk.id,
      localStartSeconds: local.localStartSeconds,
      localEndSeconds: local.localEndSeconds,
      globalStartSeconds: local.globalStartSeconds,
      globalEndSeconds: local.globalEndSeconds,
      description: candidate.description || `A moment matching "${input.instruction}"`,
      confidence: Math.max(0, Math.min(1, candidate.score)),
      source: 'visual',
      provider: 'omni-simplemem',
      model: typeof index?.config?.visual === 'string' ? index.config.visual : 'Omni-SimpleMem',
    });
  }
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
    coverageNote: input.video.durationSeconds !== null
      && index?.coveredThroughSeconds !== null && index?.coveredThroughSeconds !== undefined
      && index.coveredThroughSeconds + 0.001 < input.video.durationSeconds
      ? `Omni-SimpleMem only examined the first ${Math.round(index.coveredThroughSeconds)} of ${Math.round(input.video.durationSeconds)} seconds.`
      : null,
    log: input.log,
  });
  input.log.info('answered from Omni-SimpleMem', { matches: finalCount, released, ...outcome });
  return { matchCount: finalCount, released, fallback: null, outcome };
}


/**
 * Answers from what was written down at upload, or reports that it cannot.
 *
 * Returns the number of moments found. Zero means the notes do not mention it
 * — NOT that the video lacks it — and the caller must go to the footage before
 * telling anyone otherwise.
 */
/**
 * Answering from the vectors, before the notes are asked.
 *
 * This is memory too, and a different kind from the notes: the notes are a
 * model's summary of what it thought worth writing down, and these are what
 * the pictures actually look like. That is why they go first for a question
 * about something SEEN — a summary drops the sign on the wall, and a dropped
 * sentence cannot be matched against.
 *
 * Finding nothing here is NOT an answer, exactly as finding nothing in the
 * notes is not. The question falls through to the notes and then to the
 * footage, and the reason it fell through is recorded so the two systems can
 * be compared from rows later.
 */
async function answerFromMediaIndex(input: {
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
  fallback: IndexFallbackReason | null;
  /** What the index actually produced, kept even when the fallback answered. */
  outcome: Record<string, unknown> | null;
}> {
  const { clipRequestId, video, chunks, instruction, mode, correcting, log } = input;
  const startedAt = performance.now();

  // Checked before anything is read. Switched off, this path must cost
  // nothing at all — not a query, not a round trip — because every search in
  // the product goes through it.
  if (!env.MEDIA_INDEX_ENABLED) {
    return { matchCount: 0, released: false, fallback: 'disabled', outcome: null };
  }

  const status = await getMediaIndexStatus(video.id);
  const before = decideIndexAnswer({ enabled: true, correcting, mode, status });
  if (before.use === 'fallback') {
    return { matchCount: 0, released: false, fallback: before.reason, outcome: null };
  }

  // decideIndexAnswer has already refused a null status as `index_missing`,
  // so this cannot fire — it is here so the reads below are not resting on a
  // non-null assertion that a later edit could quietly invalidate.
  if (!status || status.dims === null) {
    return { matchCount: 0, released: false, fallback: 'index_missing', outcome: null };
  }

  // Marked as searching before any remote call. Embedding the question and
  // reranking the shortlist can take a while, and the request would otherwise
  // read as "Queued" throughout — the serializer shows the right words for a
  // memory answer when no segments are counted.
  await startClipRequest(clipRequestId, { chunksTotal: 0, resolvedMode: mode });

  // Collected as each call completes, so a later failure cannot erase the
  // record of an earlier one that already ran and already cost money.
  const paidCalls: IndexSearchCall[] = [];
  const recordCalls = async () => {
    for (const call of paidCalls.splice(0)) {
      await recordModelUsage({
        videoId: video.id,
        clipRequestId,
        provider: 'modal',
        model: call.model,
        stage: call.stage,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        costUsd: estimateGpuCostUsd(call.gpuMs),
        latencyMs: call.latencyMs,
        metrics: { gpuMs: call.gpuMs, ...call.metrics },
        startedAt: call.startedAt,
      }).catch(() => undefined);
    }
  };

  let result;
  let windowsSearched = 0;
  /** Exactly which windows were searched, so the gaps between them are known. */
  let searchedWindowKeys: string[] = [];
  try {
    const snapshot = await listIndexedWindows(video.id);
    // Coverage came back with the windows, from one read. A re-index starting
    // between two separate reads would pair one run's windows with another
    // run's coverage, and partly-read replacement footage would be reported
    // as fully read. If the run moved since the decision above, this
    // question is about an index that no longer exists.
    if (snapshot.runStartedAt?.getTime() !== status.startedAt?.getTime()) {
      log.info('the index was replaced while this question was being answered; handing it on');
      await recordCalls();
      return { matchCount: 0, released: false, fallback: 'index_not_ready', outcome: null };
    }
    const windows = snapshot.windows;
    windowsSearched = windows.length;
    searchedWindowKeys = windows.map((window) => window.windowKey);
    const source = video.proxyStorageKey ? await sourceIdentity(video.proxyStorageKey) : null;
    // Do these vectors still describe this video? Checked here because this is
    // the first point where both identities exist: what the index was built
    // from came back with the windows, and what the video IS was just read
    // from the store. A run voided by a swap the handler could not write down
    // would otherwise stay searchable and answer with timestamps into footage
    // that has been replaced.
    if (footageWasReplaced(snapshot.sourceIdentity, source?.identity ?? null)) {
      log.info('these vectors describe footage this video no longer has; handing the question on', {
        videoId: video.id,
      });
      await recordCalls();
      return { matchCount: 0, released: false, fallback: 'index_footage_replaced', outcome: null };
    }
    const videoUrl = video.proxyStorageKey
      ? await getStorage().createDownloadUrl(video.proxyStorageKey, {
          expiresInSeconds: env.MEDIA_INDEX_REQUEST_TIMEOUT_SECONDS,
        })
      : null;

    result = await searchMediaIndex({
      instruction,
      windows,
      coveredThroughSeconds: snapshot.coveredThroughSeconds,
      onCall: (call) => paidCalls.push(call),
      storedBy: { model: status.model, revision: status.revision, dims: status.dims },
      // Without the proxy there is no footage to rerank against, so the raw
      // vector order stands rather than the search failing.
      rerank: source && videoUrl
        ? { videoUrl, videoKey: source.identity, expectedBytes: source.sizeBytes }
        : undefined,
    });
  } catch (error) {
    // A model change since this video was indexed is not a failure to report
    // as one: the index is simply stale, and the question goes to the notes
    // while the video waits to be re-read.
    await recordCalls();
    if (error instanceof IndexProvenanceChanged) {
      log.warn('the index was made by different weights than the question; handing the question on', {
        reason: error.message,
      });
      return { matchCount: 0, released: false, fallback: 'provenance_changed', outcome: null };
    }
    log.warn('the media index could not answer; handing the question on', { err: error });
    return { matchCount: 0, released: false, fallback: 'index_failed', outcome: null };
  }

  // Kept whether or not this answer is used. "The index found nothing" and
  // "the index found three moments and the fallback still did better" are
  // different facts, and only one of them is visible without this.
  const outcome: Record<string, unknown> = {
    windows: windowsSearched,
    moments: result.moments.length,
    topScore: result.moments[0]?.score ?? null,
    reranked: result.reranked,
    coveredThroughSeconds: result.coveredThroughSeconds,
    model: result.model,
    revision: result.revision,
    elapsedMs: Math.round(performance.now() - startedAt),
  };

  // Recorded here, before the decision below can take an early exit. A
  // consultation that found nothing still embedded the question and may still
  // have reranked — a search that costs money and reports none is exactly the
  // report that makes the comparison worthless.
  await recordCalls();

  const after = decideIndexAnswer({
    enabled: true, correcting, mode, status, candidateCount: result.moments.length,
  });
  if (after.use === 'fallback') {
    return { matchCount: 0, released: false, fallback: after.reason, outcome };
  }

  // Every moment that survived the relevance test, unless the person asked
  // for a number. The filter is what limits results here; an arbitrary cap on
  // top of it would silently drop hits the other search paths would return.
  // Every paid call this question made, recorded before anything else can
  // fail. A per-question cost that omits the calls the question actually made
  // is the exact shape of error migration 027 was written about — and this
  // path is the only writer of the `rerank` stage that migration 044 added.
  await recordCalls();

  const wanted = input.requestedResultCount ?? result.moments.length;
  const found: NewClipMatch[] = [];
  for (const moment of result.moments.slice(0, wanted)) {
    const chunk = chunks.find(
      (candidate) =>
        moment.startSeconds >= candidate.globalStartSeconds && moment.startSeconds < candidate.globalEndSeconds,
    ) ?? chunks.at(-1);
    if (!chunk) continue;
    const local = mapGlobalRangeToChunk(chunk, { startSeconds: moment.startSeconds, endSeconds: moment.endSeconds });
    if (!local) continue;

    found.push({
      chunkId: chunk.id,
      localStartSeconds: local.localStartSeconds,
      localEndSeconds: local.localEndSeconds,
      globalStartSeconds: moment.startSeconds,
      globalEndSeconds: moment.endSeconds,
      description: `A moment matching "${instruction}"`,
      // The score a similarity or a reranker produced. NOT on the same scale
      // as the confidences a language model writes, and deliberately not
      // rescaled to look as though it were: inventing a calibration would
      // make two incomparable numbers look comparable.
      confidence: Math.max(0, Math.min(1, moment.score)),
      source: 'visual',
      provider: 'modal',
      model: result.model,
    });
  }

  if (found.length === 0) {
    return { matchCount: 0, released: false, fallback: 'no_candidates', outcome };
  }

  // Everything past the unbroken read has not been examined, and says so
  // through the same coverage channel a failed chunk uses — so it appears on
  // screen as an unexamined stretch, and "look again" escalates to the
  // footage rather than the person being told the video holds nothing there.
  const duration = video.durationSeconds ?? chunks.at(-1)?.globalEndSeconds ?? 0;

  /**
   * Every stretch the index did not read — each one, not just the tail.
   *
   * Two wrong answers were tried before this one. Reporting everything past
   * the contiguous prefix OVERSTATES it: windows past a hole are stored and
   * were compared against the question. Reporting only past the furthest
   * stored window UNDERSTATES it, and hides a hole in the middle entirely —
   * which is worse, because an unexamined moment then reads as an absence.
   *
   * So the planned grid is rebuilt and diffed against what is actually
   * stored. The grid is deterministic from the video's length and the index
   * settings, which is what makes this possible without storing the gaps.
   */
  const storedKeys = new Set(searchedWindowKeys);
  const plannedNow = planWindows(duration, {
    windowSeconds: env.MEDIA_INDEX_WINDOW_SECONDS,
    strideSeconds: env.MEDIA_INDEX_STRIDE_SECONDS,
    minWindowSeconds: env.MEDIA_INDEX_MIN_WINDOW_SECONDS,
  });
  for (const gap of unreadRanges(plannedNow, storedKeys, windowKey)) {
    const where = chunks.find(
      (chunk) => gap.startSeconds >= chunk.globalStartSeconds && gap.startSeconds < chunk.globalEndSeconds,
    ) ?? chunks.at(-1);
    if (!where) continue;
    await recordChunkFailure(clipRequestId, {
      chunkIndex: where.chunkIndex,
      chunkId: where.id,
      message: 'This stretch had not been read into the index when the question was asked',
      code: 'not_read_yet',
      globalStartSeconds: gap.startSeconds,
      globalEndSeconds: gap.endSeconds,
    });
  }

  // Stretches the reranker could not read are named as unexamined, through
  // the same channel a failed chunk uses. Left silent they would look like
  // footage that was watched and found wanting.
  for (const stretch of result.unread) {
    const where = chunks.find(
      (chunk) =>
        stretch.startSeconds >= chunk.globalStartSeconds && stretch.startSeconds < chunk.globalEndSeconds,
    ) ?? chunks.at(-1);
    if (!where) continue;
    await recordChunkFailure(clipRequestId, {
      chunkIndex: where.chunkIndex,
      chunkId: where.id,
      message: `This stretch could not be examined: ${stretch.reason}`,
      code: 'not_read_yet',
      globalStartSeconds: stretch.startSeconds,
      globalEndSeconds: stretch.endSeconds,
    });
  }

  await insertMatches(clipRequestId, found);
  const finalCount = await aggregateStoredMatches(clipRequestId, chunks, input.deckAttemptId);

  await withWorkDir(`index-${clipRequestId}`, async (dir) => {
    await attachSearchThumbnails({ clipRequestId, video, workDir: dir, log });
  });

  const released = await completeRequest({
    clipRequestId, answeredFrom: 'media_index', deckAttemptId: input.deckAttemptId, log,
    requestedResultCount: input.requestedResultCount,
    question: input.instruction,
  });

  log.info('answered from the media index', {
    matches: finalCount,
    released,
    reranked: result.reranked,
    coveredThroughSeconds: Math.round(result.coveredThroughSeconds),
    ofSeconds: Math.round(duration),
    elapsedMs: Math.round(performance.now() - startedAt),
  });

  return { matchCount: finalCount, released, fallback: null, outcome };
}

async function answerFromNotes(input: {
  clipRequestId: string;
  /** The planning token, so the release stays fenced on this path too. */
  deckAttemptId: string | null;
  /** A number the person wrote, or null. */
  requestedResultCount: number | null;
  video: Video;
  chunks: VideoChunk[];
  instruction: string;
  mode: ResolvedSearchMode;
  tally: UsageTally;
  log: Logger;
  /**
   * False while the video is still being read. What is missing from the notes
   * is then a stretch not reached yet, not a stretch that failed — and the two
   * must not be reported in the same words.
   */
  readComplete: boolean;
}): Promise<{ matchCount: number; released: boolean }> {
  const { clipRequestId, video, chunks, instruction, mode, tally, log, readComplete } = input;
  const startedAt = performance.now();

  // Memory is both halves: what was seen, and what was said. A spoken question
  // answered only from scene descriptions would be answered from the wrong
  // evidence, so the transcript joins the notes whenever the question involves
  // speech at all.
  const scenes = await listScenes(video.id);
  const speech = mode === 'visual' ? [] : await listTranscriptSegments(video.id);

  const notes: NoteLine[] = [
    ...scenes.map((scene) => ({
      startSeconds: scene.startSeconds,
      endSeconds: scene.endSeconds,
      description: scene.description,
      kind: 'seen' as const,
    })),
    ...speech.map((segment) => ({
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      description: `"${segment.text}"`,
      kind: 'said' as const,
    })),
  ].sort((a, b) => a.startSeconds - b.startSeconds);

  if (notes.length === 0) return { matchCount: 0, released: false };

  await startClipRequest(clipRequestId, { chunksTotal: 0, resolvedMode: mode });
  await clearPreviousAttempt(clipRequestId, log, input.deckAttemptId);

  const result = await searchNotes({
    instruction,
    notes,
    onUsage: (usage) => {
      tally.add(usage);
      void recordModelUsage({ ...usage, stage: 'search', videoId: video.id, clipRequestId });
    },
  });

  if (result.warnings.length > 0) {
    log.warn('notes lookup warnings', { warnings: result.warnings.slice(0, 5) });
  }

  // Notes carry source timestamps, so a match has to be placed back on the
  // chunk grid the rest of the system stores matches against.
  const found: NewClipMatch[] = [];
  const uncertain: UncertainMatch[] = [];

  for (const match of result.matches) {
    const chunk = chunks.find(
      (candidate) => match.startSeconds >= candidate.globalStartSeconds && match.startSeconds < candidate.globalEndSeconds,
    ) ?? chunks.at(-1);
    if (!chunk) continue;

    // Every timestamp the model reports goes through the same validation,
    // whether it becomes a result or a maybe. A reversed, negative or
    // past-the-end range is not a moment, and showing one as "I saw something
    // at -00:12" is worse than not mentioning it at all.
    const local = mapGlobalRangeToChunk(
      chunk,
      { startSeconds: match.startSeconds, endSeconds: match.endSeconds },
      { minDurationSeconds: env.MIN_CLIP_SECONDS, maxDurationSeconds: env.MAX_CLIP_SECONDS },
    );
    if (!local) continue;

    if (match.confidence < env.MIN_MATCH_CONFIDENCE) {
      // Same rule as the footage path: a moment we found and discarded is
      // mentioned, never silently turned into an absence.
      uncertain.push({
        globalStartSeconds: local.globalStartSeconds,
        globalEndSeconds: local.globalEndSeconds,
        confidence: match.confidence,
        description: match.description,
      });
      continue;
    }

    found.push({
      chunkId: chunk.id,
      localStartSeconds: local.localStartSeconds,
      localEndSeconds: local.localEndSeconds,
      globalStartSeconds: local.globalStartSeconds,
      globalEndSeconds: local.globalEndSeconds,
      description: match.description,
      confidence: match.confidence,
      source: MATCH_SOURCE[mode],
      quote: match.quote,
      // Attribution names the notes lane that actually answered, not the
      // configured video provider — a thumbs-down on a notes answer is
      // evidence about the notes lookup, and must not land on MiniCPM.
      provider: result.provider,
      model: result.model,
      promptVersion: result.promptVersion || null,
    });
  }

  if (uncertain.length > 0) await recordUncertainMatches(clipRequestId, uncertain);

  log.info('notes consulted', {
    notes: notes.length,
    scenes: scenes.length,
    speech: speech.length,
    lookups: result.lookups,
    reported: result.matches.length,
    kept: found.length,
    elapsedMs: Math.round(performance.now() - startedAt),
  });

  // Nothing remembered. Left unfinished on purpose: the caller reads the video
  // itself before anyone is told this video does not contain what they asked
  // for.
  if (found.length === 0) return { matchCount: 0, released: false };

  /**
   * Name the stretches the notes never covered.
   *
   * A scene list can be perfectly valid and still leave a chunk half
   * described, and a chunk that failed at index time leaves its whole window
   * missing. Answering from notes with holes in them, and presenting the
   * result as the complete set of moments, is the same untruth as reporting an
   * unsearched chunk as searched — the user cannot tell a stretch nobody read
   * from a stretch containing nothing.
   *
   * These are reported through the existing coverage channel, so they appear
   * on screen exactly like any other unexamined window, and "look again"
   * escalates to reading the footage.
   */
  const duration = video.durationSeconds ?? chunks.at(-1)?.globalEndSeconds ?? 0;
  const unread = findUncoveredRanges(
    scenes.map((scene) => ({ startSeconds: scene.startSeconds, endSeconds: scene.endSeconds })),
    duration,
    NOTES_GAP_TOLERANCE_SECONDS,
  );

  for (const gap of unread) {
    // The chunk the gap starts in, only so the record has the same shape as a
    // failed chunk. A gap can span several; the window is what matters, and it
    // is carried whole.
    const where =
      chunks.find((chunk) => gap.startSeconds >= chunk.globalStartSeconds && gap.startSeconds < chunk.globalEndSeconds)
      ?? chunks.at(-1)!;

    await recordChunkFailure(clipRequestId, {
      chunkIndex: where.chunkIndex,
      chunkId: where.id,
      message: readComplete
        ? 'This stretch is not described in the notes taken at upload'
        : 'This stretch had not been watched yet when the question was asked',
      code: readComplete ? 'not_in_notes' : 'not_read_yet',
      globalStartSeconds: gap.startSeconds,
      globalEndSeconds: gap.endSeconds,
    });
  }

  if (unread.length > 0) {
    log.warn('answered from notes that do not cover the whole video', {
      gaps: unread.length,
      unreadSeconds: Number(unread.reduce((sum, gap) => sum + (gap.endSeconds - gap.startSeconds), 0).toFixed(1)),
    });
  }

  await insertMatches(clipRequestId, found);
  const finalCount = await aggregateStoredMatches(clipRequestId, chunks, input.deckAttemptId);

  await withWorkDir(`notes-${clipRequestId}`, async (dir) => {
    await attachSearchThumbnails({ clipRequestId, video, workDir: dir, log });
  });

  // The notes decided WHICH moments, exactly as they always have; the request
  // is completed by the same helper the footage path uses so the two can
  // never drift apart on what a creator is owed.
  const released = await completeRequest({
    clipRequestId, answeredFrom: 'notes', deckAttemptId: input.deckAttemptId, log,
    requestedResultCount: input.requestedResultCount,
    question: input.instruction,
  });

  const answerLog = {
    matches: finalCount,
    released,
    elapsedMs: Math.round(performance.now() - startedAt),
    ...tally.summary(),
  };
  if (released) {
    log.info('answered from memory', answerLog);
  } else {
    log.warn('answered from memory but the answer was superseded before release', answerLog);
  }

  return { matchCount: finalCount, released };
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
