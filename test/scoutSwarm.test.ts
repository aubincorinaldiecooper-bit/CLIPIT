import { describe, expect, it } from 'vitest';
import {
  runScoutSwarm,
  SCOUT_IDS,
  type ScoutCandidate,
  type ScoutRuntime,
  type ScoutId,
} from '../src/services/retrieval/scoutSwarm.js';

interface Candidate extends ScoutCandidate {
  label: string;
}

function runtimeFor(input: {
  inspect: (scoutId: ScoutId, candidate: Candidate) => Promise<Array<{ startSeconds: number; endSeconds: number; description: string }>>;
}): ScoutRuntime<Candidate> {
  return {
    async inspect({ scoutId, candidate }) {
      return {
        moments: await input.inspect(scoutId, candidate),
        mediaSecondsObserved: 30,
      };
    },
  };
}

/** A runtime that reports findings as it goes, the way a live watcher does. */
function streamingRuntimeFor(input: {
  frames: (candidate: Candidate) => Array<{ startSeconds: number; endSeconds: number; description: string }>;
}): ScoutRuntime<Candidate> {
  return {
    async inspect({ candidate, onMoment }) {
      for (const frame of input.frames(candidate)) await onMoment?.(frame);
      return { moments: [], mediaSecondsObserved: 30, exhausted: true };
    },
  };
}

/**
 * One finding per second of an event, which is what a watcher asked about each
 * frame in turn actually produces.
 */
function secondBySecond(from: number, to: number, description: string) {
  return Array.from({ length: to - from }, (_, index) => ({
    startSeconds: from + index,
    endSeconds: from + index + 1,
    description,
  }));
}

