import type { DeckPresentation, DerivativeStatus } from './verticalVisibility.js';

/**
 * What Keep means, now that a moment is shown before anything is made.
 *
 * A moment is the evidence: a stretch of the source video, its description
 * and a still. The finished 9:16 file is production, and production happens
 * when a person asks for it — which is what Keep is. So Keep normally means
 * "make this": approve the moment, and cut, frame and encode its file.
 *
 * The exception is a moment whose file already exists — a clip cut on an
 * earlier Keep, or one from the months when every moment was rendered
 * before review. Re-running the pipeline on a press would re-decide framing
 * that was already decided and hand back a differently-cropped clip from the
 * one on screen; they would have kept one clip and received another. For
 * those, Keep is an approval and nothing more.
 *
 * Pure on purpose: whether to produce is a decision, and decisions get tests
 * that run without a queue.
 */

export interface KeepTarget {
  /** Whether this moment was made before anyone chose it. */
  preRendered: boolean;
  /**
   * Which deliverable an earlier render made. Null on rows older than the
   * column, every one of which came from the vertical pipeline — and on
   * rows cut on demand, whose deliverable was the canonical file.
   */
  presentation: DeckPresentation | null;
  /** The canonical cut's key. */
  storageKey: string | null;
  derivativeStatus: DerivativeStatus | null;
  derivativeStorageKey: string | null;
  posterStorageKey: string | null;
  /** The canonical clip's own render state. */
  clipStatus: 'pending' | 'generating' | 'ready' | 'failed';
}

export type KeepAction =
  /** The file this moment delivers already exists: record approval, no media work. */
  | { kind: 'approve'; produce: false }
  /** Nothing usable exists yet: approve the moment and make its file. */
  | { kind: 'produce'; produce: true };

/**
 * Does the file this moment would deliver already stand?
 *
 * Three ways it can:
 *
 *  - A clip cut on demand before the always-vertical rule. Whatever its
 *    shape, it is what the person has, and Keep approves what exists rather
 *    than remaking it (the rule governs what is MADE, not how what already
 *    exists is described).
 *  - An original-framing pre-render: the cut and its poster.
 *  - A vertical one: the cut, its poster and the finished 9:16 file.
 *
 * Shared with the render job, so the two can never disagree about whether
 * there is work to do.
 */
export function deliverableStands(target: KeepTarget): boolean {
  if (target.clipStatus !== 'ready' || !target.storageKey) return false;
  if (!target.preRendered) {
    // Cut on demand. A vertical one from this pipeline carries its
    // derivative; one from before the rule carries only the canonical file,
    // and that file is the thing the person kept.
    if (target.presentation === 'vertical') {
      return target.derivativeStatus === 'ready' && Boolean(target.derivativeStorageKey) && Boolean(target.posterStorageKey);
    }
    return true;
  }
  if (!target.posterStorageKey) return false;
  // Rows older than the column all came from the vertical pipeline.
  const presentation = target.presentation ?? 'vertical';
  if (presentation === 'original') return true;
  return target.derivativeStatus === 'ready' && Boolean(target.derivativeStorageKey);
}

/** The clip row, read the way this decision needs it. */
export function keepTargetFromClip(clip: {
  preRendered: boolean;
  presentation: DeckPresentation | null;
  storageKey: string | null;
  derivativeStatus: DerivativeStatus | null;
  derivativeStorageKey: string | null;
  posterStorageKey: string | null;
  status: 'pending' | 'generating' | 'ready' | 'failed';
}): KeepTarget {
  return {
    preRendered: clip.preRendered,
    presentation: clip.presentation,
    storageKey: clip.storageKey,
    derivativeStatus: clip.derivativeStatus,
    derivativeStorageKey: clip.derivativeStorageKey,
    posterStorageKey: clip.posterStorageKey,
    clipStatus: clip.status,
  };
}

/** Decide what a Keep press should do. */
export function keepAction(target: KeepTarget): KeepAction {
  if (deliverableStands(target)) return { kind: 'approve', produce: false };
  return { kind: 'produce', produce: true };
}

/**
 * How long a rendered file should live, which depends on whether anyone
 * wanted it.
 *
 * A file made on Keep was wanted by definition. The only temporary files are
 * the ones from the months when moments were rendered before review and then
 * skipped — real objects costing real storage for moments nobody chose — and
 * approval is what promotes one of those to owned. The same distinction the
 * footage retention draws: session work expires, owned work does not.
 */
export function retentionClassFor(target: { approved: boolean; preRendered: boolean }): 'temporary' | 'owned' {
  if (target.approved) return 'owned';
  return target.preRendered ? 'temporary' : 'owned';
}
