import type { Logger } from '../../lib/logger.js';
import { getClip, restoreClipBoundaries, setClipStatus } from '../../db/repositories/clips.js';
import { markReclipFailed } from '../../db/repositories/reclips.js';
import type { UnknownRender } from '../../db/repositories/unknownRenders.js';

/** What a Re-clip's failure says; the same words the render itself would have used. */
export const RECLIP_FAILED_MESSAGE = 'The re-cut could not be rendered. The original clip is untouched — try again.';
export const RENDER_FAILED_MESSAGE = 'The render could not be completed. Try again.';

/**
 * Settles a render whose outcome was unknown when its job's last attempt
 * ended, now that the database answers.
 *
 * The row is the evidence. Naming the render's file, it was written by the
 * render: nothing to do (the release of the previous objects was queued or
 * recorded at the time). Still 'generating' or 'pending' without it, the
 * write did not land, and nothing else can have started on the row since —
 * a Re-clip is refused while one is pending, a Replace while the clip is not
 * ready — so it is rolled back exactly as a failed render would have been:
 * a Re-clip back to its previous boundaries and status with the failure on
 * record, a re-render back to 'ready' with the previous file, a first
 * render to 'failed'. Any other state means something later moved the row
 * on, and it is left alone.
 */
export async function settleUnknownRender(render: UnknownRender, log: Logger): Promise<'landed' | 'rolled_back' | 'moved_on' | 'gone'> {
  const clip = await getClip(render.clipId);
  const context = { clipId: render.clipId, storageKey: render.storageKey };
  if (!clip) {
    log.info('an unknown render\'s clip no longer exists; nothing to settle', context);
    return 'gone';
  }
  if (clip.storageKey === render.storageKey) {
    log.info('an unknown render had landed; the row names its file', context);
    return 'landed';
  }
  if (clip.status !== 'generating' && clip.status !== 'pending') {
    log.info('an unknown render\'s row has moved on since; left as it is', { ...context, status: clip.status });
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
    });
    await markReclipFailed(job.reclip.matchId, RECLIP_FAILED_MESSAGE);
  } else if (clip.storageKey) {
    // A re-render that never landed: the previous file still plays.
    await setClipStatus(render.clipId, 'ready', { errorMessage: RENDER_FAILED_MESSAGE });
  } else {
    await setClipStatus(render.clipId, 'failed', { errorMessage: RENDER_FAILED_MESSAGE });
  }
  log.warn('an unknown render had not landed; rolled back as a failed render', { ...context, reclip: Boolean(job.reclip) });
  return 'rolled_back';
}
