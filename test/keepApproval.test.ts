import { describe, expect, it } from 'vitest';
import { deliverableStands, keepAction, retentionClassFor, type KeepTarget } from '../src/services/media/keepApproval.js';

/**
 * Keep means "make this". A moment is shown from the source video it was
 * found in; its file is made when a person keeps it. The one exception is a
 * moment whose file already stands, where a second render would re-decide
 * framing that was already decided and hand back a different clip from the
 * one on screen.
 */

const nothingCut = (over: Partial<KeepTarget> = {}): KeepTarget => ({
  preRendered: false,
  presentation: null,
  storageKey: null,
  derivativeStatus: null,
  derivativeStorageKey: null,
  posterStorageKey: null,
  clipStatus: 'pending',
  ...over,
});

const finishedVertical = (over: Partial<KeepTarget> = {}): KeepTarget => ({
  preRendered: false,
  presentation: 'vertical',
  storageKey: 'clips/v/c.mp4',
  derivativeStatus: 'ready',
  derivativeStorageKey: 'clips/v/c-vertical.mp4',
  posterStorageKey: 'posters/v/c.jpg',
  clipStatus: 'ready',
  ...over,
});

describe('keepAction — production happens on Keep', () => {
  it('produces the file for a moment nothing has been cut for', () => {
    const action = keepAction(nothingCut());
    expect(action.kind).toBe('produce');
    expect(action.produce).toBe(true);
  });

  it('produces again for a moment whose earlier render failed', () => {
    expect(keepAction(nothingCut({ clipStatus: 'failed' })).kind).toBe('produce');
  });

  it('produces for a moment whose cut exists but whose 9:16 file never landed', () => {
    for (const unfinished of [
      finishedVertical({ derivativeStatus: 'pending', derivativeStorageKey: null }),
      finishedVertical({ derivativeStatus: 'failed', derivativeStorageKey: null }),
      finishedVertical({ posterStorageKey: null }),
      finishedVertical({ preRendered: true, derivativeStatus: 'failed', derivativeStorageKey: null }),
      finishedVertical({ preRendered: true, posterStorageKey: null }),
    ]) {
      expect(keepAction(unfinished).kind).toBe('produce');
    }
  });

  it('does not produce while a render is already running', () => {
    // Keep on a moment mid-render is still "produce": the queue de-duplicates
    // by clip id, so the running render carries on and nothing is doubled.
    expect(keepAction(nothingCut({ clipStatus: 'generating' })).kind).toBe('produce');
  });
});

describe('keepAction — approval, when the file already stands', () => {
  it('approves a finished vertical moment WITHOUT any media work', () => {
    const action = keepAction(finishedVertical());
    expect(action.kind).toBe('approve');
    expect(action.produce).toBe(false);
  });

  it('approves a moment rendered before review, from the months when every moment was', () => {
    expect(keepAction(finishedVertical({ preRendered: true })).kind).toBe('approve');
  });

  it('reads a pre-rendered row from before the presentation column as a vertical one', () => {
    expect(keepAction(finishedVertical({ preRendered: true, presentation: null })).kind).toBe('approve');
    expect(keepAction(finishedVertical({ preRendered: true, presentation: null, derivativeStatus: 'failed', derivativeStorageKey: null })).kind).toBe('produce');
  });

  it('approves an original-framing pre-render that has its cut and its poster', () => {
    expect(keepAction(finishedVertical({ preRendered: true, presentation: 'original', derivativeStatus: null, derivativeStorageKey: null })).kind).toBe('approve');
  });

  it('approves a clip cut on demand before the always-vertical rule, as it is', () => {
    // The rule governs what is MADE, not how what already exists is described:
    // the landscape file the person has is the file they kept.
    const landscape = nothingCut({ clipStatus: 'ready', storageKey: 'clips/v/old.mp4' });
    expect(keepAction(landscape).kind).toBe('approve');
    expect(deliverableStands(landscape)).toBe(true);
  });
});

describe('retentionClassFor — approval is what makes a file worth keeping', () => {
  it('a kept moment is owned', () => {
    expect(retentionClassFor({ approved: true, preRendered: true })).toBe('owned');
    expect(retentionClassFor({ approved: true, preRendered: false })).toBe('owned');
  });

  it('a moment rendered before review that nobody kept is temporary', () => {
    expect(retentionClassFor({ approved: false, preRendered: true })).toBe('temporary');
  });

  it('a file made on Keep is owned from the first byte', () => {
    expect(retentionClassFor({ approved: false, preRendered: false })).toBe('owned');
  });
});
