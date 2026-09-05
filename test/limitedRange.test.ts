import { describe, expect, it } from 'vitest';
import { limitedRange } from '../src/services/timestamps.js';

/**
 * The row is told when a limit changed the cut, and only then. Padding on
 * its own is not written back (it would widen again on every re-render);
 * a limit is, because the file then covers different footage from the
 * moment.
 */
const base = { paddingSeconds: 0, videoDurationSeconds: 1000, minDurationSeconds: 1 };

describe('limitedRange', () => {
  it('is the moment itself when nothing constrains it', () => {
    expect(limitedRange({ startSeconds: 100, endSeconds: 123 }, { ...base, maxDurationSeconds: 300 })).toEqual({
      range: { startSeconds: 100, endSeconds: 123 },
      limited: false,
    });
  });

  it('reports a limit that shortened it', () => {
    expect(limitedRange({ startSeconds: 128, endSeconds: 151 }, { ...base, maxDurationSeconds: 10 })).toEqual({
      range: { startSeconds: 128, endSeconds: 138 },
      limited: true,
    });
  });

  it('does not report padding alone', () => {
    expect(limitedRange({ startSeconds: 100, endSeconds: 123 }, { ...base, paddingSeconds: 2, maxDurationSeconds: 300 })).toEqual({
      range: { startSeconds: 98, endSeconds: 125 },
      limited: false,
    });
  });

  it('reports a moment already at the limit that padding shifted and the limit capped — same length, different footage', () => {
    // Devin's finding on #95: padded at both ends, then capped from the
    // earlier start, the range keeps its length and still moves.
    const result = limitedRange({ startSeconds: 100, endSeconds: 400 }, { ...base, paddingSeconds: 2, maxDurationSeconds: 300 });
    expect(result.range).toEqual({ startSeconds: 98, endSeconds: 398 });
    expect(result.limited).toBe(true);
  });
});
