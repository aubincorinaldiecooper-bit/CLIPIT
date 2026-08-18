import path from 'node:path';
import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { errorMessage, ExternalServiceError } from '../../lib/errors.js';
import { withWorkDir } from '../../lib/workdir.js';
import { mapWithConcurrency } from '../../lib/concurrency.js';
import { getStorage } from '../../services/storage/s3.js';
import { extractFrames, extractWindowFrames } from '../../services/media/ffmpeg.js';
import { completeWithRetry, searchChunk } from '../../services/search/minicpm.js';
import { parseModelMatches } from '../../services/search/modelResponse.js';
import { buildVerifyMessages, parseVerifyResponse } from '../../services/search/verify.js';
import { resolveSearchMode } from '../../services/search/instructionMode.js';
import { aggregateMatches } from '../../services/search/aggregateMatches.js';
import {
  buildIndexSearchUserMessage,
  INDEX_SEARCH_SYSTEM_PROMPT,
  type TranscriptLine,
} from '../../services/search/prompt.js';
import { mapGlobalRangeToChunk, mapLocalRangeToGlobal, mergeOverlappingRanges } from '../../services/timestamps.js';
import { getVideo, listChunks } from '../../db/repositories/videos.js';
import { listScenes } from '../../db/repositories/scenes.js';
import { listTranscriptSegmentsInRange } from '../../db/repositories/transcripts.js';
import {
  deleteMatches,
  finishClipRequest,
  getClipRequest,
  insertMatches,
  listMatches,
  recordChunkCompleted,
  recordChunkFailure,
  startClipRequest,
  type NewClipMatch,
} from '../../db/repositories/clipRequests.js';
import { enqueueClipSearch, type ClipSearchJob } from '../../queues/index.js';
import type { MatchSource, ResolvedSearchMode, Video, VideoChunk } from '../../domain/types.js';

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

    // A visual search is worth waiting for the scene index for the same
    // reason: answering from the index takes one small request, while the
    // fallback re-sends frames per chunk. The wait budget is shared with the
    // transcript wait above.
    const indexPending =
      video.indexStatus === 'pending' || video.indexStatus === 'queued' || video.indexStatus === 'running';

    if (desired.mode !== 'transcript' && env.INDEXING_ENABLED && indexPending && waitedMs < env.INDEX_WAIT_TIMEOUT_MS) {
      log.info('waiting for scene index before searching', {
        waitedMs,
        indexStatus: video.indexStatus,
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

    // Answer from the index whenever the evidence the resolved mode needs is
    // already text: the whole video in ONE small request, instead of
    // re-sending frames per chunk. The per-chunk frame path survives only as
    // the fallback for visual searches on videos with no usable index.
    const indexReady = video.indexStatus === 'ready' && video.sceneCount > 0;
    const useIndexSearch = resolved.mode === 'transcript' ? transcriptReady : indexReady;

    log.info('starting clip search', {
      mode: resolved.mode,
      rationale: resolved.rationale,
      evidence: useIndexSearch ? 'index' : 'chunk-frames',
      chunks: chunks.length,
      instruction: request.instruction,
    });

    await startClipRequest(clipRequestId, {
      chunksTotal: useIndexSearch ? 1 : chunks.length,
      resolvedMode: resolved.mode,
    });
    // Clear anything from a previous attempt so a retry cannot double-insert.
    await deleteMatches(clipRequestId);

    if (useIndexSearch) {
      let found = await searchFromIndex({
        video,
        chunks,
        instruction: request.instruction,
        mode: resolved.mode,
        indexReady,
        transcriptReady,
      });

      // The agentic step: check each proposed moment against the frames
      // actually on screen there before reporting it. Transcript-only
      // answers quote the speech itself, which needs no visual check.
      if (found.length > 0 && resolved.mode !== 'transcript' && env.VERIFY_MATCHES) {
        await job.updateProgress({ stage: 'verifying', percent: 80, matches: found.length });
        found = await withWorkDir(`verify-${clipRequestId}`, (dir) =>
          verifyMatches({
            matches: found,
            chunks,
            durationSeconds: video.durationSeconds ?? chunks.at(-1)!.globalEndSeconds,
            instruction: request.instruction,
            workDir: dir,
          }),
        );
      }

      if (found.length > 0) await insertMatches(clipRequestId, found);
      await recordChunkCompleted(clipRequestId);
      await job.updateProgress({ stage: 'searching', percent: 100, chunksCompleted: 1, chunksTotal: 1, matches: found.length });

      const finalCount = await aggregateStoredMatches(clipRequestId, chunks);
      await finishClipRequest(clipRequestId, 'completed');
      log.info('clip search complete', { matches: finalCount, evidence: 'index' });
      return;
    }

    let completed = 0;
    let totalMatches = 0;

    await withWorkDir(`search-${clipRequestId}`, async (dir) => {
      const results = await mapWithConcurrency(chunks, env.MINICPM_CONCURRENCY, async (chunk) => {
        const found = await searchSingleChunk({
          chunk,
          chunkCount: chunks.length,
          instruction: request.instruction,
          mode: resolved.mode,
          videoId: video.id,
          workDir: dir,
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
        log.warn('chunk search failed', { chunkIndex: chunk.chunkIndex, err: result.reason });
        await recordChunkFailure(clipRequestId, {
          chunkIndex: chunk.chunkIndex,
          chunkId: chunk.id,
          message,
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

      const rejected = results.filter((result) => result.status === 'rejected');
      const failed = rejected.length;

      if (failed === chunks.length) {
        // If every chunk failed with an error its API called permanent — a
        // rejected key, an over-limit prompt — the retry produces the same
        // answer, so fail the job terminally instead of burning attempts.
        const allTerminal = rejected.every(
          (result) => result.reason instanceof ExternalServiceError && !result.reason.retryable,
        );
        const message = `Every chunk failed to search (${failed}/${chunks.length})`;
        if (allTerminal) throw new ExternalServiceError('minicpm', message, { retryable: false });
        throw new Error(message);
      }

      // Chunks were searched independently, so the same moment can appear
      // twice — including as two pieces either side of a chunk boundary. Fold
      // duplicates together before the search is reported complete.
      const finalCount = await aggregateStoredMatches(clipRequestId, chunks);

      await finishClipRequest(clipRequestId, 'completed');
      log.info('clip search complete', {
        matches: finalCount,
        mergedFrom: totalMatches,
        failedChunks: failed,
      });
    });
  } catch (error) {
    const message = errorMessage(error);
    log.error('clip search failed', { err: error });
    await finishClipRequest(clipRequestId, 'failed', message);
    throw error;
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

interface SearchFromIndexInput {
  video: Video;
  chunks: VideoChunk[];
  instruction: string;
  mode: ResolvedSearchMode;
  indexReady: boolean;
  transcriptReady: boolean;
}

/**
 * Answers the instruction from what was written down at ingest — the scene
 * index and/or the transcript — in one text-only model call over the whole
 * video. Matches come back on the global timeline and are validated with the
 * same mapping module as chunk matches, using the video itself as the window.
 */
async function searchFromIndex(input: SearchFromIndexInput): Promise<NewClipMatch[]> {
  const { video, chunks, mode } = input;
  const durationSeconds = video.durationSeconds ?? chunks.at(-1)!.globalEndSeconds;

  const scenes = mode !== 'transcript' && input.indexReady ? await listScenes(video.id) : [];
  const transcript =
    mode !== 'visual' && input.transcriptReady
      ? await listTranscriptSegmentsInRange(video.id, 0, durationSeconds)
      : [];

  const raw = await completeWithRetry(
    [
      { role: 'system', content: INDEX_SEARCH_SYSTEM_PROMPT },
      {
        role: 'user',
        content: buildIndexSearchUserMessage({
          instruction: input.instruction,
          durationSeconds,
          scenes: scenes.map((scene) => ({
            startSeconds: scene.startSeconds,
            endSeconds: scene.endSeconds,
            description: scene.description,
          })),
          transcript: transcript.map((line) => ({
            startSeconds: line.startSeconds,
            endSeconds: line.endSeconds,
            text: line.text,
          })),
        }),
      },
    ],
    { stage: 'index-search' },
  );

  const { matches, warnings } = parseModelMatches(raw);
  if (warnings.length > 0) {
    logger.warn('model output warnings', { stage: 'index-search', warnings: warnings.slice(0, 5) });
  }

  // The whole video is the mapping window: local time IS global time.
  const wholeVideo = { globalStartSeconds: 0, globalEndSeconds: durationSeconds };

  const mapped = matches
    .filter((match) => match.confidence >= env.MIN_MATCH_CONFIDENCE)
    .flatMap((match) => {
      const range = mapLocalRangeToGlobal(
        wholeVideo,
        { startSeconds: match.startSeconds, endSeconds: match.endSeconds },
        { minDurationSeconds: env.MIN_CLIP_SECONDS, maxDurationSeconds: env.MAX_CLIP_SECONDS },
      );
      if (!range) {
        logger.warn('discarding out-of-range match', {
          stage: 'index-search',
          start: match.startSeconds,
          end: match.endSeconds,
          durationSeconds,
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

  const deduped = mergeOverlappingRanges(mapped);

  return deduped.map((range) =>
    anchorToChunk(
      {
        startSeconds: range.startSeconds,
        endSeconds: range.endSeconds,
        description: range.description,
        confidence: range.confidence ?? 0,
        quote: range.quote ?? null,
      },
      chunks,
      MATCH_SOURCE[mode],
    ),
  );
}

/**
 * Anchors a global range to the chunk containing its start, as aggregation
 * does; the local range may honestly extend past that chunk's end.
 */
function anchorToChunk(
  range: { startSeconds: number; endSeconds: number; description: string; confidence: number; quote: string | null },
  chunks: VideoChunk[],
  source: MatchSource,
): NewClipMatch {
  const anchor =
    chunks.find(
      (chunk) => range.startSeconds >= chunk.globalStartSeconds && range.startSeconds < chunk.globalEndSeconds,
    ) ?? chunks.at(-1)!;

  return {
    chunkId: anchor.id,
    localStartSeconds: Number((range.startSeconds - anchor.globalStartSeconds).toFixed(3)),
    localEndSeconds: Number((range.endSeconds - anchor.globalStartSeconds).toFixed(3)),
    globalStartSeconds: Number(range.startSeconds.toFixed(3)),
    globalEndSeconds: Number(range.endSeconds.toFixed(3)),
    description: range.description,
    confidence: range.confidence,
    source,
    quote: range.quote,
  } satisfies NewClipMatch;
}

interface VerifyMatchesInput {
  matches: NewClipMatch[];
  chunks: VideoChunk[];
  durationSeconds: number;
  instruction: string;
  workDir: string;
}

/**
 * The agentic step: every proposed moment is checked against the frames
 * actually on screen in its window before it is reported. Confirmed moments
 * get their timestamps refined to what the footage shows; unconfirmed ones
 * lose most of their confidence and are dropped below the reporting floor.
 * A verification that itself fails keeps the original match — the check may
 * not destroy information it could not improve.
 */
async function verifyMatches(input: VerifyMatchesInput): Promise<NewClipMatch[]> {
  const chunkById = new Map(input.chunks.map((chunk) => [chunk.id, chunk]));
  const chunkFiles = new Map<string, string>();
  const kept: NewClipMatch[] = [];

  for (const [index, match] of input.matches.entries()) {
    if (index >= env.VERIFY_MAX_MATCHES) {
      kept.push(match);
      continue;
    }

    const anchor = chunkById.get(match.chunkId);
    if (!anchor) {
      kept.push(match);
      continue;
    }

    try {
      let chunkPath = chunkFiles.get(anchor.id);
      if (!chunkPath) {
        chunkPath = path.join(input.workDir, `chunk-${anchor.chunkIndex}.mp4`);
        await getStorage().downloadToFile(anchor.storageKey, chunkPath);
        chunkFiles.set(anchor.id, chunkPath);
      }

      // The window is sampled from the anchor chunk's proxy file, so it is
      // clamped to that chunk; a match spilling past the boundary is verified
      // by its opening, which is where the moment was claimed to start.
      const localStart = Math.max(0, match.globalStartSeconds - env.VERIFY_PAD_SECONDS - anchor.globalStartSeconds);
      const localEnd = Math.min(
        anchor.durationSeconds,
        match.globalEndSeconds + env.VERIFY_PAD_SECONDS - anchor.globalStartSeconds,
      );

      const matchDir = path.join(input.workDir, `match-${index}`);
      const frames = await extractWindowFrames(chunkPath, localStart, localEnd, env.VERIFY_FRAMES, matchDir);
      if (frames.length === 0) {
        logger.warn('verification skipped: no frames in window', { matchIndex: index });
        kept.push(match);
        continue;
      }

      const messages = await buildVerifyMessages({
        instruction: input.instruction,
        claimDescription: match.description,
        windowStartSeconds: anchor.globalStartSeconds + localStart,
        windowEndSeconds: anchor.globalStartSeconds + localEnd,
        frames: frames.map((frame) => ({
          globalSeconds: Number((anchor.globalStartSeconds + frame.localSeconds).toFixed(3)),
          filePath: frame.filePath,
        })),
      });

      const raw = await completeWithRetry(messages, { stage: 'verify', matchIndex: index });
      const verdict = parseVerifyResponse(raw);

      if (!verdict) {
        logger.warn('verification reply unreadable; keeping unverified match', { matchIndex: index });
        kept.push(match);
        continue;
      }

      if (!verdict.confirmed) {
        const demoted = Number((match.confidence * 0.35).toFixed(4));
        logger.info('verification rejected match', {
          matchIndex: index,
          start: match.globalStartSeconds,
          end: match.globalEndSeconds,
          demotedConfidence: demoted,
        });
        if (demoted >= env.MIN_MATCH_CONFIDENCE) kept.push({ ...match, confidence: demoted });
        continue;
      }

      // Confirmed: refine to what the footage showed, when a range came back.
      let refined = match;
      if (verdict.startSeconds !== null && verdict.endSeconds !== null) {
        const range = mapLocalRangeToGlobal(
          { globalStartSeconds: 0, globalEndSeconds: input.durationSeconds },
          { startSeconds: verdict.startSeconds, endSeconds: verdict.endSeconds },
          { minDurationSeconds: env.MIN_CLIP_SECONDS, maxDurationSeconds: env.MAX_CLIP_SECONDS },
        );
        if (range) {
          refined = anchorToChunk(
            {
              startSeconds: range.globalStartSeconds,
              endSeconds: range.globalEndSeconds,
              description: match.description,
              confidence: Math.max(match.confidence, verdict.confidence ?? 0),
              quote: match.quote ?? null,
            },
            input.chunks,
            match.source,
          );
        }
      }

      logger.info('verification confirmed match', {
        matchIndex: index,
        start: refined.globalStartSeconds,
        end: refined.globalEndSeconds,
      });
      kept.push(refined);
    } catch (error) {
      // Verification is an accuracy upgrade, never a gate: on any failure the
      // original match survives.
      logger.warn('verification failed; keeping unverified match', { matchIndex: index, err: errorMessage(error) });
      kept.push(match);
    }
  }

  return kept;
}

interface SearchSingleChunkInput {
  chunk: VideoChunk;
  chunkCount: number;
  instruction: string;
  mode: ResolvedSearchMode;
  videoId: string;
  workDir: string;
}

const MATCH_SOURCE: Record<ResolvedSearchMode, MatchSource> = {
  visual: 'visual',
  transcript: 'transcript',
  both: 'multimodal',
};

async function searchSingleChunk(input: SearchSingleChunkInput): Promise<NewClipMatch[]> {
  const { chunk } = input;
  const chunkDir = path.join(input.workDir, `chunk-${chunk.chunkIndex}`);

  // Evidence 1: frames, sampled from the chunk of the analysis proxy.
  let frames: { localSeconds: number; filePath: string }[] = [];
  if (input.mode !== 'transcript') {
    const chunkPath = path.join(chunkDir, 'chunk.mp4');
    await getStorage().downloadToFile(chunk.storageKey, chunkPath);
    frames = await extractFrames(chunkPath, chunk.durationSeconds, env.MINICPM_FRAMES_PER_CHUNK, chunkDir);
    if (frames.length === 0) throw new Error('No frames could be extracted from this chunk');
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

  const response = await searchChunk({
    instruction: input.instruction,
    mode: input.mode,
    chunkIndex: chunk.chunkIndex,
    chunkCount: input.chunkCount,
    chunkDurationSeconds: chunk.durationSeconds,
    frames,
    transcript,
  });

  if (response.warnings.length > 0) {
    logger.warn('model output warnings', {
      chunkIndex: chunk.chunkIndex,
      warnings: response.warnings.slice(0, 5),
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
        logger.warn('discarding out-of-range match', {
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
        source: MATCH_SOURCE[input.mode],
        quote: range.quote,
      } satisfies NewClipMatch,
    ];
  });
}
