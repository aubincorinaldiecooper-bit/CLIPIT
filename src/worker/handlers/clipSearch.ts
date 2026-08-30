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
  deleteMatches,
  finishClipRequest,
  getClipRequest,
  getPreviousClipRequest,
  insertMatches,
  listMatches,
  recordChunkCompleted,
  recordChunkDegraded,
  recordChunkFailure,
  recordSearchApproach,
  recordUncertainMatches,
  startClipRequest,
  type NewClipMatch,
} from '../../db/repositories/clipRequests.js';
import { enqueueClipSearch, type ClipSearchJob } from '../../queues/index.js';
import type {
  ChunkDegradation,
  ChunkFailureCode,
  MatchSource,
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

  const video = await getVideo(request.videoId);
  if (!video) {
    await finishClipRequest(clipRequestId, 'failed', 'Video no longer exists');
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

  try {
    if (video.status !== 'ready') {
      // The API blocks this, but a request can still race preprocessing.
      throw new Error(`Video is not ready for search (status: ${video.status})`);
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
        );
        outcome = 'completed';
        return;
      }

      instruction = previous.instruction;
      correcting = true;
      // The strongest signal there is — a person saying our answer was wrong.
      // Stored so it survives the footage and can be counted later.
      await recordSearchApproach(clipRequestId, { notesConsulted: false, correctionOf: previous.id });
      log.info('treating this as a correction rather than a new question', {
        said: request.instruction,
        lookingAgainFor: instruction,
      });
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

    const waitedMs = job.data.waitedMs ?? 0;

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
          video,
          chunks,
          instruction,
          mode: desired.mode,
          tally,
          log,
          readComplete: false,
        });

        if (answered > 0) {
          log.info('answered from the part read so far', {
            readThroughSeconds: Math.round(readSoFar.readThroughSeconds),
            ofSeconds: Math.round(video.durationSeconds ?? 0),
          });
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
      ...(correcting ? { correctionOf: request.instruction } : {}),
    });

    /**
     * Memory first.
     *
     * The video was read once at upload; a question it can answer costs a
     * second and a fraction of a cent instead of re-reading the whole video.
     * Skipped when correcting, because the notes are what was just disputed.
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
    const notesAvailable = !correcting && video.indexStatus === 'ready';
    if (!correcting) await recordSearchApproach(clipRequestId, { notesConsulted: notesAvailable });

    if (notesAvailable) {
      const answered = await answerFromNotes({
        clipRequestId,
        video,
        chunks,
        instruction,
        mode: resolved.mode,
        tally,
        log,
        readComplete: true,
      });

      if (answered > 0) {
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
    // Clear anything from a previous attempt so a retry cannot double-insert.
    await deleteMatches(clipRequestId);

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
      const finalCount = await aggregateStoredMatches(clipRequestId, chunks);

      // After aggregation, because merging rewrites match rows and their ids.
      await attachSearchThumbnails({ clipRequestId, video, workDir: dir, log });

      await finishClipRequest(clipRequestId, 'completed', null, 'footage');
      const elapsedMs = Math.round(performance.now() - searchStartedAt);

      log.info('clip search complete', {
        matches: finalCount,
        mergedFrom: totalMatches,
        failedChunks: failed,
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
    await finishClipRequest(clipRequestId, 'failed', message);
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
async function aggregateStoredMatches(clipRequestId: string, chunks: VideoChunk[]): Promise<number> {
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

  // Safe to replace: clips are only created from the generate endpoint, which
  // cannot run until the search reports complete.
  await deleteMatches(clipRequestId);
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
async function attachSearchThumbnails(input: {
  clipRequestId: string;
  video: Video;
  workDir: string;
  log: Logger;
}): Promise<void> {
  const { clipRequestId, video, workDir, log } = input;
  if (!video.proxyStorageKey) return;

  const matches = await listMatches(clipRequestId);
  await attachThumbnails({
    videoId: video.id,
    proxyStorageKey: video.proxyStorageKey,
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


/**
 * Answers from what was written down at upload, or reports that it cannot.
 *
 * Returns the number of moments found. Zero means the notes do not mention it
 * — NOT that the video lacks it — and the caller must go to the footage before
 * telling anyone otherwise.
 */
async function answerFromNotes(input: {
  clipRequestId: string;
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
}): Promise<number> {
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

  if (notes.length === 0) return 0;

  await startClipRequest(clipRequestId, { chunksTotal: 0, resolvedMode: mode });
  await deleteMatches(clipRequestId);

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
  if (found.length === 0) return 0;

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
  const finalCount = await aggregateStoredMatches(clipRequestId, chunks);

  await withWorkDir(`notes-${clipRequestId}`, async (dir) => {
    await attachSearchThumbnails({ clipRequestId, video, workDir: dir, log });
  });

  await finishClipRequest(clipRequestId, 'completed', null, 'notes');

  log.info('answered from memory', {
    matches: finalCount,
    elapsedMs: Math.round(performance.now() - startedAt),
    ...tally.summary(),
  });

  return finalCount;
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
