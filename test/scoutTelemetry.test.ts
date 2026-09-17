import { describe, expect, it } from 'vitest';
import { runScoutSwarm, type ScoutCandidate, type ScoutRuntime } from '../src/services/retrieval/scoutSwarm.js';

interface Candidate extends ScoutCandidate { label: string; }

function candidate(id = 'c-1'): Candidate { return { id, label: id }; }

describe('scout telemetry', () => {
  it('preserves per-inspection model metrics for production observability', async () => {
    const runtime: ScoutRuntime<Candidate> = {
      async inspect({ scoutId }) {
        return {
          moments: [],
          mediaSecondsObserved: 4,
          exhausted: true,
          exhaustive: false,
          metrics: {
            container: 'modal-container-1',
            client_frames_sent: 24,
            client_frames_processed: 24,
            client_frames_dropped_for_lag: 0,
            rounds_processed: 4,
            high_res_rounds: scoutId === 'scout-1' ? 1 : 0,
            max_video_lag_ms: 350,
            total_ms: 4000,
          },
        };
      },
    };

    const result = await runScoutSwarm({ searchId: 'telemetry', query: 'thing', candidates: [candidate()], runtime });

    expect(result.inspections).toHaveLength(4);
    expect(result.inspections.every((inspection) => inspection.success)).toBe(true);
    expect(result.inspections.every((inspection) => inspection.metrics.container === 'modal-container-1')).toBe(true);
    expect(result.metrics.inspectOperations).toBe(4);
    expect(result.metrics.mediaSecondsObserved).toBe(16);
    expect(result.metrics.firstMomentMs).toBeNull();
  });

  it('records failed inspections instead of losing their diagnostic context', async () => {
    const runtime: ScoutRuntime<Candidate> = {
      async inspect({ scoutId }) {
        if (scoutId === 'scout-2') throw new Error('browser player disappeared');
        return { moments: [], exhausted: true, exhaustive: false };
      },
    };

    const result = await runScoutSwarm({ searchId: 'telemetry-failure', query: 'thing', candidates: [candidate()], runtime });
    const failed = result.inspections.find((inspection) => inspection.scoutId === 'scout-2');

    expect(failed).toMatchObject({ success: false, failureReason: 'browser player disappeared' });
    expect(result.failures).toContainEqual({
      scoutId: 'scout-2',
      candidateId: 'c-1',
      stage: 'inspect',
      reason: 'browser player disappeared',
    });
  });

  it('records time to first verified dense moment', async () => {
    const runtime: ScoutRuntime<Candidate> = {
      async inspect({ plan, onMoment }) {
        if (plan.mode === 'coarse' && plan.startSeconds === 0) {
          return {
            moments: [{ startSeconds: 10, endSeconds: 11, description: 'Possible event.' }],
            exhausted: true,
            exhaustive: false,
          };
        }
        if (plan.mode === 'continuous') {
          await onMoment?.({ startSeconds: 10, endSeconds: 12, description: 'Verified event.', confidence: 0.9 });
          return { moments: [], exhausted: true, exhaustive: true };
        }
        return { moments: [], exhausted: true, exhaustive: false };
      },
    };

    const result = await runScoutSwarm({ searchId: 'first-result', query: 'event', candidates: [candidate()], runtime });

    expect(result.moments).toHaveLength(1);
    expect(result.metrics.firstMomentMs).not.toBeNull();
    expect(result.metrics.firstMomentMs).toBeGreaterThanOrEqual(0);
  });
});
