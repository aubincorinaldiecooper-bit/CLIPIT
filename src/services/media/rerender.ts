import type { Logger } from '../../lib/logger.js';
import { getClip } from '../../db/repositories/clips.js';
import { enqueueObjectRelease } from '../../queues/index.js';
import type { RenderedMedia } from '../../db/repositories/verticalMedia.js';
import type { UsageTally } from '../usageTally.js';
import { askModelForFraming, type FramingAsker } from './framing.js';
import { discardUploadedObjects, runVerticalPipeline } from './verticalPipeline.js';
import type { Clip } from '../../domain/types.js';

/**
 * The media a moment delivers: its 9:16 file and the poster cut from it.
 *
 * Every render comes through here — the first one, made when a person keeps
 * a moment, and every re-render after it (a Re-clip's new boundaries, a
 * caption Replace). The card's picture and the 9:16 file are made FROM the
 * cut, so a new cut means new media, or the card shows and the viewer plays
 * a moment its file no longer contains.
 *
 * Ordering is the whole point on a re-render. The new media is made and
 * stored FIRST, at fresh keys beside the old, and the row takes every new key
 * in ONE write (commitRender). A failure anywhere before that write leaves
 * the previous cut and its previous media exactly as they were, the fresh
 * objects are taken back out, and the render's own rollback applies. The old
 * objects go only once the row names the new ones.
 *
 * Who decides the framing depends on which render this is. A FIRST render
 * asks the model: nothing has watched this moment yet, and the crop is the
 * one decision worth paying for. A re-render reuses the decision the first
 * one stored — the boundaries moved by seconds; the subject did not — and a
 * clip that was never framed (cut landscape before the always-vertical rule)
 * keeps its whole frame on a blurred background, without a model call, as
 * it has since that rule arrived.
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
  /** What the framing cost and who answered it, for the render's record. */
  framing: {
    provider: string | null;
    model: string | null;
    sourceAspectRatio: string | null;
    compositionDecisionMs: number;
    derivativeGenerationMs: number;
    posterGenerationMs: number;
  };
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
 * Is this the moment's first render — a clip that has never had a file?
 *
 * The row's canonical key is the test, not `preRendered`: a clip from before
 * the rule change may be pre-rendered and still be re-rendered, and a clip
 * cut on Keep is never pre-rendered and is still rendered for the first time.
 * The one thing every first render has in common is that nothing has been
 * cut for it yet.
 */
export function isFirstRender(clip: Pick<Clip, 'storageKey'>): boolean {
  return clip.storageKey === null;
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
  /** The question that found this moment, for the framing call's cost row. */
  clipRequestId: string | null;
  /** The NEW cut on disk, not yet committed to the row. */
  canonicalPath: string;
  /**
   * The cut's key in storage. Already uploaded: the MiniCPM lane frames from
   * a signed URL to it, so it has to exist before the model is asked.
   */
  canonicalKey: string;
  workDir: string;
  hasAudio: boolean;
  cut: { durationSeconds: number; width: number; height: number };
  /** This render's name, shared with the cut's own key. Absent for a first render. */
  render: string | undefined;
  /** A request's running total, when the render is made inside one. */
  tally?: UsageTally;
  log: Logger;
}): Promise<DeliveredMedia> {
  const { clip, videoId, render } = input;
  const context = { videoId, clipId: clip.id };

  // Every render comes back 9:16, including a re-cut of a clip that was made
  // landscape before the rule (owner, 2026-09-03). The first render asks the
  // model; every later one reuses what that render stored, and a clip that
  // was never framed keeps its whole frame on a blurred background —
  // storedCompositionAnswer's fallback, no model call.
  const askComposition: FramingAsker = isFirstRender(clip)
    ? askModelForFraming({
        videoId,
        clipRequestId: input.clipRequestId,
        canonicalKey: input.canonicalKey,
        durationSeconds: input.cut.durationSeconds,
        workDir: input.workDir,
        tally: input.tally,
      })
    : async () => ({ content: storedCompositionAnswer(clip), provider: 'stored', model: 'first-render' });

  const media = await runVerticalPipeline({
    videoId,
    clipId: clip.id,
    canonicalPath: input.canonicalPath,
    workDir: input.workDir,
    hasAudio: input.hasAudio,
    askComposition,
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
        // Not written by commitRender; a render never changes ownership.
        retentionClass: clip.retentionClass,
      },
    },
    freshKeys: [media.derivativeStorageKey, media.posterStorageKey],
    oldKeys: [clip.derivativeStorageKey, clip.posterStorageKey].filter((key): key is string => typeof key === 'string'),
    discard: (reason) =>
      discardUploadedObjects([media.derivativeStorageKey, media.posterStorageKey], { ...context, reason }),
    framing: {
      provider: media.provider,
      model: media.model,
      sourceAspectRatio: media.sourceAspectRatio,
      compositionDecisionMs: media.compositionDecisionMs,
      derivativeGenerationMs: media.derivativeGenerationMs,
      posterGenerationMs: media.posterGenerationMs,
    },
  };
}
