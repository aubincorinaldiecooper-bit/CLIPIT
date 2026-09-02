import type { Logger } from '../../lib/logger.js';
import { getClip } from '../../db/repositories/clips.js';
import { enqueueObjectRelease } from '../../queues/index.js';
import type { RenderedMedia } from '../../db/repositories/verticalMedia.js';
import { discardUploadedObjects, runOriginalPipeline, runVerticalPipeline } from './verticalPipeline.js';
import type { Clip } from '../../domain/types.js';

/**
 * Re-rendering a moment that was cut on find.
 *
 * A Re-clip or a caption Replace puts a different file under the same clip
 * id. The card's picture — and for a vertical moment the 9:16 file itself —
 * were made FROM the cut, so they must be made again from the new one, or
 * the card shows, and the viewer plays, a moment its file no longer contains.
 *
 * Ordering is the whole point. The new media is made and stored FIRST, at
 * fresh keys beside the old, before the cut itself is stored — also at a
 * fresh key — and the row takes every new key in ONE write (commitRender).
 * A failure anywhere before that write leaves the previous cut and its
 * previous media exactly as they were, the fresh objects are taken back out,
 * and the render's own rollback applies. The old objects go only once the
 * row names the new ones.
 *
 * Nothing here asks the model anything: a vertical moment is reframed with
 * the decision its first render stored. The boundaries moved by seconds; the
 * subject did not.
 */
export interface DeliveredMedia {
  /** What commitRender writes beside the new cut. */
  media: RenderedMedia;
  /** The objects this render made — the only ones a failure may remove. */
  freshKeys: string[];
  /** The objects the row named before — released once it names the new ones. */
  oldKeys: string[];
  /** The new cut was not committed: take this render's objects back out. */
  discard(reason: string): Promise<void>;
}

/** What the first render decided, said back in the words the pipeline reads. */
export function storedCompositionAnswer(clip: Pick<Clip, 'compositionMode' | 'focalX' | 'focalY'>): string {
  if (
    clip.compositionMode === 'smart_crop'
    && typeof clip.focalX === 'number'
    && typeof clip.focalY === 'number'
  ) {
    return JSON.stringify({ composition_mode: 'smart_crop', crop_safe: true, focal_x: clip.focalX, focal_y: clip.focalY });
  }
  // Whole-frame modes, and anything unreadable, keep the whole frame.
  return JSON.stringify({ composition_mode: 'blurred_background', crop_safe: false });
}

/**
 * Objects the row no longer names are queued for removal — not removed here.
 * A signed URL to any of them handed out before the row changed may still be
 * in someone's hands (a publisher downloading a shaped copy), so they go only
 * once that lifetime has passed; see enqueueObjectRelease. Keys the row still
 * names (the same key reused) stay. Never silent: an object no row names is
 * invisible to every sweep, so if even queuing fails the keys are logged.
 */
export async function releaseObjects(
  oldKeys: Array<string | null | undefined>,
  keep: string[],
  context: { videoId: string; clipId: string },
  log: Logger,
  reason = 'superseded_by_rerender',
): Promise<void> {
  const keys = oldKeys.filter((key): key is string => typeof key === 'string' && key.length > 0 && !keep.includes(key));
  if (keys.length === 0) return;
  try {
    await enqueueObjectRelease(keys, { ...context, reason });
  } catch (error) {
    log.error('a previous render\'s objects could not be queued for removal; they are orphaned', { ...context, keys, err: error });
  }
}

export async function renderDeliveredMedia(input: {
  clip: Clip;
  videoId: string;
  /** The NEW cut on disk, not yet stored. */
  canonicalPath: string;
  workDir: string;
  hasAudio: boolean;
  cut: { durationSeconds: number; width: number; height: number };
  /** This render's name, shared with the cut's own key. Absent for a first render. */
  render: string | undefined;
  log: Logger;
}): Promise<DeliveredMedia | null> {
  const { clip, videoId, render } = input;
  // A moment cut on demand never had delivered media; there is nothing to remake.
  if (!clip.preRendered) return null;

  const context = { videoId, clipId: clip.id };

  // Rows older than the column all came from the vertical pipeline.
  if ((clip.presentation ?? 'vertical') === 'original') {
    const poster = await runOriginalPipeline({
      videoId,
      clipId: clip.id,
      canonicalPath: input.canonicalPath,
      workDir: input.workDir,
      durationSeconds: input.cut.durationSeconds,
      width: input.cut.width,
      height: input.cut.height,
      render,
      snapshotPosterKey: clip.posterStorageKey,
      currentPosterKey: async () => (await getClip(clip.id))?.posterStorageKey ?? null,
    });
    return {
      media: {
        kind: 'original',
        poster: {
          posterStorageKey: poster.posterStorageKey,
          posterTimestampSeconds: poster.posterTimestampSeconds,
          sourceWidth: poster.sourceWidth,
          sourceHeight: poster.sourceHeight,
          posterGenerationMs: poster.posterGenerationMs,
        },
      },
      freshKeys: [poster.posterStorageKey],
      oldKeys: [clip.posterStorageKey].filter((key): key is string => typeof key === 'string'),
      discard: (reason) => discardUploadedObjects([poster.posterStorageKey], { ...context, reason }),
    };
  }

  const media = await runVerticalPipeline({
    videoId,
    clipId: clip.id,
    canonicalPath: input.canonicalPath,
    workDir: input.workDir,
    hasAudio: input.hasAudio,
    // The first render's decision, not a new one: no model call.
    askComposition: async () => ({ content: storedCompositionAnswer(clip), provider: 'stored', model: 'first-render' }),
    render,
    snapshotDerivativeKey: clip.derivativeStorageKey,
    currentDerivativeKey: async () => (await getClip(clip.id))?.derivativeStorageKey ?? null,
  });
  return {
    media: {
      kind: 'vertical',
      media: {
        compositionMode: media.compositionMode,
        focalX: media.focalX,
        focalY: media.focalY,
        derivativeStorageKey: media.derivativeStorageKey,
        posterStorageKey: media.posterStorageKey,
        posterTimestampSeconds: media.posterTimestampSeconds,
        sourceWidth: media.sourceWidth,
        sourceHeight: media.sourceHeight,
        outputWidth: media.outputWidth,
        outputHeight: media.outputHeight,
        canonicalGenerationMs: null,
        compositionDecisionMs: media.compositionDecisionMs,
        derivativeGenerationMs: media.derivativeGenerationMs,
        posterGenerationMs: media.posterGenerationMs,
        // Not written by commitRender; a re-render never changes ownership.
        retentionClass: clip.retentionClass,
      },
    },
    freshKeys: [media.derivativeStorageKey, media.posterStorageKey],
    oldKeys: [clip.derivativeStorageKey, clip.posterStorageKey].filter((key): key is string => typeof key === 'string'),
    discard: (reason) =>
      discardUploadedObjects([media.derivativeStorageKey, media.posterStorageKey], { ...context, reason }),
  };
}
