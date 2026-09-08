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

  it('merges overlapping windows, which the real plan always has', () => {
    // The shipped plan overlaps: 10s windows every 5s. Two consecutive misses
    // describe 15 seconds of footage, not two separate 10-second holes.
    const overlapping = planWindows(60, { windowSeconds: 10, strideSeconds: 5, minWindowSeconds: 3 });
    const missing = new Set(overlapping.map(windowKey));
    const stored = new Set([...missing].filter((key) => key !== [...missing][2] && key !== [...missing][3]));

    const gaps = unreadRanges(overlapping, stored, windowKey);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.endSeconds - gaps[0]!.startSeconds).toBeGreaterThan(10);
  });

  it('treats a whole unread video as one stretch', () => {
    const gaps: IndexWindow[] = unreadRanges(windows, new Set(), windowKey);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toEqual({ startSeconds: 0, endSeconds: 100 });
  });
});
