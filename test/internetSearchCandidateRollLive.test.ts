import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Candidate } from '../src/services/discovery/searxng.js';
import type { ScoutInspection, ScoutInspectionPlan } from '../src/services/retrieval/scoutSwarm.js';
import type { InternetSearchJob, InternetSearchProgress } from '../src/queues/internetSearch.js';

const found = vi.fn<[], Promise<Candidate[]>>();
const inspect = vi.fn<[{ candidate: Candidate; plan: ScoutInspectionPlan }], Promise<ScoutInspection>>();

vi.mock('../src/services/discovery/searxng.js', () => ({ search: () => found() }));
vi.mock('../src/services/retrieval/videoModelScoutRuntime.js', () => ({
  createVideoModelScoutRuntime: () => ({ inspect: (input: { candidate: Candidate; plan: ScoutInspectionPlan }) => inspect(input) }),
}));
vi.mock('../src/services/video/adapters/videochat3.js', () => ({
  videoChat3Adapter: { id: 'videochat3', sourceKinds: new Set(['frame-stream']), assertReady: async () => undefined },
}));
vi.mock('../src/lib/logger.js', () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }), info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

const { handleInternetSearch } = await import('../src/worker/handlers/internetSearch.js');

const candidate = (id: string): Candidate => ({
  id,
  query: 'a dog on a skateboard',
  title: `page ${id}`,
  pageUrl: `https://publisher.example/watch/${id}`,
  thumbnailUrl: `https://publisher.example/still/${id}.jpg`,
  source: 'youtube.com',
});

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
});

/*
 * A worker killed between handing a page to a scout and getting anything back
 * used to leave the written-down roll at the opening one, where every page
 * reads `not_reached`. The route can only rebuild a failed search's answer
 * from what was written down — so a page four scouts had open was reported to
 * the person as one nobody ever went to.
 *
 * That is the mirror of the mistake `not_reached` exists to prevent, and it
 * lands in exactly the case this record was built for. Caught by Codex on
 * #155.
 */
describe('what a dying search has already written down', () => {
  it('has written down that a page was handed out, before any result comes back', async () => {
    found.mockResolvedValue([candidate('c1')]);
    inspect.mockResolvedValue({
      candidateId: 'c1',
      success: true,
      moments: [],
      exhaustive: true,
      exhausted: true,
      metrics: {},
    } as unknown as ScoutInspection);

    const { job, reported } = fakeJob();
    await handleInternetSearch(job);

    const everWatching = reported.some((progress) =>
      (progress.candidates ?? []).some((entry) => entry.state === 'watching'),
    );
    expect(everWatching).toBe(true);
  });

  it('still settles to watched once the watch comes back', async () => {
    found.mockResolvedValue([candidate('c1')]);
    inspect.mockResolvedValue({
      candidateId: 'c1',
      success: true,
      moments: [],
      exhaustive: true,
      exhausted: true,
      metrics: {},
    } as unknown as ScoutInspection);

    const { job } = fakeJob();
    const result = await handleInternetSearch(job);
    expect(result.candidates?.map((entry) => entry.state)).toEqual(['watched']);
  });
});
