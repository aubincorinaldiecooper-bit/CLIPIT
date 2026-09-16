import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Candidate } from '../src/services/discovery/searxng.js';
import type { ScoutInspection } from '../src/services/retrieval/scoutSwarm.js';
import type { InternetSearchJob, InternetSearchProgress } from '../src/queues/internetSearch.js';

const found = vi.fn<[], Promise<Candidate[]>>();
const inspect = vi.fn<[{ candidate: Candidate }], Promise<ScoutInspection>>();

vi.mock('../src/services/discovery/searxng.js', () => ({ search: () => found() }));
vi.mock('../src/services/retrieval/videoModelScoutRuntime.js', () => ({
  createVideoModelScoutRuntime: () => ({ inspect: (input: { candidate: Candidate }) => inspect(input) }),
}));
vi.mock('../src/services/video/adapters/videochat3.js', () => ({ videoChat3Adapter: { id: 'videochat3', sourceKinds: new Set(['frame-stream']) } }));

const { handleInternetSearch } = await import('../src/worker/handlers/internetSearch.js');

function candidate(id: string, source: string | null = 'youtube.com'): Candidate {
  return { id, query: 'a dog on a skateboard', title: `page ${id}`, pageUrl: `https://publisher.example/watch/${id}`, thumbnailUrl: null, source };
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
  found.mockReset(); inspect.mockReset();
  process.env.WEB_ACCESS_URL = 'http://web-access.internal:8080';
  process.env.WEB_ACCESS_INTERNAL_TOKEN = 'token';
});

describe('one internet search, from a question to its moments', () => {
  it('shows loading first', async () => {
    found.mockResolvedValue([]); const { job, reported } = fakeJob(); await handleInternetSearch(job);
    expect(reported[0]).toEqual({ phase: 'loading', moments: [], candidatesFound: 0 });
  });
  it('does not show search slots when discovery finds nothing', async () => {
    found.mockResolvedValue([]); const { job, reported } = fakeJob(); const result = await handleInternetSearch(job);
    expect(reported.map((step) => step.phase)).toEqual(['loading', 'answered']);
    expect(result).toEqual({ phase: 'answered', moments: [], candidatesFound: 0 });
  });
  it('starts searching once there are pages to watch', async () => {
    found.mockResolvedValue([candidate('a')]); inspect.mockResolvedValue({ moments: [], exhausted: true });
    const { job, reported } = fakeJob(); await handleInternetSearch(job);
    expect(reported.find((step) => step.phase === 'searching')?.candidatesFound).toBe(1);
  });
  it('reports a found moment before the search finishes', async () => {
    found.mockResolvedValue([candidate('a'), candidate('b')]);
    inspect.mockImplementation(async ({ candidate: page }) => page.id === 'a'
      ? { moments: [{ startSeconds: 10, endSeconds: 14, description: 'A dog rolls past.' }], exhausted: true }
      : { moments: [], exhausted: true });
    const { job, reported } = fakeJob(); await handleInternetSearch(job);
    expect(reported.some((step) => step.phase === 'searching' && step.moments[0]?.description === 'A dog rolls past.')).toBe(true);
  });
  it('carries every moment on the final result', async () => {
    found.mockResolvedValue([candidate('a'), candidate('b')]);
    inspect.mockImplementation(async ({ candidate: page }) => ({ moments: [{ startSeconds: 1, endSeconds: 3, description: `something in ${page.id}` }], exhausted: true }));
    const { job } = fakeJob(); expect((await handleInternetSearch(job)).moments).toHaveLength(2);
  });
  it('returns the site but never the candidate page URL', async () => {
    found.mockResolvedValue([candidate('a', null)]); inspect.mockResolvedValue({ moments: [{ startSeconds: 2, endSeconds: 5, description: 'A wave.' }], exhausted: true });
    const { job, reported } = fakeJob(); const result = await handleInternetSearch(job);
    expect(result.moments[0]!.source).toBe('publisher.example');
    const everything = JSON.stringify(reported); expect(everything).not.toContain('publisher.example/watch'); expect(everything).not.toContain('pageUrl');
  });
  it('counts a page the model could not watch as unexamined', async () => {
    found.mockResolvedValue([candidate('a'), candidate('b')]);
    inspect.mockImplementation(async ({ candidate: page }) => { if (page.id === 'a') throw new Error('the video never started playing'); return { moments: [], exhausted: true }; });
    const { job } = fakeJob(); expect((await handleInternetSearch(job)).unexamined).toBe(1);
  });
  it('counts a partial page as unexamined', async () => {
    found.mockResolvedValue([candidate('a')]); inspect.mockResolvedValue({ moments: [], exhausted: false });
    const { job } = fakeJob(); expect((await handleInternetSearch(job)).unexamined).toBe(1);
  });
  it('does not mark a fully watched page unexamined', async () => {
    found.mockResolvedValue([candidate('a')]); inspect.mockResolvedValue({ moments: [], exhausted: true });
    const { job } = fakeJob(); const result = await handleInternetSearch(job); expect(result.unexamined).toBeUndefined(); expect(result.phase).toBe('answered');
  });
});
