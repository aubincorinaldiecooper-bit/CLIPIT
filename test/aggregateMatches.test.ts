import { describe, expect, it } from 'vitest';
import { aggregateMatches, shouldMerge, type MergeableMatch } from '../src/services/search/aggregateMatches.js';

const options = { gapSeconds: 1.5, minOverlapRatio: 0.5, maxDurationSeconds: 300 };

function match(overrides: Partial<MergeableMatch> & { globalStartSeconds: number; globalEndSeconds: number }): MergeableMatch {
  return {
    chunkId: 'chunk-a',
    description: '',
    confidence: 0.8,
    source: 'visual',
    quote: null,
    ...overrides,
  };
}

describe('shouldMerge', () => {
  it('does not join nearby moments found in the same chunk', () => {
    const a = match({ globalStartSeconds: 10, globalEndSeconds: 20 });
    const b = match({ globalStartSeconds: 21, globalEndSeconds: 30 });

    expect(shouldMerge(a, b, options)).toBe(false);
  });

  it('joins adjacent pieces reported by different chunk searches', () => {
    const a = match({ chunkId: 'chunk-a', globalStartSeconds: 590, globalEndSeconds: 600 });
    const b = match({ chunkId: 'chunk-b', globalStartSeconds: 600, globalEndSeconds: 610 });

    expect(shouldMerge(a, b, options)).toBe(true);
  });

  it('leaves matches separated by more than the gap alone', () => {
    const a = match({ globalStartSeconds: 10, globalEndSeconds: 20 });
    const b = match({ globalStartSeconds: 25, globalEndSeconds: 30 });

    expect(shouldMerge(a, b, options)).toBe(false);
  });

  it('merges heavily overlapping matches', () => {
    const a = match({ globalStartSeconds: 10, globalEndSeconds: 30 });
    const b = match({ globalStartSeconds: 12, globalEndSeconds: 32 });

    // 18s of overlap on a 20s match.
    expect(shouldMerge(a, b, options)).toBe(true);
  });

  it('merges a match wholly contained in another', () => {
    const a = match({ globalStartSeconds: 10, globalEndSeconds: 60 });
    const b = match({ globalStartSeconds: 20, globalEndSeconds: 25 });

    expect(shouldMerge(a, b, options)).toBe(true);
  });

  it('leaves two long matches that merely graze each other alone', () => {
    const a = match({ globalStartSeconds: 0, globalEndSeconds: 60 });
    const b = match({ globalStartSeconds: 59.5, globalEndSeconds: 120 });

    // 0.5s of overlap on a 60s match is not the same moment reported twice.
    expect(shouldMerge(a, b, options)).toBe(false);
  });

  it('refuses a merge that would exceed the maximum clip duration', () => {
    const a = match({ globalStartSeconds: 0, globalEndSeconds: 280 });
    const b = match({ globalStartSeconds: 280, globalEndSeconds: 400 });

    expect(shouldMerge(a, b, options)).toBe(false);
  });
});

