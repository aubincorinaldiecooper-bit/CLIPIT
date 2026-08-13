import path from 'node:path';
import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { withWorkDir } from '../../lib/workdir.js';
import { mapWithConcurrency } from '../../lib/concurrency.js';
import { getStorage } from '../../services/storage/s3.js';
import { extractFrames } from '../../services/media/ffmpeg.js';
import { searchChunk } from '../../services/search/minicpm.js';
import { resolveSearchMode } from '../../services/search/instructionMode.js';
import type { TranscriptLine } from '../../services/search/prompt.js';
import { mapGlobalRangeToChunk, mapLocalRangeToGlobal, mergeOverlappingRanges } from '../../services/timestamps.js';
import { getVideo, listChunks } from '../../db/repositories/videos.js';
import { listTranscriptSegmentsInRange } from '../../db/repositories/transcripts.js';
import {
  deleteMatches,
  finishClipRequest,
  getClipRequest,
  insertMatches,
  recordChunkCompleted,
  recordChunkFailure,
  startClipRequest,
  type NewClipMatch,
} from '../../db/repositories/clipRequests.js';
import { enqueueClipSearch, type ClipSearchJob } from '../../queues/index.js';
import type { MatchSource, ResolvedSearchMode, VideoChunk } from '../../domain/types.js';

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

    await startClipRequest(clipRequestId, { chunksTotal: chunks.length, resolvedMode: resolved.mode });
    // Clear anything from a previous attempt so a retry cannot double-insert.
    await deleteMatches(clipRequestId);

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

      const failed = results.filter((result) => result.status === 'rejected').length;

      if (failed === chunks.length) {
        throw new Error(`Every chunk failed to search (${failed}/${chunks.length})`);
      }

      await finishClipRequest(clipRequestId, 'completed');
      log.info('clip search complete', { matches: totalMatches, failedChunks: failed });
    });
  } catch (error) {
    const message = errorMessage(error);
    log.error('clip search failed', { err: error });
    await finishClipRequest(clipRequestId, 'failed', message);
    throw error;
  }
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
