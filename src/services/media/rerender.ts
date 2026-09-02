import { randomUUID } from 'node:crypto';
import type { Logger } from '../../lib/logger.js';
import { getStorage } from '../storage/s3.js';
import { getClip } from '../../db/repositories/clips.js';
import { setPosterFromCut, setVerticalMedia } from '../../db/repositories/verticalMedia.js';
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
 * fresh keys beside the old, and only once the new cut is stored and its row
 * written does the row take the new keys and the old objects go. A failure
 * anywhere before that leaves the previous cut and its previous media
 * exactly as they were, and the render's own rollback applies.
 *
 * Nothing here asks the model anything: a vertical moment is reframed with
 * the decision its first render stored. The boundaries moved by seconds; the
 * subject did not.
 */
export interface DeliveredMediaRefresh {
  /** The new cut is stored and its row written: point the row at the new media, then let the old objects go. */
  commit(): Promise<void>;
  /** The new cut was not stored: take the new objects back out. */
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

export async function renderDeliveredMedia(input: {
  clip: Clip;
  videoId: string;
  /** The NEW cut on disk, not yet stored. */
  canonicalPath: string;
  workDir: string;
  hasAudio: boolean;
  cut: { durationSeconds: number; width: number; height: number };
  log: Logger;
}): Promise<DeliveredMediaRefresh | null> {
  const { clip, videoId, log } = input;
  // A moment cut on demand never had delivered media; there is nothing to remake.
  if (!clip.preRendered) return null;

  const render = randomUUID().slice(0, 8);
  const context = { videoId, clipId: clip.id };

  // Old objects go only after the row names the new ones. Best-effort, and
  // never silent: an object the row no longer names is invisible to every
  // sweep, so a failed removal is logged with its key.
  const releaseOld = async (oldKeys: Array<string | null>, newKeys: string[]) => {
    for (const key of oldKeys) {
      if (!key || newKeys.includes(key)) continue;
      try {
        await getStorage().remove(key);
      } catch (error) {
        log.error('previous delivered media could not be removed; the object is orphaned', { key, err: error });
      }
    }
  };

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
      commit: async () => {
        await setPosterFromCut(clip.id, {
          posterStorageKey: poster.posterStorageKey,
          posterTimestampSeconds: poster.posterTimestampSeconds,
          sourceWidth: poster.sourceWidth,
          sourceHeight: poster.sourceHeight,
          posterGenerationMs: poster.posterGenerationMs,
        });
        await releaseOld([clip.posterStorageKey], [poster.posterStorageKey]);
      },
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
    commit: async () => {
      await setVerticalMedia(clip.id, {
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
        // Whatever it was: a kept moment stays kept, an offered one stays offered.
        retentionClass: clip.retentionClass,
      });
      await releaseOld(
        [clip.derivativeStorageKey, clip.posterStorageKey],
        [media.derivativeStorageKey, media.posterStorageKey],
      );
    },
    discard: (reason) =>
      discardUploadedObjects([media.derivativeStorageKey, media.posterStorageKey], { ...context, reason }),
  };
}
