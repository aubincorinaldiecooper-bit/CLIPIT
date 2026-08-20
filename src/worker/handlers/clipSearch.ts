import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger, type Logger } from '../../lib/logger.js';
import { ExternalServiceError, errorMessage } from '../../lib/errors.js';
import { withWorkDir } from '../../lib/workdir.js';
import { mapWithConcurrency } from '../../lib/concurrency.js';
import { getStorage } from '../../services/storage/s3.js';
import { extractFrameAt } from '../../services/media/ffmpeg.js';
import { recordModelUsage } from '../../db/repositories/usage.js';
import { UsageTally } from '../../services/usageTally.js';
import { isContentFilterRejection, searchVideoChunk } from '../../services/search/openrouterVideo.js';
import { assertVideoInputSupported } from '../../services/search/modelCapabilities.js';
import { resolveSearchMode } from '../../services/search/instructionMode.js';
import { aggregateMatches } from '../../services/search/aggregateMatches.js';
import type { TranscriptLine } from '../../services/search/prompt.js';
import { mapGlobalRangeToChunk, mapLocalRangeToGlobal, mergeOverlappingRanges } from '../../services/timestamps.js';
import { getVideo, listChunks } from '../../db/repositories/videos.js';
import { listTranscriptSegmentsInRange } from '../../db/repositories/transcripts.js';
import {
  deleteMatches,
  finishClipRequest,
  getClipRequest,
  insertMatches,
  listMatches,
  recordChunkCompleted,
  recordChunkDegraded,
  recordChunkFailure,
  setMatchThumbnails,
  startClipRequest,
  type NewClipMatch,
} from '../../db/repositories/clipRequests.js';
import { enqueueClipSearch, type ClipSearchJob } from '../../queues/index.js';
import type {
  ChunkDegradation,
  ChunkFailureCode,
  MatchSource,
  ResolvedSearchMode,
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

    // Decide what to search. A transcript that is still being built is worth a
    // bounded wait, because falling back to visual-only silently would give the
    // user a worse answer for a spoken-word instruction.
    const transcriptPending = video.transcriptStatus === 'pending' || video.transcriptStatus === 'queued' || video.transcriptStatus === 'running';
    const transcriptReady = video.transcriptStatus === 'ready' && video.transcriptSegmentCount > 0;

    const desired = resolveSearchMode({
      instruction: request.instruction,
      requested: request.mode,
      transcriptAvailable: transcriptReady || transcriptPending,
    });

    const waitedMs = job.data.waitedMs ?? 0;

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
      instruction: request.instruction,
      requested: request.mode,
      transcriptAvailable: transcriptReady,
    });

    log.info('starting clip search', {
      mode: resolved.mode,
      rationale: resolved.rationale,
      chunks: chunks.length,
      instruction: request.instruction,
    });

    // One cheap check before uploading megabytes per chunk: a model without
    // video endpoints refuses every chunk identically, and finding that out
    // once is worth more than finding it out N times.
    if (resolved.mode !== 'transcript') await assertVideoInputSupported();

    await startClipRequest(clipRequestId, { chunksTotal: chunks.length, resolvedMode: resolved.mode });
    // Clear anything from a previous attempt so a retry cannot double-insert.
    await deleteMatches(clipRequestId);

    chunkCount = chunks.length;
    searchMode = resolved.mode;

    let completed = 0;
    let totalMatches = 0;
    const degradations: ChunkDegradation[] = [];

    await withWorkDir(`search-${clipRequestId}`, async (dir) => {
      const results = await mapWithConcurrency(chunks, env.OPENROUTER_VIDEO_CONCURRENCY, async (chunk) => {
        const found = await searchSingleChunk({
          chunk,
          chunkCount: chunks.length,
          instruction: request.instruction,
          mode: resolved.mode,
          videoId: video.id,
          clipRequestId,
          workDir: dir,
          tally,
          log,
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
      await attachThumbnails({ clipRequestId, video, workDir: dir, log });

      await finishClipRequest(clipRequestId, 'completed');
      const elapsedMs = Math.round(performance.now() - searchStartedAt);

      log.info('clip search complete', {
        matches: finalCount,
        mergedFrom: totalMatches,
        failedChunks: failed,
        // Coverage, not just outcome: how much of the video was actually
        // examined, and how much of it with less than the intended evidence.
        chunksSearchedWithoutTranscript: degradations.length,
        elapsedMs,
        // The three inputs that set wall-clock, logged alongside it so a slow
        // search can be read without correlating against config elsewhere.
        chunks: chunks.length,
        concurrency: env.OPENROUTER_VIDEO_CONCURRENCY,
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
async function attachThumbnails(input: {
  clipRequestId: string;
  video: Video;
  workDir: string;
  log: Logger;
}): Promise<void> {
  const { clipRequestId, video, workDir, log } = input;
  if (!video.proxyStorageKey) return;

  try {
    const matches = await listMatches(clipRequestId);
    if (matches.length === 0) return;

    const proxyPath = path.join(workDir, 'thumbs-source.mp4');
    await getStorage().downloadToFile(video.proxyStorageKey, proxyPath);

    const startedAt = performance.now();
    const dir = path.join(workDir, 'thumbs');
    await mkdir(dir, { recursive: true });

    const results = await mapWithConcurrency(matches, 4, async (match) => {
      const file = path.join(dir, `${match.id}.jpg`);
      // A shade after the start: the first frame of a cut often lands on a
      // transition, and a black frame is a worse preview than no preview.
      const at = Math.min(match.globalStartSeconds + 0.5, match.globalEndSeconds);
      if (!(await extractFrameAt(proxyPath, at, file))) return null;

      const key = `thumbnails/${video.id}/${match.id}.jpg`;
      await getStorage().uploadFile(key, file, 'image/jpeg');
      return { matchId: match.id, thumbnailKey: key };
    });

    const attached = results.flatMap((result) =>
      result.status === 'fulfilled' && result.value ? [result.value] : [],
    );
    await setMatchThumbnails(attached);

    log.info('match thumbnails attached', {
      attached: attached.length,
      matches: matches.length,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
  } catch (error) {
    log.warn('could not attach match thumbnails', { err: error });
  }
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
      } satisfies NewClipMatch,
    ];
  });
}
