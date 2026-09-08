import { describe, expect, it } from 'vitest';
import { coveredThroughSeconds, unreadRanges } from '../src/services/mediaIndex/coverage.js';
import { planWindows, windowKey, type IndexWindow } from '../src/services/mediaIndex/windows.js';

/**
 * The rule under test is the one this codebase keeps circling: "nothing
 * matches there" and "nothing has read there" are different answers. If a
 * provider refuses a window in the middle of a video, the index must not go
 * on describing the footage after it as read.
 */

const plan = { windowSeconds: 10, strideSeconds: 10, minWindowSeconds: 3 };
const windows = planWindows(100, plan);
const keysFor = (indices: number[]) => new Set(indices.map((i) => windowKey(windows[i]!)));

describe('coveredThroughSeconds', () => {
  it('is zero before anything is stored', () => {
    expect(coveredThroughSeconds(windows, new Set(), windowKey)).toBe(0);
  });

  it('reaches the end when every window is stored', () => {
    const all = new Set(windows.map(windowKey));
    expect(coveredThroughSeconds(windows, all, windowKey)).toBe(100);
  });

  it('stops at the first hole, however much was stored after it', () => {
    // Windows 0-2 stored, 3 refused, 4-9 stored. Coverage is 30 seconds, not
    // 100: footage past a hole is not covered footage.
    const stored = keysFor([0, 1, 2, 4, 5, 6, 7, 8, 9]);

    expect(coveredThroughSeconds(windows, stored, windowKey)).toBe(30);
  });

  it('does not credit a video whose very first window failed', () => {
    expect(coveredThroughSeconds(windows, keysFor([1, 2, 3]), windowKey)).toBe(0);
  });

  it('reports the honest prefix of a run that stopped part-way', () => {
    // The ordinary case: a job that died at window 4 having stored 0-3.
    expect(coveredThroughSeconds(windows, keysFor([0, 1, 2, 3]), windowKey)).toBe(40);
  });
});

describe('unreadRanges', () => {
  it('is empty when everything was read', () => {
    expect(unreadRanges(windows, new Set(windows.map(windowKey)), windowKey)).toEqual([]);
  });

  it('names the stretch nobody looked at', () => {
    const stored = keysFor([0, 1, 2, 4, 5, 6, 7, 8, 9]);

    expect(unreadRanges(windows, stored, windowKey)).toEqual([{ startSeconds: 30, endSeconds: 40 }]);
  });

  it('merges neighbouring misses into one stretch rather than several', () => {
    const stored = keysFor([0, 1, 7, 8, 9]);

    // 20s-70s is one piece of footage nobody read, not five.
    expect(unreadRanges(windows, stored, windowKey)).toEqual([{ startSeconds: 20, endSeconds: 70 }]);
  });

  it('reports separate holes separately', () => {
    const stored = keysFor([0, 2, 3, 4, 6, 7, 8, 9]);

    expect(unreadRanges(windows, stored, windowKey)).toEqual([
      { startSeconds: 10, endSeconds: 20 },
      { startSeconds: 50, endSeconds: 60 },
    ]);
  });

  it('reports only the seconds no stored window covers, not the whole missing window', () => {
    // Corrected: this test previously asserted the gap would be LONGER than a
    // window. That encoded the wrong behaviour. The shipped plan overlaps —
    // ten-second windows every five — so a window that failed is mostly
    // covered by its neighbours, and calling its whole span unread invents a
    // gap over footage that was examined.
    //
    // Windows 10–20 and 15–25 are missing from a 60-second video. 0–10 and
    // 5–15 still cover up to 15, and 20–30 picks up at 20. Exactly five
    // seconds — 15 to 20 — were covered by nothing else.
    const plan = { windowSeconds: 10, strideSeconds: 5, minWindowSeconds: 3 };
    const overlapping = planWindows(60, plan);
    const stored = new Set(
      overlapping.filter((_, index) => index !== 2 && index !== 3).map(windowKey),
    );

    expect(unreadRanges(overlapping, stored, windowKey)).toEqual([{ startSeconds: 15, endSeconds: 20 }]);
  });

  it('reports nothing unread when a missing window is fully covered by its neighbours', () => {
    // One window out of an overlapping grid leaves no uncovered second at
    // all. Reporting a gap here would send somebody looking again at footage
    // that was searched.
    const overlapping = planWindows(60, { windowSeconds: 10, strideSeconds: 5, minWindowSeconds: 3 });
    const stored = new Set(overlapping.filter((_, index) => index !== 3).map(windowKey));

    expect(unreadRanges(overlapping, stored, windowKey)).toEqual([]);
  });

  it('treats a whole unread video as one stretch', () => {
    const gaps: IndexWindow[] = unreadRanges(windows, new Set(), windowKey);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toEqual({ startSeconds: 0, endSeconds: 100 });
  });
});
