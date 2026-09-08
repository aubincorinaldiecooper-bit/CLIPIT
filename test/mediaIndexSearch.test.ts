import { describe, expect, it } from 'vitest';
import {
  decideIndexAnswer,
  foldIntoMoments,
  rankWindows,
  type IndexDecisionInput,
} from '../src/services/mediaIndex/search.js';
import type { MediaIndexStatus } from '../src/db/repositories/mediaIndex.js';
import type { StoredWindow } from '../src/db/repositories/mediaIndex.js';

/**
 * The one thing this layer must never do is turn its own silence into an
 * answer. Vectors that match nothing mean this footage did not look like the
 * question — not that the video lacks the thing. Every test below is about
 * keeping those two apart.
 */

function status(over: Partial<MediaIndexStatus> = {}): MediaIndexStatus {
  return {
    videoId: 'v1',
    state: 'ready',
    coveredThroughSeconds: 120,
    windowsPlanned: 24,
    windowsStored: 24,
    windowsFailed: 0,
    model: 'qwen', revision: 'r1', dims: 8, indexVersion: 'v1',
    error: null, startedAt: null, finishedAt: null, updatedAt: new Date(),
    ...over,
  };
}

const base: IndexDecisionInput = { enabled: true, correcting: false, mode: 'visual', status: status() };

describe('decideIndexAnswer', () => {
  it('answers from the vectors when the video was read and something matched', () => {
    expect(decideIndexAnswer({ ...base, candidateCount: 3 })).toEqual({ use: 'index' });
  });

  it('never reports an absence: nothing matching is a fallback, not "no such moment"', () => {
    const decision = decideIndexAnswer({ ...base, candidateCount: 0 });

    expect(decision).toMatchObject({ use: 'fallback', reason: 'no_candidates' });
    if (decision.use === 'fallback') {
      expect(decision.detail).toMatch(/not evidence the moment is absent/);
    }
  });

  it('stands aside when switched off', () => {
    expect(decideIndexAnswer({ ...base, enabled: false })).toMatchObject({ use: 'fallback', reason: 'disabled' });
  });

  it('sends a correction to the footage however good the index looks', () => {
    expect(decideIndexAnswer({ ...base, correcting: true, candidateCount: 9 })).toMatchObject({
      use: 'fallback',
      reason: 'correction',
    });
  });

  it('does not try to answer a question about speech from pictures', () => {
    expect(decideIndexAnswer({ ...base, mode: 'transcript' })).toMatchObject({
      use: 'fallback',
      reason: 'not_visual',
    });
  });

  it('takes a mixed question, because half of it is visual', () => {
    expect(decideIndexAnswer({ ...base, mode: 'both', candidateCount: 2 })).toEqual({ use: 'index' });
  });

  it('falls back when the video was never read', () => {
    expect(decideIndexAnswer({ ...base, status: null })).toMatchObject({
      use: 'fallback',
      reason: 'index_missing',
    });
  });

  it('answers from a partly-read video, rather than waiting for the rest', () => {
    const partial = status({ state: 'running', coveredThroughSeconds: 45 });

    expect(decideIndexAnswer({ ...base, status: partial, candidateCount: 1 })).toEqual({ use: 'index' });
  });

  it('falls back while a read has produced nothing yet', () => {
    const nothingYet = status({ state: 'running', coveredThroughSeconds: 0 });

    expect(decideIndexAnswer({ ...base, status: nothingYet })).toMatchObject({
      use: 'fallback',
      reason: 'index_not_ready',
    });
  });

  it('carries the recorded reason when indexing failed', () => {
    const broken = status({ state: 'failed', error: 'the GPU service refused every window' });
    const decision = decideIndexAnswer({ ...base, status: broken });

    expect(decision).toMatchObject({ use: 'fallback', reason: 'index_unavailable' });
    if (decision.use === 'fallback') expect(decision.detail).toBe('the GPU service refused every window');
  });

  it('falls back when consulting the index threw', () => {
    expect(decideIndexAnswer({ ...base, error: 'modal timed out' })).toMatchObject({
      use: 'fallback',
      reason: 'index_failed',
    });
  });
});

function window(key: string, start: number, end: number, values: number[]): StoredWindow {
  return { windowKey: key, startSeconds: start, endSeconds: end, embedding: Float32Array.from(values) };
}

describe('rankWindows', () => {
  it('puts the most similar window first', () => {
    const query = Float32Array.from([1, 0, 0]);
    const windows = [
      window('a', 0, 10, [0, 1, 0]),
      window('b', 10, 20, [1, 0, 0]),
      window('c', 20, 30, [0.7, 0.7, 0]),
    ];

    expect(rankWindows(query, windows, 3).map((row) => row.windowKey)).toEqual(['b', 'c', 'a']);
  });

  it('returns at most the shortlist size', () => {
    const query = Float32Array.from([1, 0]);
    const windows = [window('a', 0, 5, [1, 0]), window('b', 5, 10, [0, 1]), window('c', 10, 15, [1, 1])];

    expect(rankWindows(query, windows, 2)).toHaveLength(2);
  });
});

describe('foldIntoMoments', () => {
  it('joins overlapping windows into one moment and keeps the best score', () => {
    const folded = foldIntoMoments([
      { windowKey: 'a', startSeconds: 10, endSeconds: 20, score: 0.6 },
      { windowKey: 'b', startSeconds: 15, endSeconds: 25, score: 0.9 },
    ]);

    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ startSeconds: 10, endSeconds: 25, score: 0.9 });
  });

  it('keeps moments that do not touch apart', () => {
    const folded = foldIntoMoments([
      { windowKey: 'a', startSeconds: 0, endSeconds: 10, score: 0.5 },
      { windowKey: 'b', startSeconds: 60, endSeconds: 70, score: 0.8 },
    ]);

    expect(folded).toHaveLength(2);
    // Best first, whatever order they arrived in.
    expect(folded[0]!.startSeconds).toBe(60);
  });

  it('does not show the same footage three times because the grid overlaps', () => {
    // The shipped plan is a 10s window every 5s, so one strong moment always
    // lights up three windows.
    const folded = foldIntoMoments([
      { windowKey: 'a', startSeconds: 30, endSeconds: 40, score: 0.71 },
      { windowKey: 'b', startSeconds: 35, endSeconds: 45, score: 0.88 },
      { windowKey: 'c', startSeconds: 40, endSeconds: 50, score: 0.69 },
    ]);

    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ startSeconds: 30, endSeconds: 50, score: 0.88 });
  });
});