describe('aggregateMatches', () => {
  it('does not chain several nearby moments into one long result', () => {
    const merged = aggregateMatches(
      [
        match({ globalStartSeconds: 10, globalEndSeconds: 15 }),
        match({ globalStartSeconds: 16, globalEndSeconds: 21 }),
        match({ globalStartSeconds: 22, globalEndSeconds: 27 }),
      ],
      options,
    );

    expect(merged).toHaveLength(3);
  });

  it('joins a moment split across a chunk boundary', () => {
    // The classic case: a chunk ends at 600s mid-event, so the same moment is
    // reported as the tail of one chunk and the head of the next.
    const merged = aggregateMatches(
      [
        match({ chunkId: 'chunk-0', globalStartSeconds: 594, globalEndSeconds: 600, confidence: 0.7 }),
        match({ chunkId: 'chunk-1', globalStartSeconds: 600, globalEndSeconds: 607, confidence: 0.9 }),
      ],
      options,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      chunkId: 'chunk-0',
      globalStartSeconds: 594,
      globalEndSeconds: 607,
      confidence: 0.9,
    });
  });

  it('anchors a merged match to its earliest contributor', () => {
    const merged = aggregateMatches(
      [
        match({ chunkId: 'chunk-1', globalStartSeconds: 601, globalEndSeconds: 610, confidence: 0.95 }),
        match({ chunkId: 'chunk-0', globalStartSeconds: 596, globalEndSeconds: 600.5, confidence: 0.4 }),
      ],
      options,
    );

    // Even though the later piece is more confident, the anchor is the chunk
    // that contains the merged start, so local timestamps stay non-negative.
    expect(merged[0]?.chunkId).toBe('chunk-0');
    expect(merged[0]?.globalStartSeconds).toBe(596);
  });

  it('keeps the description of the most confident contributor', () => {
    const merged = aggregateMatches(
      [
        match({ globalStartSeconds: 10, globalEndSeconds: 20, confidence: 0.4, description: 'vague' }),
        match({ globalStartSeconds: 11, globalEndSeconds: 21, confidence: 0.9, description: 'precise' }),
      ],
      options,
    );

    expect(merged[0]).toMatchObject({ description: 'precise', confidence: 0.9 });
  });

  it('marks a match confirmed by both frames and speech as multimodal', () => {
    const merged = aggregateMatches(
      [
        match({ globalStartSeconds: 10, globalEndSeconds: 20, source: 'visual' }),
        match({ globalStartSeconds: 11, globalEndSeconds: 21, source: 'transcript', quote: 'why I left' }),
      ],
      options,
    );

    expect(merged[0]?.source).toBe('multimodal');
  });

  it('keeps the source when both contributors agree', () => {
    const merged = aggregateMatches(
      [
        match({ globalStartSeconds: 10, globalEndSeconds: 20, source: 'transcript' }),
        match({ globalStartSeconds: 11, globalEndSeconds: 21, source: 'transcript' }),
      ],
      options,
    );

    expect(merged[0]?.source).toBe('transcript');
  });

  it('carries a quote through the merge', () => {
    const merged = aggregateMatches(
      [
        match({ globalStartSeconds: 10, globalEndSeconds: 20, confidence: 0.9, quote: null }),
        match({ globalStartSeconds: 11, globalEndSeconds: 21, confidence: 0.5, quote: 'that is why' }),
      ],
      options,
    );

    expect(merged[0]?.quote).toBe('that is why');
  });

  it('collapses a run of overlapping duplicates into one', () => {
    const merged = aggregateMatches(
      [
        match({ globalStartSeconds: 100, globalEndSeconds: 110 }),
        match({ globalStartSeconds: 104, globalEndSeconds: 114 }),
        match({ globalStartSeconds: 108, globalEndSeconds: 118 }),
      ],
      options,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ globalStartSeconds: 100, globalEndSeconds: 118 });
  });

  it('keeps genuinely distinct moments apart', () => {
    const merged = aggregateMatches(
      [
        match({ globalStartSeconds: 10, globalEndSeconds: 20 }),
        match({ globalStartSeconds: 300, globalEndSeconds: 315 }),
        match({ globalStartSeconds: 1200, globalEndSeconds: 1210 }),
      ],
      options,
    );

    expect(merged).toHaveLength(3);
  });

  it('sorts unordered input by start time', () => {
    const merged = aggregateMatches(
      [
        match({ globalStartSeconds: 500, globalEndSeconds: 510 }),
        match({ globalStartSeconds: 10, globalEndSeconds: 20 }),
        match({ globalStartSeconds: 250, globalEndSeconds: 260 }),
      ],
      options,
    );

    expect(merged.map((entry) => entry.globalStartSeconds)).toEqual([10, 250, 500]);
  });

  it('never merges past the maximum clip duration across a chain', () => {
    const merged = aggregateMatches(
      [
        match({ globalStartSeconds: 0, globalEndSeconds: 150 }),
        match({ globalStartSeconds: 150, globalEndSeconds: 290 }),
        match({ globalStartSeconds: 290, globalEndSeconds: 400 }),
      ],
      options,
    );

    for (const entry of merged) {
      expect(entry.globalEndSeconds - entry.globalStartSeconds).toBeLessThanOrEqual(options.maxDurationSeconds);
    }
  });

  it('handles empty and single-element input', () => {
    expect(aggregateMatches([], options)).toEqual([]);
    expect(aggregateMatches([match({ globalStartSeconds: 1, globalEndSeconds: 2 })], options)).toHaveLength(1);
  });
});
