import path from 'node:path';
import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { withWorkDir } from '../../lib/workdir.js';
import { mapWithConcurrency } from '../../lib/concurrency.js';
import { getStorage } from '../../services/storage/s3.js';
import { describeVideoChunk } from '../../services/search/sceneIndex.js';
import { UsageTally } from '../../services/usageTally.js';
import { recordModelUsage } from '../../db/repositories/usage.js';
import { replaceScenes, type NewVideoScene } from '../../db/repositories/scenes.js';
import { getVideo, listChunks, setIndexStatus } from '../../db/repositories/videos.js';
import type { IndexingJob } from '../../queues/index.js';

/**
 * Reads a video once, at upload, into notes.
 *
 * Every question used to re-read the entire video: ten calls carrying real MP4
 * bytes, two minutes of waiting, and the same money each time — for a user who
 * asks five to twenty questions of one video. This runs the model over the
 * video ONCE and writes down what is in it, so a question can be answered from
 * text and the footage revisited only when the notes cannot settle it.
 *
 * A chunk that fails is recorded and skipped, never fatal: notes covering most
 * of a video are worth having. What must never happen is a silent hole — a
 * chunk missing from the index is a stretch nothing can be recalled about, and
 * the search has to know that rather than read the silence as absence.
 */
export async function handleIndexing(job: Job<IndexingJob>): Promise<void> {
  const { videoId } = job.data;
  const log = logger.child({ job: 'indexing', videoId });

  const video = await getVideo(videoId);
  if (!video) {
    log.warn('video no longer exists, dropping index job');
    return;
  }

  const chunks = await listChunks(videoId);
  if (chunks.length === 0) {
    await setIndexStatus(videoId, 'failed', { error: 'Video has no analysis chunks to read' });
    return;
  }

  const tally = new UsageTally();
  const startedAt = performance.now();
  await setIndexStatus(videoId, 'running');

  try {
    const scenes: NewVideoScene[] = [];
    let failedChunks = 0;

    await withWorkDir(`index-${videoId}`, async (dir) => {
      const results = await mapWithConcurrency(chunks, env.OPENROUTER_VIDEO_CONCURRENCY, async (chunk) => {
        const chunkPath = path.join(dir, `chunk-${chunk.chunkIndex}.mp4`);
        await getStorage().downloadToFile(chunk.storageKey, chunkPath);

        const result = await describeVideoChunk({
          chunkIndex: chunk.chunkIndex,
          chunkCount: chunks.length,
          chunkDurationSeconds: chunk.durationSeconds,
          videoPath: chunkPath,
          onUsage: (usage) => {
            tally.add(usage);
            void recordModelUsage({ ...usage, stage: 'indexing', videoId });
          },
        });

        if (result.warnings.length > 0) {
          log.warn('scene output warnings', {
            chunkIndex: chunk.chunkIndex,
            warnings: result.warnings.slice(0, 5),
          });
        }

        // Zero scenes is not "nothing happens here" — a two-minute stretch of
        // video always contains something. It means the read failed, so it is
        // treated as a failed chunk rather than as an empty one.
        if (result.scenes.length === 0) {
          log.warn('chunk produced no scenes', {
            chunkIndex: chunk.chunkIndex,
            covers: `${chunk.globalStartSeconds.toFixed(0)}-${chunk.globalEndSeconds.toFixed(0)}s`,
            rawResponse: result.rawResponse.slice(0, 300),
          });
          throw new Error(`Chunk ${chunk.chunkIndex} produced no scenes`);
        }

        // Chunk-local seconds become source seconds here, once, so nothing
        // downstream has to know a chunk grid ever existed.
        for (const scene of result.scenes) {
          scenes.push({
            startSeconds: Number((chunk.globalStartSeconds + scene.startSeconds).toFixed(3)),
            endSeconds: Number((chunk.globalStartSeconds + scene.endSeconds).toFixed(3)),
            description: scene.description,
          });
        }

        log.info('chunk read', {
          chunkIndex: chunk.chunkIndex,
          covers: `${chunk.globalStartSeconds.toFixed(0)}-${chunk.globalEndSeconds.toFixed(0)}s`,
          scenes: result.scenes.length,
        });

        return result.scenes.length;
      });

      for (const [index, result] of results.entries()) {
        if (result.status !== 'rejected') continue;
        failedChunks += 1;
        log.warn('chunk could not be read', {
          chunkIndex: chunks[index]!.chunkIndex,
          err: result.reason,
        });
      }
    });

    if (scenes.length === 0) {
      // Nothing was read at all. Recording this as a ready, empty index would
      // tell every later search that the video contains nothing.
      await setIndexStatus(videoId, 'failed', {
        error: `None of the ${chunks.length} segments could be read`,
        sceneCount: 0,
      });
      log.error('indexing produced no notes at all', { chunks: chunks.length });
      return;
    }

    const stored = await replaceScenes(videoId, scenes);

    // Partial notes are still notes, but the gap is recorded rather than
    // implied: a search must be able to tell "the notes say nothing about
    // that" from "part of this video was never read".
    await setIndexStatus(videoId, 'ready', {
      sceneCount: stored,
      error: failedChunks > 0 ? `${failedChunks} of ${chunks.length} segments could not be read` : null,
    });

    // What reading this video cost, once, against what it saves every question
    // asked of it afterwards.
    log.info('video read into notes', {
      scenes: stored,
      chunks: chunks.length,
      failedChunks,
      elapsedMs: Math.round(performance.now() - startedAt),
      ...tally.summary(),
    });
  } catch (error) {
    const message = errorMessage(error);
    log.error('indexing failed', { err: error });
    await setIndexStatus(videoId, 'failed', { error: message });
    throw error;
  }
}
