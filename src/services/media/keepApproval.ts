import type { DerivativeStatus } from './verticalVisibility.js';

/**
 * What Keep means once media is made before the deck, not after it.
 *
 * The old lifecycle: the deck showed timestamps, Keep cut the clip. Under the
 * atomic-deck rule the file already exists by the time anyone sees the card,
 * so Keep can no longer mean "generate this" — everything it would generate
 * is already sitting in storage, paid for.
 *
 * Keep now means APPROVAL. Re-running the pipeline on a press would re-cut a
 * clip that exists, spend a second GPU call to re-decide framing that was
 * already decided, and re-encode a file the creator is looking at — burning
 * money to produce a byte-identical result, and worse, giving the moment a
 * NEW composition decision that might differ from the one they just approved.
 * They would have kept one clip and received another.
 *
 * Pure on purpose: whether to regenerate is a decision, and decisions get
 * tests that run without a queue.
 */

export interface KeepTarget {
  /** Whether this moment came from the pre-rendered vertical path. */
  preRendered: boolean;
  derivativeStatus: DerivativeStatus | null;
  derivativeStorageKey: string | null;
  posterStorageKey: string | null;
  /** The canonical clip's own render state. */
  clipStatus: 'pending' | 'generating' | 'ready' | 'failed';
}

export type KeepAction =
  /** Everything exists: record approval and move on. No media work. */
  | { kind: 'approve'; regenerate: false }
  /** The legacy path: nothing was pre-rendered, so Keep still cuts the clip. */
  | { kind: 'generate'; regenerate: true }
  /** Pre-rendered but not actually finished — never approvable. */
  | { kind: 'reject'; regenerate: false; reason: string };

/**
 * Decide what a Keep press should do.
 *
 * The legacy path is preserved deliberately: a non-platform request still
 * shows candidates before anything is cut, and Keep there must keep cutting
 * or that whole flow stops working. Only the pre-rendered vertical path
 * changes meaning.
 */
export function keepAction(target: KeepTarget): KeepAction {
  if (!target.preRendered) {
    // Unchanged behaviour for every workflow that is not the post-ready
    // vertical recommendation path.
    return { kind: 'generate', regenerate: true };
  }

  if (target.clipStatus !== 'ready') {
    return { kind: 'reject', regenerate: false, reason: 'The canonical clip is not ready' };
  }
  if (target.derivativeStatus !== 'ready' || !target.derivativeStorageKey) {
    // A pre-rendered moment should never have reached the deck in this state.
    // Refusing beats regenerating: regenerating would quietly repair an
    // invariant violation instead of surfacing it.
    return { kind: 'reject', regenerate: false, reason: 'The vertical derivative is not ready' };
  }
  if (!target.posterStorageKey) {
    return { kind: 'reject', regenerate: false, reason: 'The poster is missing' };
  }

  return { kind: 'approve', regenerate: false };
}

/**
 * How long a rendered file should live, which now depends on whether anyone
 * wanted it.
 *
 * Generating before Keep means some derivatives are made and then skipped.
 * Those are real objects costing real storage for moments nobody chose, and
 * keeping them forever would turn a latency decision into a permanent bill.
 *
 * Approval is what promotes a file from temporary to owned. Deliberately the
 * same distinction the existing footage retention already draws — session
 * work expires, owned work does not — so this reuses that idea rather than
 * inventing a second lifecycle beside it.
 */
export function retentionClassFor(target: { approved: boolean; preRendered: boolean }): 'temporary' | 'owned' {
  if (target.approved) return 'owned';
  // A pre-rendered moment nobody kept is exactly the case this exists for.
  return target.preRendered ? 'temporary' : 'owned';
}
