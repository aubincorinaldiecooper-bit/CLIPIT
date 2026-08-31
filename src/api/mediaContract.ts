import { aspectRatioLabel, type CompositionMode } from '../services/media/composition.js';
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
export interface ClipMediaContract {
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