describe('runScoutSwarm', () => {
  it('uses exactly four scouts across the whole search and surfaces a found moment directly', async () => {
    const inspectors = new Set<ScoutId>();
    const progress: string[] = [];
    const result = await runScoutSwarm<Candidate>({
      searchId: 'search-1',
      query: 'find the red backpack',
      candidates: Array.from({ length: 8 }, (_, index) => ({ id: `c-${index + 1}`, label: `candidate ${index + 1}` })),
      runtime: runtimeFor({
        async inspect(scoutId, candidate) {
          inspectors.add(scoutId);
          if (candidate.id !== 'c-1') return [];
          return [{ startSeconds: 10, endSeconds: 32, description: 'A person picks up the red backpack.' }];
        },
      }),
      onProgress(event) {
        progress.push(event.event);
      },
    });

    expect(SCOUT_IDS).toHaveLength(4);
    expect(result.scoutCount).toBe(4);
    expect(inspectors.size).toBeLessThanOrEqual(4);
    expect(result.moments).toHaveLength(1);
    expect(result.moments[0]?.candidate.id).toBe('c-1');
    expect(progress).toContain('moment.found');
  });

  it('does not require replay or independent verification before returning a relevant moment', async () => {
    let inspections = 0;
    const result = await runScoutSwarm<Candidate>({
      searchId: 'search-2',
      query: 'find the wave',
      candidates: [{ id: 'only', label: 'only candidate' }],
      runtime: runtimeFor({
        async inspect() {
          inspections += 1;
          return [{ startSeconds: 4, endSeconds: 12, description: 'The person waves.' }];
        },
      }),
    });

    expect(inspections).toBe(1);
    expect(result.moments).toHaveLength(1);
    expect(result.metrics.inspectOperations).toBe(1);
  });

  it('does not force moments when scouts find none', async () => {
    const result = await runScoutSwarm<Candidate>({
      searchId: 'search-3',
      query: 'find something that is not present',
      candidates: [
        { id: 'a', label: 'a' },
        { id: 'b', label: 'b' },
      ],
      runtime: runtimeFor({
        async inspect() {
          return [];
        },
      }),
    });

    expect(result.moments).toEqual([]);
  });

  it('allows exactly one valid result without trying to manufacture more', async () => {
    const result = await runScoutSwarm<Candidate>({
      searchId: 'search-4',
      query: 'find the only occurrence',
      candidates: [
        { id: 'a', label: 'a' },
        { id: 'b', label: 'b' },
        { id: 'c', label: 'c' },
      ],
      runtime: runtimeFor({
        async inspect(_scoutId, candidate) {
          return candidate.id === 'b'
            ? [{ startSeconds: 20, endSeconds: 45, description: 'The only matching moment.' }]
            : [];
        },
      }),
    });

    expect(result.moments).toHaveLength(1);
    expect(result.moments[0]?.candidate.id).toBe('b');
  });

  it('caps the search at fifteen candidates', async () => {
    const result = await runScoutSwarm<Candidate>({
      searchId: 'search-5',
      query: 'anything',
      candidates: Array.from({ length: 20 }, (_, index) => ({ id: `candidate-${index}`, label: String(index) })),
      runtime: runtimeFor({
        async inspect() {
          return [];
        },
      }),
    });

    expect(result.status).toBe('ceiling_reached');
    expect(result.candidatesConsidered).toBe(15);
    expect(result.candidatesCompleted).toBe(15);
  });
  it('keeps one card for one event when the watcher answers about every frame', async () => {
    const events: string[] = [];
    const result = await runScoutSwarm<Candidate>({
      searchId: 'search-6',
      query: 'find when the skateboarder falls',
      candidates: [{ id: 'only', label: 'only candidate' }],
      runtime: streamingRuntimeFor({ frames: () => secondBySecond(42, 46, 'The skateboarder loses balance.') }),
      onProgress(progress) {
        events.push(progress.event);
      },
    });

    expect(result.moments).toHaveLength(1);
    expect(result.moments[0]?.startSeconds).toBe(42);
    expect(result.moments[0]?.endSeconds).toBe(46);
    expect(result.moments[0]?.description).toBe('The skateboarder loses balance.');
    expect(events.filter((event) => event === 'moment.found')).toHaveLength(1);
    expect(events.filter((event) => event === 'moment.extended')).toHaveLength(3);
  });

  it('starts a new moment when the next finding is not part of the same event', async () => {
    const result = await runScoutSwarm<Candidate>({
      searchId: 'search-7',
      query: 'find every wave',
      candidates: [{ id: 'only', label: 'only candidate' }],
      runtime: streamingRuntimeFor({
        frames: () => [...secondBySecond(10, 12, 'She waves.'), ...secondBySecond(30, 31, 'She waves again.')],
      }),
    });

    expect(result.moments).toHaveLength(2);
    expect(result.moments[0]).toMatchObject({ startSeconds: 10, endSeconds: 12, description: 'She waves.' });
    expect(result.moments[1]).toMatchObject({ startSeconds: 30, endSeconds: 31, description: 'She waves again.' });
  });

  it('keeps two things seen a second apart as two moments, not one', async () => {
    const result = await runScoutSwarm<Candidate>({
      searchId: 'search-10',
      query: 'find people waving',
      candidates: [{ id: 'only', label: 'only candidate' }],
      runtime: streamingRuntimeFor({
        frames: () => [
          ...secondBySecond(10, 11, 'A woman waves from the left.'),
          ...secondBySecond(12, 13, 'A man waves from the right.'),
        ],
      }),
    });

    // One second apart, so near enough in time to join. Different accounts of
    // what is happening, so two different things: keeping one would put the
    // woman's words over the man's moment and lose his entirely.
    expect(result.moments).toHaveLength(2);
    expect(result.moments.map((moment) => moment.description)).toEqual([
      'A woman waves from the left.',
      'A man waves from the right.',
    ]);
    expect(result.moments.map((moment) => [moment.startSeconds, moment.endSeconds])).toEqual([
      [10, 11],
      [12, 13],
    ]);
  });

  it('never joins findings that came from two different pages', async () => {
    const result = await runScoutSwarm<Candidate>({
      searchId: 'search-8',
      query: 'find the dog',
      candidates: [
        { id: 'a', label: 'a' },
        { id: 'b', label: 'b' },
      ],
      runtime: streamingRuntimeFor({ frames: (candidate) => secondBySecond(5, 8, `A dog on ${candidate.id}.`) }),
    });

    // One moment per page: each page's own run joins up, and the two pages
    // never join each other however close their timestamps are.
    expect(result.moments).toHaveLength(2);
    expect(result.moments.map((moment) => moment.candidate.id).sort()).toEqual(['a', 'b']);
    for (const moment of result.moments) expect(moment).toMatchObject({ startSeconds: 5, endSeconds: 8 });
  });

  it('stops a moment growing at the maximum length instead of making one long card', async () => {
    const result = await runScoutSwarm<Candidate>({
      searchId: 'search-9',
      query: 'find the thing that never stops',
      candidates: [{ id: 'only', label: 'only candidate' }],
      maxMomentSeconds: 4,
      runtime: streamingRuntimeFor({ frames: () => secondBySecond(0, 10, 'It is still happening.') }),
    });

    // Ten seconds of continuous matching, cut into the longest moments the
    // ceiling allows rather than one card per second or one card of ten.
    expect(result.moments.map((moment) => [moment.startSeconds, moment.endSeconds])).toEqual([
      [0, 4],
      [4, 8],
      [8, 10],
    ]);
  });
});
