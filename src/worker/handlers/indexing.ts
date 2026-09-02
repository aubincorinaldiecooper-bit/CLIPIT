import path from 'node:path';
import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { withWorkDir } from '../../lib/workdir.js';
import { mapWithConcurrency } from '../../lib/concurrency.js';
import { getStorage } from '../../services/storage/s3.js';
import { describeVideoChunk } from '../../services/search/sceneIndex.js';
import { resetVideoCallPeak, videoCallStats } from '../../services/search/openrouterVideo.js';
import { UsageTally } from '../../services/usageTally.js';
import { recordModelUsage } from '../../db/repositories/usage.js';
import { appendScenes, clearScenes, type NewVideoScene } from '../../db/repositories/scenes.js';
import { findUncoveredRanges } from '../../services/timestamps.js';
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
  // So the peak reported at the end belongs to this read.
  resetVideoCallPeak();
  await setIndexStatus(videoId, 'running', { sceneCount: 0 });
  // A previous attempt's notes go before this one starts, so a retry never
  // leaves half of one read mixed with half of another.
  await clearScenes(videoId);

  try {
    let storedScenes = 0;
    let failedChunks = 0;
    let partialChunks = 0;

    await withWorkDir(`index-${videoId}`, async (dir) => {
      // The real gate is the semaphore inside the video client, which every
      // call carrying video passes through. Matching it here just avoids
      // spawning workers that would only queue behind it.
      const results = await mapWithConcurrency(chunks, env.OPENROUTER_VIDEO_CONCURRENCY, async (chunk) => {
        const chunkPath = path.join(dir, `chunk-${chunk.chunkIndex}.mp4`);
        await getStorage().downloadToFile(chunk.storageKey, chunkPath);

        const result = await describeVideoChunk({
          chunkIndex: chunk.chunkIndex,
          chunkCount: chunks.length,
          chunkDurationSeconds: chunk.durationSeconds,
          videoPath: chunkPath,
          videoStorageKey: chunk.storageKey,
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
        const readScenes: NewVideoScene[] = result.scenes.map((scene) => ({
          startSeconds: Number((chunk.globalStartSeconds + scene.startSeconds).toFixed(3)),
          endSeconds: Number((chunk.globalStartSeconds + scene.endSeconds).toFixed(3)),
          description: scene.description,
        }));

        // Written now, not at the end. A question asked a minute after upload
        // can then be answered from the part already read, with the unread
        // part named — which beats two minutes of nothing. The offset keeps
        // the stored order stable while chunks finish out of order.
        await appendScenes(videoId, readScenes, chunk.chunkIndex * 1000);
        storedScenes += readScenes.length;
        await setIndexStatus(videoId, 'running', { sceneCount: storedScenes });

        // A valid scene list can still leave most of a chunk undescribed — one
        // 0-10s scene for a 120 second chunk parses perfectly. Left unsaid,
        // those 110 seconds are indistinguishable from a stretch where nothing
        // happened, and every later question about them would be answered from
        // notes that never covered them.
        const uncovered = findUncoveredRanges(result.scenes, chunk.durationSeconds);
        const uncoveredSeconds = uncovered.reduce((sum, gap) => sum + (gap.endSeconds - gap.startSeconds), 0);
        if (uncoveredSeconds > 0) {
          partialChunks += 1;
          log.warn('chunk was only partly described', {
            chunkIndex: chunk.chunkIndex,
            covers: `${chunk.globalStartSeconds.toFixed(0)}-${chunk.globalEndSeconds.toFixed(0)}s`,
            uncoveredSeconds: Number(uncoveredSeconds.toFixed(1)),
            ofSeconds: Number(chunk.durationSeconds.toFixed(1)),
          });
        }

        log.info('chunk read', {
          chunkIndex: chunk.chunkIndex,
          covers: `${chunk.globalStartSeconds.toFixed(0)}-${chunk.globalEndSeconds.toFixed(0)}s`,
          scenes: result.scenes.length,
          uncoveredSeconds: Number(uncoveredSeconds.toFixed(1)),
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

    if (storedScenes === 0) {
      // Nothing was read at all. Recording this as a ready, empty index would
      // tell every later search that the video contains nothing.
      await setIndexStatus(videoId, 'failed', {
        error: `None of the ${chunks.length} segments could be read`,
        sceneCount: 0,
      });
      log.error('indexing produced no notes at all', { chunks: chunks.length });
      return;
    }

    // Partial notes are still notes, but what is missing is named rather than
    // implied. The search recomputes the holes from the scenes themselves, so
    // this string is for a human reading the row, not a machine.
    const unread = [
      failedChunks > 0 ? `${failedChunks} of ${chunks.length} segments could not be read` : null,
      partialChunks > 0 ? `${partialChunks} were only partly described` : null,
    ].filter(Boolean).join('; ');

    await setIndexStatus(videoId, 'ready', {
      sceneCount: storedScenes,
      error: unread || null,
      // Recorded exactly, so "did that change help?" is answerable from the
      // database rather than from whoever last read the logs.
      indexMs: Math.round(performance.now() - startedAt),
    });

    // What reading this video cost, once, against what it saves every question
    // asked of it afterwards.
    const gate = videoCallStats();
    log.info('video read into notes', {
      path: 'background_visual_index',
      fullVisualIndexCompletionMs: Math.round(performance.now() - startedAt),
      scenes: storedScenes,
      chunks: chunks.length,
      failedChunks,
      partialChunks,
      elapsedMs: Math.round(performance.now() - startedAt),
      // Measured, not configured. `concurrencyReached` below
      // `concurrencyAllowed` means something else was the bottleneck — which
      // is exactly how a read raised to eight ran at four unnoticed.
      concurrencyAllowed: gate.limit,
      concurrencyReached: gate.peak,
      // Seconds of video read per second of waiting: the one number that says
      // whether a change to any of this actually helped.
      secondsOfVideoPerSecond: video.durationSeconds
        ? Number((video.durationSeconds / ((performance.now() - startedAt) / 1000)).toFixed(2))
        : null,
      ...tally.summary(),
    });
  } catch (error) {
    const message = errorMessage(error);
    log.error('indexing failed', { err: error });
    await setIndexStatus(videoId, 'failed', { error: message });
    throw error;
  }
}
