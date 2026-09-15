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
});
