import path from 'node:path';
import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { errorMessage, ExternalServiceError } from '../../lib/errors.js';
import { withWorkDir } from '../../lib/workdir.js';
import { mapWithConcurrency } from '../../lib/concurrency.js';
import { getStorage } from '../../services/storage/s3.js';
import { extractFrames } from '../../services/media/ffmpeg.js';
import { completeWithRetry } from '../../services/search/minicpm.js';
import { buildSceneIndexMessages, parseSceneResponse } from '../../services/search/sceneIndex.js';
import { mapLocalRangeToGlobal } from '../../services/timestamps.js';
import { getVideo, listChunks, setIndexStatus } from '../../db/repositories/videos.js';
import { replaceScenes, type NewVideoScene } from '../../db/repositories/scenes.js';
import { recordModelUsage } from '../../db/repositories/usage.js';
import type { IndexingJob } from '../../queues/index.js';
import type { VideoChunk } from '../../domain/types.js';

/**
 * Builds the scene index: the one pass where the model actually watches the
 * video. Frames are sent in small batches so no request approaches a context
 * window, and a failed batch or chunk degrades coverage instead of failing
 * the video — the transcript and the remaining scenes still work.
 */
export async function handleIndexing(job: Job<IndexingJob>): Promise<void> {
  const { videoId } = job.data;
  const log = logger.child({ job: 'indexing', videoId });

  const video = await getVideo(videoId);
  if (!video) {
    log.warn('video no longer exists, dropping job');
    return;
  }
  if (video.indexStatus === 'ready') {
    log.info('video already indexed, skipping');
    return;
  }

  await setIndexStatus(videoId, 'running');

  try {
    const chunks = await listChunks(videoId);
    if (chunks.length === 0) throw new Error('Video has no analysis chunks to index');

    const scenes: NewVideoScene[] = [];
    const failures: string[] = [];
    let chunksDone = 0;

    await withWorkDir(`index-${videoId}`, async (dir) => {
      const results = await mapWithConcurrency(chunks, env.INDEXING_CONCURRENCY, async (chunk) => {
        const found = await indexSingleChunk({ chunk, chunkCount: chunks.length, workDir: dir, videoId, log });
        scenes.push(...found);
        chunksDone += 1;
        await job.updateProgress({
          stage: 'indexing',
          percent: Math.round((100 * chunksDone) / chunks.length),
          chunksCompleted: chunksDone,
          chunksTotal: chunks.length,
          scenes: scenes.length,
        });
      });

      for (const [index, result] of results.entries()) {
        if (result.status !== 'rejected') continue;
        const message = errorMessage(result.reason);
        log.warn('chunk indexing failed', { chunkIndex: chunks[index]!.chunkIndex, err: result.reason });
        failures.push(message);
      }
    });

    if (failures.length === chunks.length) {
      throw new ExternalServiceError(
        'minicpm',
        `Every chunk failed to index (${failures.length}/${chunks.length}): ${failures[0]}`,
        // If every chunk failed the same way, the cause is configuration
        // (key, model, credits) — retrying the job re-fails identically.
        { retryable: false },
      );
    }

    const stored = await replaceScenes(videoId, scenes);
    await setIndexStatus(videoId, 'ready', { sceneCount: stored });

    log.info('scene index built', {
      scenes: stored,
      chunks: chunks.length,
      failedChunks: failures.length,
    });
  } catch (error) {
    const message = errorMessage(error);
    log.error('indexing failed', { err: error });
    await setIndexStatus(videoId, 'failed', { error: message });
    throw error;
  }
}

interface IndexSingleChunkInput {
  chunk: VideoChunk;
  chunkCount: number;
  workDir: string;
  videoId: string;
  log: ReturnType<typeof logger.child>;
}

async function indexSingleChunk(input: IndexSingleChunkInput): Promise<NewVideoScene[]> {
  const { chunk, log } = input;
  const chunkDir = path.join(input.workDir, `chunk-${chunk.chunkIndex}`);
  const chunkPath = path.join(chunkDir, 'chunk.mp4');

  log.info('indexing chunk', { chunkIndex: chunk.chunkIndex, stage: 'download' });
  await getStorage().downloadToFile(chunk.storageKey, chunkPath);

  log.info('indexing chunk', { chunkIndex: chunk.chunkIndex, stage: 'frames' });
  const frames = await extractFrames(chunkPath, chunk.durationSeconds, env.INDEX_FRAMES_PER_CHUNK, chunkDir);
  if (frames.length === 0) throw new Error('No frames could be extracted from this chunk');

  const scenes: NewVideoScene[] = [];
  const batchSize = env.INDEX_FRAMES_PER_CALL;

  for (let offset = 0; offset < frames.length; offset += batchSize) {
    const batch = frames.slice(offset, offset + batchSize);
    log.info('indexing chunk', {
      chunkIndex: chunk.chunkIndex,
      stage: 'describe',
      batch: `${offset / batchSize + 1}/${Math.ceil(frames.length / batchSize)}`,
      frames: batch.length,
    });

    const messages = await buildSceneIndexMessages({
      chunkIndex: chunk.chunkIndex,
      chunkCount: input.chunkCount,
      frames: batch,
    });

    const raw = await completeWithRetry(messages, { chunkIndex: chunk.chunkIndex, stage: 'index' }, (usage) => {
      void recordModelUsage({ ...usage, stage: 'indexing', videoId: input.videoId, clipRequestId: null });
    });
    const { scenes: parsed, warnings } = parseSceneResponse(raw);

    if (warnings.length > 0) {
      log.warn('scene index warnings', { chunkIndex: chunk.chunkIndex, warnings: warnings.slice(0, 5) });
    }

    for (const scene of parsed) {
      // The model reports chunk-local seconds; the index stores source time.
      // The same validated mapping used for matches repairs and clamps here.
      const range = mapLocalRangeToGlobal(
        chunk,
        { startSeconds: scene.startSeconds, endSeconds: scene.endSeconds },
        { minDurationSeconds: 0.5, maxDurationSeconds: chunk.durationSeconds },
      );
      if (!range) {
        log.warn('discarding out-of-range scene', {
          chunkIndex: chunk.chunkIndex,
          start: scene.startSeconds,
          end: scene.endSeconds,
        });
        continue;
      }
      scenes.push({
        startSeconds: range.globalStartSeconds,
        endSeconds: range.globalEndSeconds,
        description: scene.description,
      });
    }
  }

  return scenes;
}
