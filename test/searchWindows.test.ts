import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  itemsInWindow,
  planSearchWindows,
  planWindowCount,
} from '../src/services/search/searchWindows.js';

/**
 * A long video's evidence cannot fit one request. Getting this wrong either
 * fails the search outright (the 402 that prompted this) or silently drops
 * part of the timeline — so the split is pinned in detail.
 */

describe('estimateTokens', () => {
  it('scales with length and never returns a fraction', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a'.repeat(4))).toBe(1);
    expect(estimateTokens('a'.repeat(5))).toBe(2);
    expect(estimateTokens('a'.repeat(400_000))).toBe(100_000);
  });
});

describe('planWindowCount', () => {
  it('keeps a single request when the evidence fits', () => {
    expect(planWindowCount(50_000, 100_000)).toBe(1);
    expect(planWindowCount(100_000, 100_000)).toBe(1);
  });

  it('splits just past the budget', () => {
    expect(planWindowCount(100_001, 100_000)).toBe(2);
    expect(planWindowCount(250_000, 100_000)).toBe(3);
  });

  it('is defensive about nonsense inputs rather than dividing by zero', () => {
    expect(planWindowCount(0, 100_000)).toBe(1);
    expect(planWindowCount(Number.NaN, 100_000)).toBe(1);
    expect(planWindowCount(500_000, 0)).toBe(1);
  });
});

describe('planSearchWindows', () => {
  it('covers the whole timeline with contiguous windows', () => {
    const windows = planSearchWindows(1200, 3);
    expect(windows).toEqual([
      { index: 0, startSeconds: 0, endSeconds: 400 },
      { index: 1, startSeconds: 400, endSeconds: 800 },
      { index: 2, startSeconds: 800, endSeconds: 1200 },
    ]);
  });

  it('ends the last window exactly at the duration, losing no tail', () => {
    const windows = planSearchWindows(1000, 3);
    expect(windows.at(-1)!.endSeconds).toBe(1000);
    // No gaps between windows.
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i]!.startSeconds).toBeCloseTo(windows[i - 1]!.endSeconds, 3);
    }
  });

  it('returns one window covering everything when count is 1', () => {
    expect(planSearchWindows(600, 1)).toEqual([{ index: 0, startSeconds: 0, endSeconds: 600 }]);
  });

  it('returns nothing for a video with no duration', () => {
    expect(planSearchWindows(0, 3)).toEqual([]);
  });
});

describe('itemsInWindow', () => {
  const items = [
    { startSeconds: 0, endSeconds: 10 },
    { startSeconds: 395, endSeconds: 405 }, // straddles the 400s seam
    { startSeconds: 500, endSeconds: 510 },
    { startSeconds: 1190, endSeconds: 1200 },
  ];

  it('selects only what overlaps the window', () => {
    const [first] = planSearchWindows(1200, 3);
    expect(itemsInWindow(items, first!)).toEqual([items[0], items[1]]);
  });

  it('gives a straddling item to BOTH windows so a seam moment stays findable', () => {
    const [first, second] = planSearchWindows(1200, 3);
    expect(itemsInWindow(items, first!)).toContainEqual(items[1]);
    expect(itemsInWindow(items, second!)).toContainEqual(items[1]);
  });

  it('includes the final item in the last window', () => {
    const windows = planSearchWindows(1200, 3);
    expect(itemsInWindow(items, windows.at(-1)!)).toEqual([items[3]]);
  });

  it('together, the windows lose nothing', () => {
    const windows = planSearchWindows(1200, 3);
    const covered = new Set(windows.flatMap((window) => itemsInWindow(items, window)));
    expect(covered.size).toBe(items.length);
  });
});
