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
  verify: (scoutId: ScoutId, candidate: Candidate, startSeconds: number) => Promise<boolean>;
}): ScoutRuntime<Candidate> {
  return {
    async inspect({ scoutId, candidate }) {
      return {
        moments: await input.inspect(scoutId, candidate),
        mediaSecondsObserved: 30,
      };
    },
    async verify({ scoutId, candidate, startSeconds }) {
      return {
        match: await input.verify(scoutId, candidate, startSeconds),
        mediaSecondsObserved: 20,
      };
    },
  };
}

describe('runScoutSwarm', () => {
  it('uses exactly four scouts across the whole search and independently confirms a found moment', async () => {
    const inspectors = new Set<ScoutId>();
    const verifiers = new Set<ScoutId>();
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
        async verify(scoutId, candidate, startSeconds) {
          verifiers.add(scoutId);
          expect(candidate.id).toBe('c-1');
          expect(startSeconds).toBe(10);
          return true;
        },
      }),
    });

    expect(SCOUT_IDS).toHaveLength(4);
    expect(result.scoutCount).toBe(4);
    expect(inspectors.size).toBeLessThanOrEqual(4);
    expect(verifiers.size).toBe(2);
    expect(result.confirmed).toHaveLength(1);
    expect(result.confirmed[0]?.agreement).toEqual({ yes: 2, no: 0, required: 2, complete: true });
    expect(result.confirmed[0]?.finderScoutId).not.toBe(result.confirmed[0]?.verdicts[0]?.scoutId);
    expect(result.confirmed[0]?.finderScoutId).not.toBe(result.confirmed[0]?.verdicts[1]?.scoutId);
  });

  it('marks one-confirm one-reject as possible rather than inventing confidence', async () => {
    let verification = 0;
    const result = await runScoutSwarm<Candidate>({
      searchId: 'search-2',
      query: 'find the wave',
      candidates: [{ id: 'only', label: 'only candidate' }],
      runtime: runtimeFor({
        async inspect() {
          return [{ startSeconds: 4, endSeconds: 12, description: 'The person may wave.' }];
        },
        async verify() {
          verification += 1;
          return verification === 1;
        },
      }),
    });

    expect(result.confirmed).toHaveLength(0);
    expect(result.possible).toHaveLength(1);
    expect(result.possible[0]?.agreement).toEqual({ yes: 1, no: 1, required: 2, complete: true });
  });

  it('rejects a moment only after two independent rejections', async () => {
    const result = await runScoutSwarm<Candidate>({
      searchId: 'search-3',
      query: 'find a bicycle',
      candidates: [{ id: 'candidate', label: 'candidate' }],
      runtime: runtimeFor({
        async inspect() {
          return [{ startSeconds: 20, endSeconds: 40, description: 'Possible bicycle.' }];
        },
        async verify() {
          return false;
        },
      }),
    });

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.agreement).toEqual({ yes: 0, no: 2, required: 2, complete: true });
  });

  it('does not force moments when scouts find none', async () => {
    const result = await runScoutSwarm<Candidate>({
      searchId: 'search-4',
      query: 'find something that is not present',
      candidates: [
        { id: 'a', label: 'a' },
        { id: 'b', label: 'b' },
      ],
      runtime: runtimeFor({
        async inspect() {
          return [];
        },
        async verify() {
          throw new Error('verify should not run');
        },
      }),
    });

    expect(result.confirmed).toEqual([]);
    expect(result.possible).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(result.metrics.verifyOperations).toBe(0);
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
        async verify() {
          return true;
        },
      }),
    });

    expect(result.status).toBe('ceiling_reached');
    expect(result.candidatesConsidered).toBe(15);
    expect(result.candidatesCompleted).toBe(15);
  });
});
