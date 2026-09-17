import { describe, expect, it } from 'vitest';
import {
  runScoutSwarm,
  SCOUT_IDS,
  type ScoutCandidate,
  type ScoutInspectionPlan,
  type ScoutRuntime,
  type ScoutId,
} from '../src/services/retrieval/scoutSwarm.js';

interface Candidate extends ScoutCandidate { label: string; }

function candidate(id = 'c-1'): Candidate { return { id, label: id }; }

describe('runScoutSwarm', () => {
  it('runs four staggered sparse passes over the same candidate horizon', async () => {
    const seen: Array<{ scoutId: ScoutId; plan: ScoutInspectionPlan }> = [];
    const runtime: ScoutRuntime<Candidate> = {
      async inspect({ scoutId, plan }) {
        seen.push({ scoutId, plan });
        return { moments: [], mediaSecondsObserved: 30, exhausted: true, exhaustive: false };
      },
    };

    const result = await runScoutSwarm({ searchId: 's', query: 'thing', candidates: [candidate()], runtime });

    expect(SCOUT_IDS).toHaveLength(4);
    expect(result.scoutCount).toBe(4);
    expect(seen).toHaveLength(4);
    expect(seen.map((row) => [row.plan.startSeconds, row.plan.endSeconds])).toEqual([
      [0, 600],
      [1.25, 600],
      [2.5, 600],
      [3.75, 600],
    ]);
    expect(seen.every((row) => row.plan.mode === 'coarse')).toBe(true);
    expect(result.metrics.mediaSecondsObserved).toBe(120);
  });

  it('caps ranked candidates at seven', async () => {
    let calls = 0;
    const runtime: ScoutRuntime<Candidate> = {
      async inspect() {
        calls += 1;
        return { moments: [], exhausted: true, exhaustive: false };
      },
    };
    const result = await runScoutSwarm({
      searchId: 's', query: 'thing', runtime,
      candidates: Array.from({ length: 12 }, (_, index) => candidate(`c-${index + 1}`)),
    });
    expect(result.status).toBe('ceiling_reached');
    expect(result.candidatesConsidered).toBe(7);
    expect(result.candidatesCompleted).toBe(7);
    expect(calls).toBe(28);
  });

  it('does not spend dense inference when coarse search finds nothing', async () => {
    const modes: string[] = [];
    const runtime: ScoutRuntime<Candidate> = {
      async inspect({ plan }) {
        modes.push(plan.mode);
        return { moments: [], exhausted: true, exhaustive: false };
      },
    };
    const result = await runScoutSwarm({ searchId: 's', query: 'missing', candidates: [candidate()], runtime });
    expect(modes).toEqual(['coarse', 'coarse', 'coarse', 'coarse']);
    expect(result.moments).toEqual([]);
  });

  it('surfaces sparse hits directly without any dense re-watch', async () => {
    const plans: ScoutInspectionPlan[] = [];
    const runtime: ScoutRuntime<Candidate> = {
      async inspect({ scoutId, plan }) {
        plans.push(plan);
        if (scoutId === 'scout-2') {
          return {
            moments: [{ startSeconds: 210, endSeconds: 211, description: 'Possible red backpack.', confidence: 0.55 }],
            exhausted: true,
            exhaustive: false,
          };
        }
        return { moments: [], exhausted: true, exhaustive: false };
      },
    };
    const result = await runScoutSwarm({ searchId: 's', query: 'red backpack', candidates: [candidate()], runtime });

    expect(plans).toHaveLength(4);
    expect(plans.every((plan) => plan.mode === 'coarse')).toBe(true);
    expect(result.moments).toHaveLength(1);
    expect(result.moments[0]).toMatchObject({
      startSeconds: 210,
      endSeconds: 211,
      confidence: 0.55,
      scoutVotes: 1,
    });
  });

  it('raises signal strength when independent scouts flag the same area', async () => {
    const runtime: ScoutRuntime<Candidate> = {
      async inspect({ scoutId }) {
        if (scoutId === 'scout-1') {
          return {
            moments: [{ startSeconds: 20, endSeconds: 21, description: 'Red backpack.', confidence: 0.6 }],
            exhausted: true,
            exhaustive: false,
          };
        }
        if (scoutId === 'scout-2') {
          return {
            moments: [{ startSeconds: 21, endSeconds: 22, description: 'A red backpack appears.', confidence: 0.8 }],
            exhausted: true,
            exhaustive: false,
          };
        }
        return { moments: [], exhausted: true, exhaustive: false };
      },
    };
    const result = await runScoutSwarm({ searchId: 's', query: 'red backpack', candidates: [candidate()], runtime });
    expect(result.moments).toHaveLength(1);
    expect(result.moments[0]).toMatchObject({
      startSeconds: 20,
      endSeconds: 22,
      confidence: 0.8,
      scoutVotes: 2,
    });
  });

  it('keeps temporally separate sparse signals as separate candidates', async () => {
    const runtime: ScoutRuntime<Candidate> = {
      async inspect({ scoutId }) {
        if (scoutId !== 'scout-1') return { moments: [], exhausted: true, exhaustive: false };
        return {
          moments: [
            { startSeconds: 20, endSeconds: 21, description: 'First signal.' },
            { startSeconds: 80, endSeconds: 81, description: 'Second signal.' },
          ],
          exhausted: true,
          exhaustive: false,
        };
      },
    };
    const result = await runScoutSwarm({ searchId: 's', query: 'thing', candidates: [candidate()], runtime });
    expect(result.moments.map((moment) => moment.startSeconds)).toEqual([20, 80]);
  });

  it('marks sparse candidates as partly examined so zero is not presented as exhaustive absence', async () => {
    const runtime: ScoutRuntime<Candidate> = {
      async inspect() { return { moments: [], exhausted: true, exhaustive: false }; },
    };
    const result = await runScoutSwarm({ searchId: 's', query: 'missing', candidates: [candidate()], runtime });
    expect(result.candidatesPartlyExamined).toBe(1);
  });

  it('does not count repeated hits from one scout as multiple votes', async () => {
    const runtime: ScoutRuntime<Candidate> = {
      async inspect({ scoutId }) {
        if (scoutId !== 'scout-1') return { moments: [], exhausted: true, exhaustive: false };
        return {
          moments: [
            { startSeconds: 10, endSeconds: 11, description: 'He falls.', confidence: 0.4 },
            { startSeconds: 11, endSeconds: 12, description: 'He falls.', confidence: 0.9 },
          ],
          exhausted: true,
          exhaustive: false,
        };
      },
    };
    const result = await runScoutSwarm({ searchId: 's', query: 'fall', candidates: [candidate()], runtime });
    expect(result.moments).toHaveLength(1);
    expect(result.moments[0]).toMatchObject({ startSeconds: 10, endSeconds: 12, confidence: 0.9, scoutVotes: 1 });
  });
});
