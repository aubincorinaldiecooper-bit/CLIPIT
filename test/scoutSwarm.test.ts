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
  it('splits one candidate into four concurrent 150-second coarse sections', async () => {
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
      [0, 150],
      [150, 300],
      [300, 450],
      [450, 600],
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

  it('uses a coarse hit only as a locator and surfaces the dense re-watch result', async () => {
    const plans: ScoutInspectionPlan[] = [];
    const runtime: ScoutRuntime<Candidate> = {
      async inspect({ plan, onMoment }) {
        plans.push(plan);
        if (plan.mode === 'coarse' && plan.startSeconds === 150) {
          return {
            moments: [{ startSeconds: 210, endSeconds: 211, description: 'Possible red backpack.', confidence: 0.55 }],
            exhausted: true,
            exhaustive: false,
          };
        }
        if (plan.mode === 'continuous') {
          const dense = { startSeconds: 209.5, endSeconds: 212, description: 'A person picks up the red backpack.', confidence: 0.93 };
          await onMoment?.(dense);
          return { moments: [], exhausted: true, exhaustive: true };
        }
        return { moments: [], exhausted: true, exhaustive: false };
      },
    };
    const events: string[] = [];
    const result = await runScoutSwarm({
      searchId: 's', query: 'red backpack', candidates: [candidate()], runtime,
      onProgress(progress) { events.push(progress.event); },
    });

    expect(plans.filter((plan) => plan.mode === 'continuous')).toHaveLength(1);
    expect(plans.find((plan) => plan.mode === 'continuous')).toMatchObject({ startSeconds: 204, endSeconds: 217 });
    expect(result.moments).toHaveLength(1);
    expect(result.moments[0]).toMatchObject({ startSeconds: 209.5, endSeconds: 212, confidence: 0.93 });
    expect(result.moments[0]?.description).toBe('A person picks up the red backpack.');
    expect(events).toContain('moment.found');
    expect(JSON.stringify(result.moments)).not.toContain('Possible red backpack');
  });

  it('deduplicates overlapping coarse hits before dense re-watch', async () => {
    let denseCalls = 0;
    const runtime: ScoutRuntime<Candidate> = {
      async inspect({ plan }) {
        if (plan.mode === 'coarse' && plan.startSeconds === 0) {
          return {
            moments: [
              { startSeconds: 20, endSeconds: 21, description: 'Maybe.' },
              { startSeconds: 22, endSeconds: 23, description: 'Maybe.' },
            ],
            exhausted: true,
            exhaustive: false,
          };
        }
        if (plan.mode === 'continuous') {
          denseCalls += 1;
          return { moments: [{ startSeconds: 20, endSeconds: 23, description: 'Confirmed.' }], exhausted: true, exhaustive: true };
        }
        return { moments: [], exhausted: true, exhaustive: false };
      },
    };
    const result = await runScoutSwarm({ searchId: 's', query: 'thing', candidates: [candidate()], runtime });
    expect(denseCalls).toBe(1);
    expect(result.moments).toHaveLength(1);
  });

  it('keeps separate dense findings as separate moments', async () => {
    const runtime: ScoutRuntime<Candidate> = {
      async inspect({ plan }) {
        if (plan.mode === 'coarse' && plan.startSeconds === 0) {
          return {
            moments: [
              { startSeconds: 20, endSeconds: 21, description: 'First maybe.' },
              { startSeconds: 80, endSeconds: 81, description: 'Second maybe.' },
            ],
            exhausted: true,
            exhaustive: false,
          };
        }
        if (plan.mode === 'continuous' && plan.startSeconds < 50) {
          return { moments: [{ startSeconds: 20, endSeconds: 22, description: 'First confirmed.' }], exhausted: true, exhaustive: true };
        }
        if (plan.mode === 'continuous') {
          return { moments: [{ startSeconds: 80, endSeconds: 82, description: 'Second confirmed.' }], exhausted: true, exhaustive: true };
        }
        return { moments: [], exhausted: true, exhaustive: false };
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

  it('merges frame-by-frame dense repeats of the same event and keeps the strongest confidence', async () => {
    const runtime: ScoutRuntime<Candidate> = {
      async inspect({ plan, onMoment }) {
        if (plan.mode === 'coarse' && plan.startSeconds === 0) {
          return { moments: [{ startSeconds: 10, endSeconds: 11, description: 'Maybe.' }], exhausted: true, exhaustive: false };
        }
        if (plan.mode === 'continuous') {
          for (const row of [
            { startSeconds: 10, endSeconds: 11, description: 'He falls.', confidence: 0.4 },
            { startSeconds: 11, endSeconds: 12, description: 'He falls.', confidence: 0.9 },
            { startSeconds: 12, endSeconds: 13, description: 'He falls.', confidence: 0.5 },
          ]) await onMoment?.(row);
          return { moments: [], exhausted: true, exhaustive: true };
        }
        return { moments: [], exhausted: true, exhaustive: false };
      },
    };
    const result = await runScoutSwarm({ searchId: 's', query: 'fall', candidates: [candidate()], runtime });
    expect(result.moments).toHaveLength(1);
    expect(result.moments[0]).toMatchObject({ startSeconds: 10, endSeconds: 13, confidence: 0.9 });
  });
});
