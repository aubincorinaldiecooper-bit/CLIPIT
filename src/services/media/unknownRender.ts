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
 * The row is the evidence. Naming the render's file — a file NEW to the
 * row — it was written by the render: nothing to do (the release of the
 * previous objects was queued or recorded at the time). A first render
 * retried at the plain key a failed earlier attempt already left on the row
 * proves nothing by its key, so there the status decides: 'ready' was
 * written by a render, and is left alone. Still 'generating' or 'pending'
 * otherwise, the write did not land, and nothing else can have started on
 * the row since —
 * a Re-clip is refused while one is pending, a Replace while the clip is not
 * ready — so it is rolled back exactly as a failed render would have been:
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
 * The writes go through `client` when the caller has a transaction, so the
 * rollback, the failure it records and the record's removal land together.
 */
export async function settleUnknownRender(
  render: UnknownRender,
  log: Logger,
  client?: pg.PoolClient,
): Promise<'landed' | 'rolled_back' | 'moved_on' | 'gone'> {
  const clip = await getClip(render.clipId);
  const context = { clipId: render.clipId, storageKey: render.storageKey };
  if (render.job.unresolvedKeys?.length) {
    await enqueueObjectRelease(render.job.unresolvedKeys, { videoId: clip?.videoId ?? '', clipId: render.clipId, reason: 'render_outcome_unknown' });
    log.warn('an unknown render\'s objects of unknown ownership are now queued for release', { ...context, keys: render.job.unresolvedKeys });
  }
  if (!clip) {
    log.info('an unknown render\'s clip no longer exists; nothing to settle', context);
    return 'gone';
  }
  const keyIsNew = render.storageKey !== render.previousStorageKey;
  if (clip.storageKey === render.storageKey && keyIsNew) {
    log.info('an unknown render had landed; the row names its file', context);
    return 'landed';
  }
  if (clip.status !== 'generating' && clip.status !== 'pending') {
    // 'ready' at the plain key is a landed first render; anything else was
    // moved on by something later. Either way, not ours to touch.
    log.info('an unknown render\'s row is no longer generating; left as it is', { ...context, status: clip.status });
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
