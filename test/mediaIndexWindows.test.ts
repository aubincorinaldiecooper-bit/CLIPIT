import { describe, expect, it } from 'vitest';
import {
  assertPlannable,
  DEFAULT_WINDOW_PLAN,
  planWindows,
  uncoveredSeconds,
  windowKey,
  windowsWithin,
} from '../src/services/mediaIndex/windows.js';

/**
 * The coordinates the Media Index is built on.
 *
 * What is being pinned here is not arithmetic for its own sake. It is that a
 * window means the same seconds of the same video every time it is planned,
 * that no window ever claims footage the video does not have, and that a
 * stretch nobody indexed can be named. Those three are what the old chunk grid
 * kept getting wrong.
 */

describe('planWindows', () => {
  it('covers the timeline with overlapping windows', () => {
    const windows = planWindows(30, { windowSeconds: 10, strideSeconds: 5, minWindowSeconds: 3 });
    expect(windows.slice(0, 3)).toEqual([
      { startSeconds: 0, endSeconds: 10 },
      { startSeconds: 5, endSeconds: 15 },
      { startSeconds: 10, endSeconds: 20 },
    ]);
    // Every instant sits inside some window, not merely at the edge of one.
    expect(uncoveredSeconds(windows, 30)).toEqual([]);
  });

  it('never claims footage past the end of the video', () => {
    // The bug this forbids: a window running to 35s on a 32s video, and a
    // match reported at 34s that no clip could ever be cut from.
    for (const duration of [32, 47.5, 121.004, 3600]) {
      const windows = planWindows(duration);
      expect(windows.at(-1)!.endSeconds).toBeLessThanOrEqual(duration + 1e-9);
      expect(windows.every((window) => window.endSeconds <= duration + 1e-9)).toBe(true);
    }
  });

  it('does not leave a sliver of a window at the end', () => {
    // 31 seconds at a 5s stride would otherwise end with a 1-second window:
    // a real row, a real GPU call, and too little footage to mean anything.
    const windows = planWindows(31, { windowSeconds: 10, strideSeconds: 5, minWindowSeconds: 3 });
    expect(windows.at(-1)!.endSeconds - windows.at(-1)!.startSeconds).toBeGreaterThanOrEqual(3);
    // The seconds it would have covered are still covered by the window before.
    expect(uncoveredSeconds(windows, 31)).toEqual([]);
  });

  it('reaches the end of the video even when the windows do not overlap', () => {
    // Devin's finding on #93, and it was real. Dropping a short tail is only
    // safe when an overlapping window already covers it. At the sweep's
    // 10s-window/10s-stride grid a 31-second video lost its final second:
    // windows 0-10, 10-20, 20-30, and nothing for 30-31.
    const grid = { windowSeconds: 10, strideSeconds: 10, minWindowSeconds: 3 };
    const windows = planWindows(31, grid);
    expect(windows.at(-1)!.endSeconds).toBe(31);
    expect(uncoveredSeconds(windows, 31)).toEqual([]);
    // And the final window is a full window, not a stub.
    expect(windows.at(-1)!.endSeconds - windows.at(-1)!.startSeconds).toBe(10);
  });

  it('covers every second of every grid it is given', () => {
    // The property the case above is one instance of. Every grid the sweep
    // can run, against durations that land on, just before and just after a
    // stride boundary.
    const grids = [
      { windowSeconds: 6, strideSeconds: 3, minWindowSeconds: 2 },
      { windowSeconds: 10, strideSeconds: 5, minWindowSeconds: 3 },
      { windowSeconds: 10, strideSeconds: 10, minWindowSeconds: 3 },
      { windowSeconds: 20, strideSeconds: 10, minWindowSeconds: 5 },
    ];
    for (const grid of grids) {
      for (const duration of [19.5, 20, 20.5, 30, 31, 47, 60, 121.004, 300]) {
        const windows = planWindows(duration, grid);
        expect(uncoveredSeconds(windows, duration), `${grid.windowSeconds}/${grid.strideSeconds} @ ${duration}s`).toEqual([]);
        expect(windows.every((window) => window.endSeconds <= duration + 1e-9)).toBe(true);
      }
    }
  });

  it('does not store the same seconds twice when the grid lands on the end', () => {
    // A duration that is an exact multiple of the stride already ends on a
    // window boundary. Reaching for the end must not append a duplicate.
    const windows = planWindows(30, { windowSeconds: 10, strideSeconds: 10, minWindowSeconds: 3 });
    expect(windows.map(windowKey)).toEqual([...new Set(windows.map(windowKey))]);
    expect(windows.at(-1)).toEqual({ startSeconds: 20, endSeconds: 30 });
  });

  it('makes one window of a video shorter than a window', () => {
    expect(planWindows(4)).toEqual([{ startSeconds: 0, endSeconds: 4 }]);
    // Even below the minimum: a 2-second video is still a video, and one
    // window of it is better than an index with nothing in it.
    expect(planWindows(2)).toEqual([{ startSeconds: 0, endSeconds: 2 }]);
  });

  it('is deterministic, so re-indexing updates rather than duplicates', () => {
    const once = planWindows(187.5);
    const again = planWindows(187.5);
    expect(again).toEqual(once);
    expect(new Set(once.map(windowKey)).size).toBe(once.length);
  });

  it('refuses a stride that leaves holes between windows', () => {
    // Both numbers sit inside their own configured ranges. Measured before
    // fixing: window 10 / stride 30 over two minutes left 60 of 120 seconds
    // with no embedding at all.
    expect(() => planWindows(120, { windowSeconds: 10, strideSeconds: 30, minWindowSeconds: 3 }))
      .toThrow(/stride must be at most the window length/);
  });

  it('refuses a minimum no window could ever meet', () => {
    // Same shape: window 10 / minimum 20 collapsed a two-minute video to a
    // single window covering its last ten seconds.
    expect(() => planWindows(120, { windowSeconds: 10, strideSeconds: 5, minWindowSeconds: 20 }))
      .toThrow(/minimum must be at most the window length/);
  });

  it('accepts every grid the sweep actually runs', () => {
    for (const grid of [
      { windowSeconds: 6, strideSeconds: 3, minWindowSeconds: 2 },
      { windowSeconds: 10, strideSeconds: 5, minWindowSeconds: 3 },
      { windowSeconds: 10, strideSeconds: 10, minWindowSeconds: 3 },
      { windowSeconds: 20, strideSeconds: 10, minWindowSeconds: 5 },
      DEFAULT_WINDOW_PLAN,
    ]) {
      expect(() => assertPlannable(grid)).not.toThrow();
    }
  });

  it('has nothing to plan for a video of no length', () => {
    expect(planWindows(0)).toEqual([]);
    expect(planWindows(Number.NaN)).toEqual([]);
    expect(planWindows(-5)).toEqual([]);
  });
});

