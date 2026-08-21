import { describe, expect, it } from 'vitest';
import {
  applyClipPadding,
  chunkDuration,
  findUncoveredRanges,
  formatTimecode,
  mapGlobalRangeToChunk,
  mapLocalRangeToGlobal,
  mergeOverlappingRanges,
  planChunkWindows,
} from '../src/services/timestamps.js';

/**
 * The timestamp mapping is the one piece of logic that silently ruins every
 * clip if it drifts, so it is tested against both the happy path and the
 * malformed output a model actually produces.
 */

const chunk = (startSeconds: number, endSeconds: number) => ({
  globalStartSeconds: startSeconds,
  globalEndSeconds: endSeconds,
});

describe('mapLocalRangeToGlobal', () => {
  it('adds the chunk offset to local timestamps', () => {
    // Chunk 3 of a 10-minute grid: local 42.5-78.2 sits at 1842.5-1878.2.
    const result = mapLocalRangeToGlobal(chunk(1800, 2400), { startSeconds: 42.5, endSeconds: 78.2 });

    expect(result).toEqual({
      localStartSeconds: 42.5,
      localEndSeconds: 78.2,
      globalStartSeconds: 1842.5,
      globalEndSeconds: 1878.2,
    });
  });

  it('is an identity offset for the first chunk', () => {
    const result = mapLocalRangeToGlobal(chunk(0, 600), { startSeconds: 12, endSeconds: 30 });

    expect(result?.globalStartSeconds).toBe(12);
    expect(result?.globalEndSeconds).toBe(30);
  });

  it('preserves duration across the mapping', () => {
    const result = mapLocalRangeToGlobal(chunk(3600, 4200), { startSeconds: 100, endSeconds: 143.75 });

    expect(result!.globalEndSeconds - result!.globalStartSeconds).toBeCloseTo(43.75, 6);
  });

  it('repairs a reversed range', () => {
    const result = mapLocalRangeToGlobal(chunk(600, 1200), { startSeconds: 90, endSeconds: 20 });

    expect(result).toMatchObject({ localStartSeconds: 20, localEndSeconds: 90, globalStartSeconds: 620 });
  });

  it('clamps a range that overruns the end of the chunk', () => {
    const result = mapLocalRangeToGlobal(chunk(1200, 1800), { startSeconds: 550, endSeconds: 900 });

    expect(result).toMatchObject({ localEndSeconds: 600, globalEndSeconds: 1800 });
  });

  it('clamps a negative start to the beginning of the chunk', () => {
    const result = mapLocalRangeToGlobal(chunk(600, 1200), { startSeconds: -30, endSeconds: 45 });

    expect(result).toMatchObject({ localStartSeconds: 0, globalStartSeconds: 600, globalEndSeconds: 645 });
  });

  it('rejects a range entirely past the end of the chunk', () => {
    expect(mapLocalRangeToGlobal(chunk(0, 600), { startSeconds: 900, endSeconds: 960 })).toBeNull();
  });

  it('rejects a range entirely before the chunk', () => {
    expect(mapLocalRangeToGlobal(chunk(0, 600), { startSeconds: -120, endSeconds: -10 })).toBeNull();
  });

  it('rejects non-finite timestamps', () => {
    expect(mapLocalRangeToGlobal(chunk(0, 600), { startSeconds: Number.NaN, endSeconds: 10 })).toBeNull();
    expect(mapLocalRangeToGlobal(chunk(0, 600), { startSeconds: 0, endSeconds: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('rejects a zero-length chunk', () => {
    expect(mapLocalRangeToGlobal(chunk(600, 600), { startSeconds: 0, endSeconds: 10 })).toBeNull();
  });

  it('expands a zero-length match to the minimum clip duration', () => {
    const result = mapLocalRangeToGlobal(
      chunk(0, 600),
      { startSeconds: 42, endSeconds: 42 },
      { minDurationSeconds: 4 },
    );

    expect(result).toMatchObject({ localStartSeconds: 40, localEndSeconds: 44 });
  });

  it('slides the minimum-duration window inside the chunk at its edges', () => {
    const atStart = mapLocalRangeToGlobal(
      chunk(0, 600),
      { startSeconds: 0, endSeconds: 0.5 },
      { minDurationSeconds: 4 },
    );
    expect(atStart).toMatchObject({ localStartSeconds: 0, localEndSeconds: 4 });

    const atEnd = mapLocalRangeToGlobal(
      chunk(0, 600),
      { startSeconds: 599.8, endSeconds: 600 },
      { minDurationSeconds: 4 },
    );
    expect(atEnd).toMatchObject({ localStartSeconds: 596, localEndSeconds: 600 });
  });

  it('never expands beyond a chunk shorter than the minimum duration', () => {
    const result = mapLocalRangeToGlobal(
      chunk(1200, 1203),
      { startSeconds: 1, endSeconds: 1.2 },
      { minDurationSeconds: 10 },
    );

    expect(result).toMatchObject({ localStartSeconds: 0, localEndSeconds: 3, globalEndSeconds: 1203 });
  });

  it('truncates a match longer than the maximum clip duration', () => {
    const result = mapLocalRangeToGlobal(
      chunk(0, 600),
      { startSeconds: 10, endSeconds: 580 },
      { maxDurationSeconds: 120 },
    );

    expect(result).toMatchObject({ localStartSeconds: 10, localEndSeconds: 130, globalEndSeconds: 130 });
  });

  it('rounds to milliseconds', () => {
    const result = mapLocalRangeToGlobal(chunk(1800.0004, 2400), { startSeconds: 1.23456, endSeconds: 9.87654 });

    expect(result?.globalStartSeconds).toBe(1801.235);
    expect(result?.localEndSeconds).toBe(9.877);
  });
});

describe('mapGlobalRangeToChunk', () => {
  it('rebases a global range onto its chunk', () => {
    const result = mapGlobalRangeToChunk(chunk(1800, 2400), { startSeconds: 1842.5, endSeconds: 1878.2 });

    expect(result).toEqual({
      localStartSeconds: 42.5,
      localEndSeconds: 78.2,
      globalStartSeconds: 1842.5,
      globalEndSeconds: 1878.2,
    });
  });

  it('round-trips with mapLocalRangeToGlobal', () => {
    const window = chunk(2400, 3000);
    const forward = mapLocalRangeToGlobal(window, { startSeconds: 61.5, endSeconds: 120.25 })!;
    const back = mapGlobalRangeToChunk(window, {
      startSeconds: forward.globalStartSeconds,
      endSeconds: forward.globalEndSeconds,
    })!;

    expect(back).toEqual(forward);
  });
});

describe('applyClipPadding', () => {
  it('adds handles on both sides', () => {
    const result = applyClipPadding(
      { startSeconds: 100, endSeconds: 130 },
      { paddingSeconds: 2, videoDurationSeconds: 3600 },
    );

    expect(result).toEqual({ startSeconds: 98, endSeconds: 132 });
  });

  it('never pads before the start of the video', () => {
    const result = applyClipPadding(
      { startSeconds: 1, endSeconds: 10 },
      { paddingSeconds: 5, videoDurationSeconds: 3600 },
    );

    expect(result.startSeconds).toBe(0);
  });

  it('never pads past the end of the video', () => {
    const result = applyClipPadding(
      { startSeconds: 3580, endSeconds: 3599 },
      { paddingSeconds: 10, videoDurationSeconds: 3600 },
    );

    expect(result.endSeconds).toBe(3600);
  });

  it('honours the minimum clip duration', () => {
    const result = applyClipPadding(
      { startSeconds: 50, endSeconds: 50.5 },
      { paddingSeconds: 0, videoDurationSeconds: 3600, minDurationSeconds: 5 },
    );

    expect(result.endSeconds - result.startSeconds).toBeCloseTo(5, 6);
  });

  it('caps at the maximum clip duration', () => {
    const result = applyClipPadding(
      { startSeconds: 0, endSeconds: 900 },
      { paddingSeconds: 5, videoDurationSeconds: 3600, maxDurationSeconds: 300 },
    );

    expect(result.endSeconds - result.startSeconds).toBe(300);
  });
});

describe('mergeOverlappingRanges', () => {
  it('merges overlapping ranges and keeps the higher confidence', () => {
    const merged = mergeOverlappingRanges([
      { startSeconds: 10, endSeconds: 20, confidence: 0.6, label: 'a' },
      { startSeconds: 15, endSeconds: 30, confidence: 0.9, label: 'b' },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ startSeconds: 10, endSeconds: 30, label: 'b' });
  });

  it('leaves disjoint ranges alone', () => {
    const merged = mergeOverlappingRanges([
      { startSeconds: 0, endSeconds: 10 },
      { startSeconds: 40, endSeconds: 50 },
    ]);

    expect(merged).toHaveLength(2);
  });

  it('joins ranges separated by less than the tolerance', () => {
    const merged = mergeOverlappingRanges(
      [
        { startSeconds: 0, endSeconds: 10 },
        { startSeconds: 12, endSeconds: 20 },
      ],
      3,
    );

    expect(merged).toEqual([{ startSeconds: 0, endSeconds: 20 }]);
  });

  it('sorts unordered input before merging', () => {
    const merged = mergeOverlappingRanges([
      { startSeconds: 100, endSeconds: 120 },
      { startSeconds: 10, endSeconds: 30 },
      { startSeconds: 25, endSeconds: 40 },
    ]);

    expect(merged).toEqual([
      { startSeconds: 10, endSeconds: 40 },
      { startSeconds: 100, endSeconds: 120 },
    ]);
  });

  it('handles empty and single-element input', () => {
    expect(mergeOverlappingRanges([])).toEqual([]);
    expect(mergeOverlappingRanges([{ startSeconds: 1, endSeconds: 2 }])).toHaveLength(1);
  });
});

describe('planChunkWindows', () => {
  it('covers the whole source with a short final chunk', () => {
    const windows = planChunkWindows(1500, 600);

    expect(windows).toEqual([
      { globalStartSeconds: 0, globalEndSeconds: 600 },
      { globalStartSeconds: 600, globalEndSeconds: 1200 },
      { globalStartSeconds: 1200, globalEndSeconds: 1500 },
    ]);
  });

  it('produces a single chunk for a short source', () => {
    expect(planChunkWindows(90, 600)).toEqual([{ globalStartSeconds: 0, globalEndSeconds: 90 }]);
  });

  it('leaves no gaps for a six-hour source', () => {
    const windows = planChunkWindows(21_600, 600);

    expect(windows).toHaveLength(36);
    expect(windows.at(-1)?.globalEndSeconds).toBe(21_600);
    for (const [index, window] of windows.entries()) {
      if (index === 0) continue;
      expect(window.globalStartSeconds).toBe(windows[index - 1]!.globalEndSeconds);
    }
  });

  it('returns nothing for a non-positive duration', () => {
    expect(planChunkWindows(0, 600)).toEqual([]);
    expect(planChunkWindows(-5, 600)).toEqual([]);
  });
});


describe('chunkDuration and formatTimecode', () => {
  it('computes chunk duration', () => {
    expect(chunkDuration(chunk(1800, 2400))).toBe(600);
  });

  it('formats seconds as hh:mm:ss', () => {
    expect(formatTimecode(0)).toBe('00:00:00');
    expect(formatTimecode(61.9)).toBe('00:01:01');
    expect(formatTimecode(3661)).toBe('01:01:01');
    expect(formatTimecode(-5)).toBe('00:00:00');
  });
});

/**
 * A scene list can be perfectly valid and still leave most of a chunk
 * undescribed — one 0-10s scene for a 120 second chunk parses without a
 * complaint. Those 110 seconds are then indistinguishable from a stretch
 * where nothing happened, and every question answered from the notes speaks
 * for a video it only partly read.
 */
describe('finding what the notes never covered', () => {
  it('reports nothing when the ranges cover the whole span', () => {
    expect(
      findUncoveredRanges([
        { startSeconds: 0, endSeconds: 60 },
        { startSeconds: 60, endSeconds: 120 },
      ], 120),
    ).toEqual([]);
  });

  it('finds the stretch after a scene list that stops early', () => {
    expect(findUncoveredRanges([{ startSeconds: 0, endSeconds: 10 }], 120)).toEqual([
      { startSeconds: 10, endSeconds: 120 },
    ]);
  });

  it('finds a hole in the middle', () => {
    expect(
      findUncoveredRanges([
        { startSeconds: 0, endSeconds: 30 },
        { startSeconds: 90, endSeconds: 120 },
      ], 120),
    ).toEqual([{ startSeconds: 30, endSeconds: 90 }]);
  });

  it('finds a stretch before the first scene', () => {
    expect(findUncoveredRanges([{ startSeconds: 45, endSeconds: 120 }], 120)).toEqual([
      { startSeconds: 0, endSeconds: 45 },
    ]);
  });

  it('treats no ranges at all as nothing covered', () => {
    expect(findUncoveredRanges([], 120)).toEqual([{ startSeconds: 0, endSeconds: 120 }]);
  });

  /**
   * Scenes butt up against each other with a rounding error between them. A
   * half-second seam is not a stretch of video nobody described, and reporting
   * it would bury a real gap in noise.
   */
  it('ignores a seam between adjacent scenes', () => {
    expect(
      findUncoveredRanges([
        { startSeconds: 0, endSeconds: 59.6 },
        { startSeconds: 60.1, endSeconds: 120 },
      ], 120, 1),
    ).toEqual([]);
  });

  it('still reports a gap larger than the tolerance', () => {
    expect(
      findUncoveredRanges([
        { startSeconds: 0, endSeconds: 50 },
        { startSeconds: 62, endSeconds: 120 },
      ], 120, 1),
    ).toEqual([{ startSeconds: 50, endSeconds: 62 }]);
  });

  it('handles overlapping and unsorted scenes', () => {
    expect(
      findUncoveredRanges([
        { startSeconds: 80, endSeconds: 120 },
        { startSeconds: 0, endSeconds: 50 },
        { startSeconds: 20, endSeconds: 70 },
      ], 120),
    ).toEqual([{ startSeconds: 70, endSeconds: 80 }]);
  });
});
