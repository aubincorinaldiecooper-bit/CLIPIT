import { describe, expect, it } from 'vitest';
import { keepAction, retentionClassFor, type KeepTarget } from '../src/services/media/keepApproval.js';

/**
 * Keep used to mean "cut this clip". For a pre-rendered vertical moment the
 * clip already exists — so Keep means "approve it", and pressing it must not
 * spend a second GPU call and a second encode reproducing what the creator is
 * already looking at.
 */

const target = (over: Partial<KeepTarget> = {}): KeepTarget => ({
  preRendered: true,
  derivativeStatus: 'ready',
  derivativeStorageKey: 'clips/v/c-vertical.mp4',
  posterStorageKey: 'posters/v/c.jpg',
  clipStatus: 'ready',
  ...over,
});

describe('keepAction — approval, not generation', () => {
  it('approves a finished vertical recommendation WITHOUT any media work', () => {
    const action = keepAction(target());
    expect(action.kind).toBe('approve');
    // The regression that matters: no regeneration is triggered.
    expect(action.regenerate).toBe(false);
  });

  it('would not re-decide framing — the creator kept THIS cut, not another one', () => {
    // Re-running composition could return a different focal point and produce
    // a different file from the one on screen.
    expect(keepAction(target()).regenerate).toBe(false);
  });

  it('still generates on the legacy path, where nothing was pre-rendered', () => {
    const action = keepAction(target({ preRendered: false, derivativeStatus: null, derivativeStorageKey: null }));
    expect(action.kind).toBe('generate');
    expect(action.regenerate).toBe(true);
  });

  it('refuses rather than repairing when a pre-rendered moment is not actually ready', () => {
    // Reaching the deck in this state is an invariant violation. Regenerating
    // would quietly paper over it; refusing surfaces it.
    for (const broken of [
      target({ derivativeStatus: 'pending', derivativeStorageKey: null }),
      target({ derivativeStatus: 'failed', derivativeStorageKey: null }),
      target({ posterStorageKey: null }),
      target({ clipStatus: 'failed' }),
    ]) {
      const action = keepAction(broken);
      expect(action.kind).toBe('reject');
      expect(action.regenerate).toBe(false);
    }
  });
});

describe('retentionClassFor — approval is what makes a file worth keeping', () => {
  it('a kept recommendation becomes owned', () => {
    expect(retentionClassFor({ approved: true, preRendered: true })).toBe('owned');
  });

  it('a pre-rendered moment nobody kept is temporary', () => {
    // Made speculatively, skipped by the creator. Keeping it forever would
    // turn a latency decision into a permanent storage bill.
    expect(retentionClassFor({ approved: false, preRendered: true })).toBe('temporary');
  });

  it('leaves the legacy path alone — clips cut on demand stay owned', () => {
    expect(retentionClassFor({ approved: false, preRendered: false })).toBe('owned');
  });
});
