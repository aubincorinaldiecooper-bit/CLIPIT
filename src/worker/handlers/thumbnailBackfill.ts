import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { withWorkDir } from '../../lib/workdir.js';
import {
  listMatchesMissingThumbnails,
  listVideosMissingThumbnails,
} from '../../db/repositories/clipRequests.js';
import { attachThumbnails } from '../../services/media/thumbnails.js';
import type { ThumbnailBackfillJob } from '../../queues/index.js';

/**
 * Gives stills to matches that were found before stills existed.
 *
 * Searches attach a thumbnail as they run, so this only ever has historical
 * work to do: results already on a user's screen stay text-only otherwise, and
 * the only way to see a picture would be to pay for the same search twice.
 *
 * No model calls — the frames come from proxies already in storage, so this
 * costs ffmpeg time and nothing else.
 */
export async function handleThumbnailBackfill(job: Job<ThumbnailBackfillJob>): Promise<void> {
  const log = logger.child({ job: 'thumbnail-backfill', jobId: job.id });
  const limit = env.THUMBNAIL_BACKFILL_VIDEO_LIMIT;

  const videos = await listVideosMissingThumbnails(limit + 1);
  if (videos.length === 0) {
    log.info('no matches are missing stills');
    return;
  }

  // Named rather than trimmed silently: a sweep that quietly stops short reads
  // downstream as "everything has a picture now", which is the same class of
  // untruth as reporting an unsearched chunk as searched.
  const remaining = Math.max(0, videos.length - limit);
  const batch = videos.slice(0, limit);

  log.info('backfilling match stills', {
    videos: batch.length,
    matches: batch.reduce((sum, video) => sum + video.missing, 0),
    ...(remaining > 0 ? { videosLeftForNextStart: remaining } : {}),
  });

  const startedAt = performance.now();
  let attached = 0;

  // Sequential on purpose. Each video downloads a whole proxy and decodes
  // frames from it; running several at once on the worker that is also cutting
  // clips and searching would trade a background nicety for foreground latency.
  for (const video of batch) {
    const matches = await listMatchesMissingThumbnails(video.videoId);
    if (matches.length === 0) continue;

    await withWorkDir(`thumbs-${video.videoId}`, async (dir) => {
      attached += await attachThumbnails({
        videoId: video.videoId,
        proxyStorageKey: video.proxyStorageKey,
        matches,
        workDir: dir,
        log,
      });
    });
  }

  log.info('match still backfill complete', {
    videos: batch.length,
    attached,
    elapsedMs: Math.round(performance.now() - startedAt),
    ...(remaining > 0 ? { videosLeftForNextStart: remaining } : {}),
  });
}
