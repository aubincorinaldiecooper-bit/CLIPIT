import type pg from 'pg';
import type { Logger } from '../../lib/logger.js';
import { getClip, restoreClipBoundaries, setClipStatus } from '../../db/repositories/clips.js';
import { markReclipFailed } from '../../db/repositories/reclips.js';
import type { UnknownRender } from '../../db/repositories/unknownRenders.js';
import { enqueueObjectRelease } from '../../queues/index.js';

/** What a Re-clip's failure says; the same words the render itself would have used. */
export const RECLIP_FAILED_MESSAGE = 'The re-cut could not be rendered. The original clip is untouched — try again.';
export const RENDER_FAILED_MESSAGE = 'The render could not be completed. Try again.';

/**
 * Settles a render whose outcome was unknown when its job's last attempt
 * ended, now that the database answers.
 *
 * The row is the evidence, read in this order:
 *
 * 1. A row naming a file NEW to it was written by this render: landed,
 *    whatever its status now — a landed render's row is 'ready' and can
 *    take a Replace or a Re-clip before the sweep runs, which makes it
 *    'generating' again with this render's file still on it; rolling that
 *    back would cancel the newer render.
 * 2. A row no longer 'generating' or 'pending' has been settled by a
 *    render or moved on by something later: left alone.
 * 3. A row written since this render's attempt marked it generating — its
 *    last write of its own before the one whose outcome was lost — was
 *    written by that write (landed, with a key that proves nothing: a
 *    first render at its plain key) or by something later that owns the
 *    row now: left alone either way. "Written since" is the row's version,
 *    a counter every render-state write bumps in place, having moved past
 *    the value the attempt's mark set (see clips.row_version). A record
 *    from before the counter (035, 036) is read against the time it was
 *    recorded, the best it has.
 * 4. Otherwise the write did not land, and the row has been waiting since:
 *    it is rolled back exactly as a failed render would have been:
 * a Re-clip back to its previous boundaries and status with the failure on
 * record, a re-render back to 'ready' with the previous file, a first
 * render to 'failed'. Any other state means something later moved the row
 * on, and it is left alone.
 *
 * First, though, whatever objects the render could not put on record at
 * the time (the queue and the database both refused, and the record on
 * the job would never be read again) are handed to the queue now — before
 * anything else, and a queue that refuses ends the settling here, so the
 * row stays for the next sweep and the objects stay on record.
 *
 * The read and the writes go through `client` when the caller has a
 * transaction — the read locking the row — so the decision, the rollback,
 * the failure it records and the record's removal share one snapshot and
 * land together. (And a read through the pool from inside a transaction
 * would wait for the pool's one connection when there is only one.)
 */
export async function settleUnknownRender(
  render: UnknownRender,
  log: Logger,
  client?: pg.PoolClient,
): Promise<'landed' | 'rolled_back' | 'moved_on' | 'gone'> {
  const clip = await getClip(render.clipId, client);
  const context = { clipId: render.clipId, storageKey: render.storageKey };
  if (render.job.unresolvedKeys?.length) {
    await enqueueObjectRelease(render.job.unresolvedKeys, { videoId: clip?.videoId ?? '', clipId: render.clipId, reason: 'render_outcome_unknown' });
    log.warn('an unknown render\'s objects of unknown ownership are now queued for release', { ...context, keys: render.job.unresolvedKeys });
  }
  if (!clip) {
    log.info('an unknown render\'s clip no longer exists; nothing to settle', context);
    return 'gone';
  }
  // The key proves a landed write only when it is known to be new to the
  // row; a record without a previous key (the 035 code wrote none) proves
  // nothing either way.
  const keyIsNew = render.previousStorageKey !== null && render.storageKey !== render.previousStorageKey;
  if (keyIsNew && clip.storageKey === render.storageKey) {
    log.info('an unknown render had landed; the row names its file', { ...context, status: clip.status });
    return 'landed';
  }
  if (clip.status !== 'generating' && clip.status !== 'pending') {
    log.info('an unknown render\'s row is no longer generating; left as it is', { ...context, status: clip.status });
    return 'moved_on';
  }
  // The mark is the row's version as the attempt's own "generating" write
  // set it, and "written since" is the version having moved past it — not
  // a time. Devin's findings on #83: the record's own time comes after the
  // render's re-reads and their retries, so a Replace or Re-clip that a
  // landed render's row took in between looked like a row that had waited;
  // and a time on the row cannot order the writes either, because now() is
  // a transaction's start — a Replace whose write began a hair before the
  // mark and reached the row after it lands with the older time. The
  // counter is bumped in place, against the row as it stands when the
  // write takes effect, so it rises in the order the writes land.
  const writtenSince = render.rowVersion !== null
    ? clip.rowVersion > render.rowVersion
    : clip.updatedAt.getTime() > render.recordedAt.getTime();
  if (writtenSince) {
    log.info('an unknown render\'s row was written after its attempt began; the render landed or something later owns the row', {
      ...context, status: clip.status, rowVersion: clip.rowVersion, mark: render.rowVersion, updatedAt: clip.updatedAt, recordedAt: render.recordedAt,
    });
    return 'moved_on';
  }

  const { job } = render;
  if (job.reclip) {
    const previous = job.reclip.previous;
    await restoreClipBoundaries(render.clipId, {
      startSeconds: previous.startSeconds,
      endSeconds: previous.endSeconds,
      boundariesEditedAt: previous.boundariesEditedAt ? new Date(previous.boundariesEditedAt) : null,
      status: previous.status,
    }, client);
    await markReclipFailed(job.reclip.matchId, RECLIP_FAILED_MESSAGE, client);
  } else if (clip.storageKey) {
    // A re-render that never landed: the previous file still plays.
    await setClipStatus(render.clipId, 'ready', { errorMessage: RENDER_FAILED_MESSAGE }, client);
  } else {
    await setClipStatus(render.clipId, 'failed', { errorMessage: RENDER_FAILED_MESSAGE }, client);
  }
  log.warn('an unknown render had not landed; rolled back as a failed render', { ...context, reclip: Boolean(job.reclip) });
  return 'rolled_back';
}