describe('windowKey', () => {
  it('names a window by the seconds it covers', () => {
    expect(windowKey({ startSeconds: 402, endSeconds: 412 })).toBe('000402000-000412000');
  });

  it('cannot make one window look like two through rounding', () => {
    expect(windowKey({ startSeconds: 6.1, endSeconds: 16.1 })).toBe(
      windowKey({ startSeconds: 6.1000000001, endSeconds: 16.099999999 }),
    );
  });
});

describe('windowsWithin — the progressive question', () => {
  const windows = planWindows(60, DEFAULT_WINDOW_PLAN);

  it('offers only windows whose every second exists', () => {
    // Encoding has reached 20s. The 15-25s window is half written and must
    // not be embedded: an embedding of half a moment is worse than none,
    // because nothing downstream could tell.
    const ready = windowsWithin(windows, 0, 20);
    expect(ready.at(-1)).toEqual({ startSeconds: 10, endSeconds: 20 });
    expect(ready.some((w) => w.endSeconds > 20)).toBe(false);
  });

  it('lets a window span a section boundary while the buffer still holds it', () => {
    // Sections close at 30s and 60s. A window from 25s to 35s belongs to
    // neither on its own — it is coverable only because the rolling buffer
    // still holds the earlier section. That is the whole point of rolling
    // context: this window never has to wait for the finished proxy.
    const straddling = { startSeconds: 25, endSeconds: 35 };
    expect(windowsWithin(windows, 30, 60)).not.toContainEqual(straddling);
    expect(windowsWithin(windows, 0, 60)).toContainEqual(straddling);
  });

  it('offers nothing when nothing is finished', () => {
    expect(windowsWithin(windows, 0, 0)).toEqual([]);
  });
});

describe('uncoveredSeconds — naming what was never indexed', () => {
  it('finds a hole between windows', () => {
    const gaps = uncoveredSeconds(
      [{ startSeconds: 0, endSeconds: 20 }, { startSeconds: 40, endSeconds: 60 }],
      60,
    );
    expect(gaps).toEqual([{ startSeconds: 20, endSeconds: 40 }]);
  });

  it('finds a tail nobody reached', () => {
    // The failure this exists for: embedding stopped at 8 minutes of a
    // 20-minute video, and every later question is answered as though the
    // rest contained nothing.
    expect(uncoveredSeconds([{ startSeconds: 0, endSeconds: 480 }], 1200)).toEqual([
      { startSeconds: 480, endSeconds: 1200 },
    ]);
  });

  it('is not fooled by windows that arrive out of order or overlap', () => {
    const gaps = uncoveredSeconds(
      [
        { startSeconds: 10, endSeconds: 20 },
        { startSeconds: 0, endSeconds: 15 },
        { startSeconds: 30, endSeconds: 40 },
      ],
      40,
    );
    expect(gaps).toEqual([{ startSeconds: 20, endSeconds: 30 }]);
  });

  it('says nothing about a video with no gaps', () => {
    expect(uncoveredSeconds(planWindows(300), 300)).toEqual([]);
  });
});
