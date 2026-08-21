import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { listVideosWithUnreachableFootage } from '../../db/repositories/videos.js';
import { expireVideoFootage } from '../../services/retention.js';
import type { RetentionJob } from '../../queues/index.js';

/**
 * Removes footage nobody can reach any more.
 *
 * A guest session lives in the browser tab, so a closed browser means that
 * video can never be opened again — not by us, not by the person who uploaded
 * it. This is the sweep that acts on that: it finds videos whose session has
 * gone quiet and deletes the bytes, keeping only what teaches us something.
 *
 * Bounded per run and it says what it left, because a sweep that quietly stops
 * short reads as "everything is tidy" while the bill keeps growing.
 */
export async function handleRetention(job: Job<RetentionJob>): Promise<void> {
  const log = logger.child({ job: 'retention', jobId: job.id });
  const limit = env.RETENTION_VIDEO_LIMIT;

  const videos = await listVideosWithUnreachableFootage(env.FOOTAGE_IDLE_SECONDS, limit + 1);
  if (videos.length === 0) {
    log.info('no footage to remove');
    return;
  }

  const remaining = Math.max(0, videos.length - limit);
  const batch = videos.slice(0, limit);

  log.info('removing footage for ended sessions', {
    videos: batch.length,
    idleSeconds: env.FOOTAGE_IDLE_SECONDS,
    ...(remaining > 0 ? { videosLeftForNextSweep: remaining } : {}),
  });

  const startedAt = performance.now();
  let objectsDeleted = 0;
  let objectsFailed = 0;

  // Sequential: this is background tidying and must never take throughput from
  // a search or an upload someone is waiting on.
  for (const video of batch) {
    try {
      const result = await expireVideoFootage(video.videoId, log);
      objectsDeleted += result.objectsDeleted;
      objectsFailed += result.objectsFailed;
    } catch (error) {
      // One video that will not tidy up must not stop the others.
      log.warn('could not remove footage for a video', { videoId: video.videoId, err: error });
    }
  }

  log.info('footage sweep complete', {
    videos: batch.length,
    objectsDeleted,
    objectsFailed,
    elapsedMs: Math.round(performance.now() - startedAt),
    ...(remaining > 0 ? { videosLeftForNextSweep: remaining } : {}),
  });
}
