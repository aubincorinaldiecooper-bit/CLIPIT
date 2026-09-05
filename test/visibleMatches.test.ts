import { describe, expect, it } from 'vitest';
import { visibleMatches } from '../src/api/serializers.js';
import type { ClipMatch } from '../src/domain/types.js';

/**
 * A creator sees every moment a finished search found — with or without a
 * file behind it — and none of an unfinished one, whose ids may still change
 * when the search folds duplicates together at the end. The only cap is a
 * number the person wrote.
 */

const match = (id: string, confidence = 0.5): ClipMatch => ({ id, confidence } as ClipMatch);
const found = [match('a', 0.6), match('b', 0.9), match('c', 0.7)];
const open = { requestedResultCount: null };

describe('visibleMatches', () => {
  it('shows every moment of a completed search, whether or not a clip exists for it', () => {
    expect(visibleMatches({ status: 'completed', ...open }, found).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('shows a completed search with nothing found as nothing — a real answer', () => {
    expect(visibleMatches({ status: 'completed', ...open }, [])).toEqual([]);
  });

  it('holds moments back while the search is still running or queued, because their ids are not final', () => {
    expect(visibleMatches({ status: 'searching', ...open }, found)).toEqual([]);
    expect(visibleMatches({ status: 'pending', ...open }, found)).toEqual([]);
  });

  it('shows nothing for a failed search', () => {
    expect(visibleMatches({ status: 'failed', ...open }, found)).toEqual([]);
  });

  describe('a number the person wrote', () => {
    it('shows the best that many, by confidence, in the stored order', () => {
      expect(visibleMatches({ status: 'completed', requestedResultCount: 2 }, found).map((m) => m.id)).toEqual(['b', 'c']);
    });

    it('never pads: three asked for and two found is two', () => {
      const two = [match('a', 0.6), match('b', 0.9)];
      expect(visibleMatches({ status: 'completed', requestedResultCount: 3 }, two).map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('one asked for stays one, and is the strongest', () => {
      expect(visibleMatches({ status: 'completed', requestedResultCount: 1 }, found).map((m) => m.id)).toEqual(['b']);
    });

    it('breaks a tie the same way every time', () => {
      const tied = [match('z', 0.8), match('y', 0.8), match('x', 0.8)];
      expect(visibleMatches({ status: 'completed', requestedResultCount: 2 }, tied).map((m) => m.id)).toEqual(['y', 'x']);
      expect(visibleMatches({ status: 'completed', requestedResultCount: 2 }, [...tied].reverse()).map((m) => m.id)).toEqual(['x', 'y']);
    });

    it('is not a product default — no number written means no cap at all', () => {
      const many = Array.from({ length: 17 }, (_, i) => match(`m${i}`, Math.random()));
      expect(visibleMatches({ status: 'completed', ...open }, many)).toHaveLength(17);
    });
  });
});
