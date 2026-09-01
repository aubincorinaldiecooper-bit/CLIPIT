import { aspectRatioLabel, focusPctForCrop, type CompositionMode } from '../services/media/composition.js';
import { reframeWindow } from '../services/media/reframe.js';
import { isCreatorVisible, type DerivativeStatus } from '../services/media/verticalVisibility.js';

/**
 * ONE place that decides what a clip's media looks like to a client.
 *
 * Centralised on purpose. The frontend contract this targets was specified as
 * commit b7e0fa3, which does not exist in CLIPITFRONTEND — I checked every
 * branch and remote, and none of these field names appear anywhere in that
 * repository. So the names below are the ones the brief itself wrote out, and
 * they are wrong until someone confirms them.
 *
 * Keeping the shape in a single function is the hedge: if the real frontend
 * types differ, reconciling is an edit here, not a search through every route
 * and worker that ever touched a clip.
 */

/** The exact shape a client receives. Field names per the agreed contract. */
/**
 * How a moment is framed — the one definition the thumbnail, the card, the
 * Preview and the export all derive from.
 *
 * `focusPct` is the number a CSS `object-position` wants: 0..100 along the
 * axis being cut (horizontal for a landscape source cropped to 9:16). `crop`
 * is the exact window the export kept, normalised against the source frame
 * so it means the same thing at any resolution. Both come from the same
 * calculation the render used (reframeWindow), never recomputed on a client.
 */
export interface ClipComposition {
  /** The delivered shape: '9:16' for a vertical moment, else the source's own. */
  aspectRatio: string;
  /** What was actually done to make that shape. */
  mode: CompositionMode;
  focalX: number | null;
  focalY: number | null;
  focusPct: number;
  crop: { x: number; y: number; width: number; height: number } | null;
}

export interface ClipMediaContract {
  composition: ClipComposition;
  /** What to play. The 9:16 derivative for a vertical moment; otherwise the canonical clip. */
  url: string | null;
  /** Always the original-framing excerpt. Never replaced by a derivative. */
  canonicalUrl: string | null;
  posterUrl: string | null;
  posterTimestampSeconds: number | null;
  sourceAspectRatio: string | null;
  outputAspectRatio: string | null;
  compositionMode: CompositionMode | null;
  derivativeStatus: DerivativeStatus | null;
}

export interface ClipMediaRow {
  canonicalUrl: string | null;
  derivativeUrl: string | null;
  derivativeStorageKey: string | null;
  derivativeStatus: DerivativeStatus | null;
  posterUrl: string | null;
  posterStorageKey: string | null;
  posterTimestampSeconds: number | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  outputWidth: number | null;
  outputHeight: number | null;
  compositionMode: CompositionMode | null;
  /** The model's chosen focal point, 0..1 against the source frame; null unless smart-cropped. */
  focalX: number | null;
  focalY: number | null;
}

const VERTICAL_RATIO = 9 / 16;

/**
 * The composition block, from the stored decision. For a finished smart crop
 * the window is recomputed from the same focal point and source size the
 * render used, so what the card positions from IS what the export kept. Any
 * other case is centred and uncut — including a vertical moment whose
 * derivative is not ready yet, which the card previews from the source at
 * the centre until the render decides otherwise.
 */
export function clipComposition(row: ClipMediaRow, wantsVertical: boolean, derivativeReady: boolean): ClipComposition {
  const sourceAspect = aspectRatioLabel(row.sourceWidth, row.sourceHeight) ?? 'source';
  const mode: CompositionMode = wantsVertical && derivativeReady ? (row.compositionMode ?? 'original') : 'original';
  const base: ClipComposition = {
    aspectRatio: wantsVertical ? '9:16' : sourceAspect,
    mode,
    focalX: null,
    focalY: null,
    focusPct: 50,
    crop: null,
  };

  if (mode !== 'smart_crop') return base;
  if (row.focalX === null || row.focalY === null || !row.sourceWidth || !row.sourceHeight) return base;

  const source = { width: row.sourceWidth, height: row.sourceHeight };
  const focusPct = focusPctForCrop(row.focalX, row.focalY, source, VERTICAL_RATIO);
  const window = reframeWindow({ aspect: '9:16', focusPct }, source);
  return {
    ...base,
    focalX: row.focalX,
    focalY: row.focalY,
    focusPct,
    crop: window
      ? {
          x: Number((window.x / source.width).toFixed(4)),
          y: Number((window.y / source.height).toFixed(4)),
          width: Number((window.width / source.width).toFixed(4)),
          height: Number((window.height / source.height).toFixed(4)),
        }
      : null,
  };
}

/**
 * Build the media block for one clip.
 *
 * The rule that matters: `url` points at the derivative ONLY when that
 * derivative genuinely exists. A vertical moment whose render failed does not
 * quietly fall back to the landscape file here — that substitution is the
 * one the brief forbids by name, and doing it in a serializer is how it would
 * happen without anyone deciding to.
 *
 * `canonicalUrl` is always the original excerpt, so a client that wants the
 * source framing can still have it deliberately. It is never what `url`
 * becomes by accident.
 */
export function clipMediaContract(row: ClipMediaRow, wantsVertical: boolean): ClipMediaContract {
  const sourceAspectRatio = aspectRatioLabel(row.sourceWidth, row.sourceHeight);
  const derivativeReady = row.derivativeStatus === 'ready' && Boolean(row.derivativeStorageKey);

  // Only a real, finished derivative may claim the playback slot.
  //
  // For a vertical moment that has NO finished derivative, that slot is null —
  // not the canonical clip. Handing back the landscape file here is the
  // substitution this contract exists to forbid, and the comment above used to
  // claim it did not happen while the code did it. A caller that genuinely
  // wants the original framing asks for canonicalUrl by name; nothing gets it
  // by accident, and nothing can play a 16:9 file believing it is the
  // finished 9:16 result.
  const url = wantsVertical
    ? (derivativeReady ? row.derivativeUrl : null)
    : row.canonicalUrl;

  const outputAspectRatio = wantsVertical && derivativeReady
    ? aspectRatioLabel(row.outputWidth, row.outputHeight) ?? '9:16'
    : sourceAspectRatio;

  return {
    composition: clipComposition(row, wantsVertical, derivativeReady),
    url,
    canonicalUrl: row.canonicalUrl,
    posterUrl: row.posterUrl,
    posterTimestampSeconds: row.posterTimestampSeconds,
    sourceAspectRatio,
    outputAspectRatio,
    // Truthful, always. 'original' when no derivative was made or it did not
    // finish — never the mode that was ATTEMPTED, which would describe a file
    // that does not exist.
    compositionMode: wantsVertical && derivativeReady ? row.compositionMode : 'original',
    derivativeStatus: wantsVertical ? row.derivativeStatus : null,
  };
}

/**
 * The authoritative gate. The backend decides readiness; the frontend is not
 * asked to hide anything, and a client that forgets to filter cannot leak a
 * half-made moment because a half-made moment never leaves here.
 */
export function creatorVisibleVerticalRows<T extends ClipMediaRow & { matchId: string; confidence: number }>(
  rows: T[],
): T[] {
  return rows.filter((row) =>
    isCreatorVisible({
      matchId: row.matchId,
      derivativeStatus: row.derivativeStatus ?? 'pending',
      derivativeStorageKey: row.derivativeStorageKey,
      posterStorageKey: row.posterStorageKey,
      confidence: row.confidence,
    }),
  );
}
