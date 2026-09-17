import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Candidate } from '../src/services/discovery/searxng.js';
import type { ScoutInspection, ScoutInspectionPlan } from '../src/services/retrieval/scoutSwarm.js';
import type { InternetSearchJob, InternetSearchProgress } from '../src/queues/internetSearch.js';

const found = vi.fn<[], Promise<Candidate[]>>();
const inspect = vi.fn<[{ candidate: Candidate; plan: ScoutInspectionPlan; onMoment?: (moment: any) => Promise<void> | void }], Promise<ScoutInspection>>();

vi.mock('../src/services/discovery/searxng.js', () => ({ search: () => found() }));
vi.mock('../src/services/retrieval/videoModelScoutRuntime.js', () => ({
  createVideoModelScoutRuntime: () => ({ inspect: (input: { candidate: Candidate; plan: ScoutInspectionPlan; onMoment?: (moment: any) => Promise<void> | void }) => inspect(input) }),
}));
vi.mock('../src/services/video/adapters/videochat3.js', () => ({ videoChat3Adapter: { id: 'videochat3', sourceKinds: new Set(['frame-stream']) } }));

const { handleInternetSearch } = await import('../src/worker/handlers/internetSearch.js');

function candidate(id: string, source: string | null = 'youtube.com'): Candidate {
  return { id, query: 'a dog on a skateboard', title: `page ${id}`, pageUrl: `https://publisher.example/watch/${id}`, thumbnailUrl: `https://publisher.example/still/${id}.jpg`, source };
}
function fakeJob() {
  const reported: InternetSearchProgress[] = [];
  const job = {
    id: '11111111-2222-3333-4444-555555555555',
    data: { query: 'a dog on a skateboard', sessionId: 's', userId: null } as InternetSearchJob,
    async updateProgress(progress: unknown) { reported.push(structuredClone(progress) as InternetSearchProgress); },
  };
  return { job: job as unknown as Job<InternetSearchJob>, reported };
}

beforeEach(() => {
  found.mockReset();
  inspect.mockReset();
  process.env.WEB_ACCESS_URL = 'http://web-access.internal:8080';
  process.env.WEB_ACCESS_INTERNAL_TOKEN = 'token';
  process.env.VIDEO_STREAM_V2 = 'true';
  delete process.env.INTERNET_SEARCH_MAX_CANDIDATES;
  delete process.env.INTERNET_WATCH_MAX_SECONDS;
});

describe('internet search handler', () => {
  it('shows loading first and answers cleanly when discovery finds nothing', async () => {
    found.mockResolvedValue([]);
    const { job, reported } = fakeJob();
    const result = await handleInternetSearch(job);
    expect(reported[0]).toEqual({ phase: 'loading', moments: [], candidatesFound: 0 });
    expect(result).toEqual({ phase: 'answered', moments: [], candidatesFound: 0 });
  });

  it('limits the ranked discovery set to seven videos', async () => {
    found.mockResolvedValue(Array.from({ length: 12 }, (_, index) => candidate(`c-${index + 1}`)));
    inspect.mockResolvedValue({ moments: [], exhausted: true, exhaustive: false });
    const { job, reported } = fakeJob();
    await handleInternetSearch(job);
    expect(reported.find((step) => step.phase === 'searching')?.candidatesFound).toBe(7);
    expect(new Set(inspect.mock.calls.map(([input]) => input.candidate.id))).toEqual(new Set(['c-1', 'c-2', 'c-3', 'c-4', 'c-5', 'c-6', 'c-7']));
  });

  it('uses four coarse sections of the first 600 seconds for each candidate', async () => {
    found.mockResolvedValue([candidate('a')]);
    inspect.mockResolvedValue({ moments: [], exhausted: true, exhaustive: false });
    const { job } = fakeJob();
    await handleInternetSearch(job);
    const coarse = inspect.mock.calls.map(([input]) => input.plan).filter((plan) => plan.mode === 'coarse');
    expect(coarse.map((plan) => [plan.startSeconds, plan.endSeconds])).toEqual([
      [0, 150],
      [150, 300],
      [300, 450],
      [450, 600],
    ]);
  });

  it('surfaces only the dense re-watch result, progressively, after a coarse locator hit', async () => {
    found.mockResolvedValue([candidate('a')]);
    inspect.mockImplementation(async ({ plan, onMoment }) => {
      if (plan.mode === 'coarse' && plan.startSeconds === 150) {
        return { moments: [{ startSeconds: 205, endSeconds: 206, description: 'Possible dog.', confidence: 0.5 }], exhausted: true, exhaustive: false };
      }
      if (plan.mode === 'continuous') {
        const moment = { startSeconds: 204.5, endSeconds: 208, description: 'A dog rides the skateboard.', confidence: 0.92 };
        await onMoment?.(moment);
        return { moments: [], exhausted: true, exhaustive: true };
      }
      return { moments: [], exhausted: true, exhaustive: false };
    });
    const { job, reported } = fakeJob();
    const result = await handleInternetSearch(job);

    expect(reported.some((step) => step.phase === 'searching' && step.moments[0]?.marks[0]?.description === 'A dog rides the skateboard.')).toBe(true);
    expect(result.moments).toHaveLength(1);
    expect(result.moments[0]?.marks[0]).toMatchObject({ startSeconds: 204.5, endSeconds: 208, confidence: 0.92 });
    expect(JSON.stringify(reported)).not.toContain('Possible dog.');
  });

  it('returns the playable page metadata for an approved dense result', async () => {
    found.mockResolvedValue([candidate('a', null)]);
    inspect.mockImplementation(async ({ plan }) => {
      if (plan.mode === 'coarse' && plan.startSeconds === 0) return { moments: [{ startSeconds: 2, endSeconds: 3, description: 'Maybe.' }], exhausted: true, exhaustive: false };
      if (plan.mode === 'continuous') return { moments: [{ startSeconds: 2, endSeconds: 5, description: 'A wave.' }], exhausted: true, exhaustive: true };
      return { moments: [], exhausted: true, exhaustive: false };
    });
    const { job } = fakeJob();
    const result = await handleInternetSearch(job);
    expect(result.moments[0]).toMatchObject({
      id: 'a',
      pageUrl: 'https://publisher.example/watch/a',
      title: 'page a',
      still: 'https://publisher.example/still/a.jpg',
      source: 'publisher.example',
    });
  });

  it('keeps sparse zero-result searches explicitly partial rather than claiming exhaustive absence', async () => {
    found.mockResolvedValue([candidate('a')]);
    inspect.mockResolvedValue({ moments: [], exhausted: true, exhaustive: false });
    const { job } = fakeJob();
    const result = await handleInternetSearch(job);
    expect(result.moments).toEqual([]);
    expect(result.unexamined).toBe(1);
  });

  it('counts an actual browser/model failure as additional unexamined work', async () => {
    found.mockResolvedValue([candidate('a')]);
    let calls = 0;
    inspect.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('the video never started playing');
      return { moments: [], exhausted: true, exhaustive: false };
    });
    const { job } = fakeJob();
    const result = await handleInternetSearch(job);
    expect(result.unexamined).toBeGreaterThanOrEqual(2);
  });
});
