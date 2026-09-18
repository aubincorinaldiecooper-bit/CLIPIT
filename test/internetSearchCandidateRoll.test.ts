import { describe, expect, it } from 'vitest';
import type { Candidate } from '../src/services/discovery/searxng.js';
import { candidateRoll, MAX_REPORTED_CANDIDATES } from '../src/worker/handlers/internetSearch.js';
import { endingForStoppedSearch } from '../src/services/retrieval/internetSearchOutcome.js';

const page = (n: number, url?: string): Candidate => ({
  id: `c${n}`,
  pageUrl: url ?? `https://www.youtube.com/watch?v=vid${n}`,
  title: `Video ${n}`,
  source: 'youtube.com',
} as Candidate);

const stateOf = (roll: ReturnType<typeof candidateRoll>, id: string) =>
  roll.find((entry) => entry.id === id)?.state;

describe('the roll of pages a search was given', () => {
  it('says nobody was sent, before anybody is sent', () => {
    const roll = candidateRoll([page(1), page(2)], new Set(), [], true);
    expect(roll.map((entry) => entry.state)).toEqual(['not_reached', 'not_reached']);
  });

  it('separates the one being watched from the one already watched', () => {
    const roll = candidateRoll([page(1), page(2), page(3)], new Set(['c1', 'c2']), ['c1'], true);
    expect(stateOf(roll, 'c1')).toBe('watched');
    expect(stateOf(roll, 'c2')).toBe('watching');
    expect(stateOf(roll, 'c3')).toBe('not_reached');
  });

  /*
   * The rule this file exists for.
   *
   * The swarm takes at most `maxCandidates` of what discovery found, and a
   * search that dies stops handing them out. A page nobody was ever sent to
   * has told us nothing about itself. Reporting it as one that would not open
   * invents a failure for a page that was never opened — the same false
   * absence, one level down.
   */
  it('never reports a page nobody was sent to as one that would not open', () => {
    const roll = candidateRoll([page(1), page(2), page(3)], new Set(['c1']), [], false);
    expect(stateOf(roll, 'c1')).toBe('unwatched');
    expect(stateOf(roll, 'c2')).toBe('not_reached');
    expect(stateOf(roll, 'c3')).toBe('not_reached');
    expect(stateOf(roll, 'c2')).not.toBe('unwatched');
  });

  it('leaves nothing on "watching" once the search has stopped', () => {
    const roll = candidateRoll([page(1), page(2)], new Set(['c1', 'c2']), ['c1'], false);
    expect(roll.some((entry) => entry.state === 'watching')).toBe(false);
    expect(stateOf(roll, 'c2')).toBe('unwatched');
  });

  it('redacts the address, keeping only what names a video', () => {
    const roll = candidateRoll(
      [
        page(1, 'https://cdn.example/video?token=abc123'),
        page(2, 'https://user:hunter2@cdn.example/video'),
        page(3, 'https://www.youtube.com/watch?v=dQw4&t=42&si=SECRET'),
      ],
      new Set(),
      [],
      true,
    );
    expect(roll.map((entry) => entry.page)).toEqual([
      'https://cdn.example/video',
      'https://cdn.example/video',
      'https://www.youtube.com/watch?v=dQw4',
    ]);
    // Nothing in the roll may carry a secret through to a browser.
    for (const entry of roll) {
      expect(entry.page).not.toContain('token');
      expect(entry.page).not.toContain('hunter2');
      expect(entry.page).not.toContain('SECRET');
    }
  });

  it('caps what rides on every poll', () => {
    const many = Array.from({ length: MAX_REPORTED_CANDIDATES + 15 }, (_, n) => page(n));
    expect(candidateRoll(many, new Set(), [], true)).toHaveLength(MAX_REPORTED_CANDIDATES);
  });
});

describe('the roll of a search that stopped rather than ended', () => {
  const lastKnown = {
    moments: [],
    candidatesFound: 3,
    candidatesWatched: 1,
    candidates: candidateRoll([page(1), page(2), page(3)], new Set(['c1', 'c2']), ['c1'], true),
  };

  it('stops showing a page as being watched when nothing is watching it', () => {
    // The last thing the search wrote down was written while it was still
    // going, so c2 was recorded as `watching`. The search is over. Left alone
    // the screen would spin against that page for ever.
    expect(stateOf(lastKnown.candidates, 'c2')).toBe('watching');
    const done = endingForStoppedSearch(lastKnown, 'job stalled more than allowable limit');
    expect(done.candidates?.find((entry) => entry.id === 'c2')?.state).toBe('unwatched');
  });

  it('does not turn a page nobody reached into one that was tried', () => {
    const done = endingForStoppedSearch(lastKnown, 'job stalled more than allowable limit');
    expect(done.candidates?.find((entry) => entry.id === 'c3')?.state).toBe('not_reached');
  });

  it('leaves a finished watch alone', () => {
    const done = endingForStoppedSearch(lastKnown, 'job stalled more than allowable limit');
    expect(done.candidates?.find((entry) => entry.id === 'c1')?.state).toBe('watched');
  });

  it('carries no roll at all when there was never one', () => {
    const done = endingForStoppedSearch({ moments: [], candidatesFound: 0 }, 'boom');
    expect(done.candidates).toBeUndefined();
  });
});
