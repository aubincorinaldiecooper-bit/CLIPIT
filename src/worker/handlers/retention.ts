import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger, type Logger } from '../../lib/logger.js';
import { getStorage } from '../../services/storage/s3.js';
import { claimUnkeptPreRenderedMedia } from '../../db/repositories/verticalMedia.js';
import { storageKeysInUse } from '../../db/repositories/objectOwnership.js';
import { listVideosWithUnreachableFootage } from '../../db/repositories/videos.js';
import { expireVideoFootage } from '../../services/retention.js';
import { enqueueObjectRelease, type RetentionJob } from '../../queues/index.js';
import { drainObjectReleases } from '../../db/repositories/objectReleases.js';
import { drainUnknownRenders } from '../../db/repositories/unknownRenders.js';
import { settleUnknownRender } from '../../services/media/unknownRender.js';

/**
 * Objects a render's row stopped naming, removed now that no signed URL to
 * them can still be live (see enqueueObjectRelease for why the wait).
 *
 * The decision to release was taken an hour or more ago, so it is checked
 * again now, against the rows: a key some row names at this moment is kept,
 * whatever it was queued for. Two things make that necessary. A platform
 * shape discarded by a re-render and asked for again is a new row, and
 * before its keys carried the row's id it landed on the SAME key as the
 * file queued for release. And a render whose write landed while its reply
 * was lost queues both the old objects and its own, and lets this check —
 * once the database answers again — decide which the row kept.
 *
 * If the rows cannot be asked, nothing is removed: the job fails and the
 * queue tries again, hours if it must. One key that will not go must not
 * keep the others; it is named at error level and the job fails so the
 * queue tries again — and if it never goes, the log is the map to the
 * orphan.
 */
async function releaseObjectsNow(
  keys: string[],
  context: { videoId: string; clipId: string; reason: string },
  log: Logger,
): Promise<void> {
  const named = await storageKeysInUse(keys);
  const storage = getStorage();
  const failed: string[] = [];
  let kept = 0;
  for (const key of keys) {
    if (named.has(key)) {
      kept += 1;
      log.warn('a released object is named by a row again; kept', { ...context, key });
      continue;
    }
    try {
      await storage.remove(key);
    } catch (error) {
      failed.push(key);
      log.error('a released object could not be removed; it is orphaned unless a retry succeeds', { ...context, key, err: error });
    }
  }
  log.info('released objects removed', { ...context, removed: keys.length - kept - failed.length, kept, failed: failed.length });
  if (failed.length > 0) {
    throw new Error(`${failed.length} of ${keys.length} released objects could not be removed`);
  }
}

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
  if (job.data.kind === 'release') {
    await releaseObjectsNow(job.data.keys, job.data.context, logger.child({ job: 'release-objects', jobId: job.id }));
    return;
  }

  const log = logger.child({ job: 'retention', jobId: job.id });
  const limit = env.RETENTION_VIDEO_LIMIT;

  // First, whatever a render wrote down because the queue could not be
  // reached, and whatever render could not learn its own outcome: neither
  // must wait on there being footage to sweep.
  await handOverRecordedReleases(log);
  await settleUnknownRenders(log);

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

  await sweepUnkeptPreRenderedMedia(log);
}

/**
 * Renders whose outcome was unknown when their job's last attempt ended
 * (see RenderOutcomeUnknownError): settled by the row's evidence now that
 * the database answers — left alone if the write landed, rolled back as a
 * failed render if it did not. A row that cannot be settled stays for the
 * next sweep.
 */
async function settleUnknownRenders(log: Logger): Promise<void> {
  try {
    const settled = await drainUnknownRenders(env.RETENTION_VIDEO_LIMIT, async (render) => {
      await settleUnknownRender(render, log);
    });
    if (settled > 0) log.info('unknown renders settled', { renders: settled });
  } catch (error) {
    log.warn('unknown renders could not be settled; they stay for the next sweep', { err: error });
  }
}

/**
 * Releases a render wrote down because the queue could not be reached at
 * the time (see recordObjectRelease). This sweep runs from the queue, so
 * the queue is back; each row goes onto it and is deleted only then.
 */
async function handOverRecordedReleases(log: Logger): Promise<void> {
  try {
    const handed = await drainObjectReleases(env.RETENTION_VIDEO_LIMIT, (release) => enqueueObjectRelease(release.keys, release.context));
    if (handed > 0) log.info('recorded releases handed to the queue', { releases: handed });
  } catch (error) {
    // The rows stay; the next sweep tries again.
    log.warn('recorded releases could not be handed to the queue', { err: error });
  }
}

/**
 * Delete the moments we made and nobody kept.
 *
 * Rendering before Keep is what makes the deck appear finished the moment it
 * appears at all. It has a bill attached: asking for three moments renders at
 * least three, and only the ones somebody pressed Keep on were ever wanted.
 * Without this, that bill is permanent and grows with every question asked.
 *
 * Narrow on purpose, and narrow in the QUERY rather than in a filter here:
 * only rows this pipeline made, only ones never approved, only after the same
 * idle period the footage sweep uses. A clip somebody kept, and every clip
 * cut the old way, is invisible to it.
 */
async function sweepUnkeptPreRenderedMedia(log: Logger): Promise<void> {
  // Claims and clears the rows in one statement, then deletes their objects.
  // See claimUnkeptPreRenderedMedia for why that order, and what it costs.
  const rows = await claimUnkeptPreRenderedMedia(env.FOOTAGE_IDLE_SECONDS, env.RETENTION_VIDEO_LIMIT);
  if (rows.length === 0) return;

  const storage = getStorage();
  let objectsDeleted = 0;
  let objectsFailed = 0;

  for (const row of rows) {
    const keys = [row.derivativeStorageKey, row.posterStorageKey, row.storageKey]
      .filter((key): key is string => typeof key === 'string' && key.length > 0);

    for (const key of keys) {
      try {
        await storage.remove(key);
        objectsDeleted += 1;
      } catch (error) {
        objectsFailed += 1;
        // The row no longer names this object, so nothing will retry it —
        // said out loud because it is now an orphan only these logs can find.
        log.warn('an unkept rendered file could not be deleted and is now orphaned', {
          clipId: row.clipId,
          videoId: row.videoId,
          err: error,
        });
      }
    }
  }

  log.info('unkept rendered media swept', {
    clips: rows.length,
    objectsDeleted,
    objectsFailed,
    idleSeconds: env.FOOTAGE_IDLE_SECONDS,
  });
}
