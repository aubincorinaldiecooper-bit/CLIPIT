import { describe, expect, it } from 'vitest';
import { visibleMatches } from '../src/api/serializers.js';
import type { ClipMatch } from '../src/domain/types.js';

/**
 * A creator sees every moment a finished search found — with or without a
 * file behind it — and none of an unfinished one, whose ids may still change
 * when the search folds duplicates together at the end.
 */

const match = (id: string): ClipMatch => ({ id } as ClipMatch);
const found = [match('a'), match('b'), match('c')];

describe('visibleMatches', () => {
  it('shows every moment of a completed search, whether or not a clip exists for it', () => {
    expect(visibleMatches({ status: 'completed' }, found).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('shows a completed search with nothing found as nothing — a real answer', () => {
    expect(visibleMatches({ status: 'completed' }, [])).toEqual([]);
  });

  it('holds moments back while the search is still running or queued, because their ids are not final', () => {
    expect(visibleMatches({ status: 'searching' }, found)).toEqual([]);
    expect(visibleMatches({ status: 'pending' }, found)).toEqual([]);
  });

  it('shows nothing for a failed search', () => {
    expect(visibleMatches({ status: 'failed' }, found)).toEqual([]);
  });
});
