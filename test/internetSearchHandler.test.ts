import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Candidate } from '../src/services/discovery/searxng.js';
import type { ScoutInspection } from '../src/services/retrieval/scoutSwarm.js';
import type { InternetSearchJob, InternetSearchProgress } from '../src/queues/internetSearch.js';

const found = vi.fn<[], Promise<Candidate[]>>();
const inspect = vi.fn<[{ candidate: Candidate }], Promise<ScoutInspection>>();

vi.mock('../src/services/discovery/searxng.js', () => ({
  search: () => found(),
}));

vi.mock('../src/services/retrieval/ganderScoutRuntime.js', () => ({
  createGanderScoutRuntime: () => ({ inspect: (input: { candidate: Candidate }) => inspect(input) }),
}));

const { handleInternetSearch } = await import('../src/worker/handlers/internetSearch.js');

function candidate(id: string, source: string | null = 'youtube.com'): Candidate {
  return {
    id,
    query: 'a dog on a skateboard',
    title: `page ${id}`,
    pageUrl: `https://publisher.example/watch/${id}`,
    thumbnailUrl: null,
    source,
  };
}

/** A job that records everything the handler reports, in order. */
function fakeJob() {
  const reported: InternetSearchProgress[] = [];
  const job = {
    id: '11111111-2222-3333-4444-555555555555',
    data: { query: 'a dog on a skateboard', sessionId: 's', userId: null } as InternetSearchJob,
    async updateProgress(progress: unknown) {
      reported.push(structuredClone(progress) as InternetSearchProgress);
    },
  };
  return { job: job as unknown as Job<InternetSearchJob>, reported };
}

beforeEach(() => {
  found.mockReset();
  inspect.mockReset();
  process.env.WEB_ACCESS_URL = 'http://web-access.internal:8080';
  process.env.WEB_ACCESS_INTERNAL_TOKEN = 'token';
  process.env.GANDER_URL = 'https://gander.example';
  process.env.GANDER_API_KEY = 'key';
});

describe('one internet search, from a question to its moments', () => {
  it('shows the loading state first, whatever it is about to find', async () => {
    found.mockResolvedValue([]);
    const { job, reported } = fakeJob();

    await handleInternetSearch(job);

    expect(reported[0]).toEqual({ phase: 'loading', moments: [], candidatesFound: 0 });
  });

  it('never puts up slots when there is nothing to watch', async () => {
    found.mockResolvedValue([]);
    const { job, reported } = fakeJob();

    const result = await handleInternetSearch(job);

    // Straight from loading to answered: a skeleton promises a card is coming
    // and there is no page to get one from.
    expect(reported.map((step) => step.phase)).toEqual(['loading', 'answered']);
    expect(result).toEqual({ phase: 'answered', moments: [], candidatesFound: 0 });
  });

  it('puts the slots up once there are pages to watch', async () => {
    found.mockResolvedValue([candidate('a')]);
    inspect.mockResolvedValue({ moments: [], exhausted: true });
    const { job, reported } = fakeJob();

    await handleInternetSearch(job);

    const searching = reported.find((step) => step.phase === 'searching');
    expect(searching).toBeTruthy();
    expect(searching!.candidatesFound).toBe(1);
  });

  it('reports a moment the instant it is found, not at the end', async () => {
    found.mockResolvedValue([candidate('a'), candidate('b')]);
    inspect.mockImplementation(async ({ candidate: page }) =>
      page.id === 'a'
        ? { moments: [{ startSeconds: 10, endSeconds: 14, description: 'A dog rolls past.' }], exhausted: true }
        : { moments: [], exhausted: true },
    );
    const { job, reported } = fakeJob();

    await handleInternetSearch(job);

    // The moment is on a `searching` update, before the search was over.
    const whileSearching = reported.filter((step) => step.phase === 'searching' && step.moments.length > 0);
    expect(whileSearching.length).toBeGreaterThan(0);
    expect(whileSearching[0]!.moments[0]!.description).toBe('A dog rolls past.');
  });

  it('carries every moment on every update, so a missed poll loses nothing', async () => {
    found.mockResolvedValue([candidate('a'), candidate('b')]);
    inspect.mockImplementation(async ({ candidate: page }) => ({
      moments: [{ startSeconds: 1, endSeconds: 3, description: `something in ${page.id}` }],
      exhausted: true,
    }));
    const { job } = fakeJob();

    const result = await handleInternetSearch(job);

    expect(result.moments).toHaveLength(2);
  });

  it('names the site a moment came from, and never the page itself', async () => {
    found.mockResolvedValue([candidate('a', null)]);
    inspect.mockResolvedValue({ moments: [{ startSeconds: 2, endSeconds: 5, description: 'A wave.' }], exhausted: true });
    const { job, reported } = fakeJob();

    const result = await handleInternetSearch(job);

    expect(result.moments[0]!.source).toBe('publisher.example');
    // A page is where to look, not what was found. Nothing the screen is
    // given may carry one.
    const everything = JSON.stringify(reported);
    expect(everything).not.toContain('publisher.example/watch');
    expect(everything).not.toContain('pageUrl');
  });

  it('counts a page it could not watch as unexamined rather than empty', async () => {
    found.mockResolvedValue([candidate('a'), candidate('b')]);
    inspect.mockImplementation(async ({ candidate: page }) => {
      if (page.id === 'a') throw new Error('the video never started playing');
      return { moments: [], exhausted: true };
    });
    const { job } = fakeJob();

    const result = await handleInternetSearch(job);

    // "We could not look here" is not "there was nothing here".
    expect(result.unexamined).toBe(1);
    expect(result.moments).toEqual([]);
  });

  it('counts a page still playing when the watch ended as unexamined', async () => {
    found.mockResolvedValue([candidate('a')]);
    // The scout watched it and did not reach the end. That is not a failure,
    // and it is not "nothing was there" either.
    inspect.mockResolvedValue({ moments: [], exhausted: false });
    const { job } = fakeJob();

    const result = await handleInternetSearch(job);

    expect(result.unexamined).toBe(1);
  });

  it('treats a page that never said it finished as unexamined', async () => {
    found.mockResolvedValue([candidate('a')]);
    // Nothing said the page was watched to its end, so nothing may claim it
    // was. Silence is not a report that the whole page was seen.
    inspect.mockResolvedValue({ moments: [] });
    const { job } = fakeJob();

    const result = await handleInternetSearch(job);

    expect(result.unexamined).toBe(1);
  });

  it('says nothing about being unexamined when everything was watched', async () => {
    found.mockResolvedValue([candidate('a')]);
    inspect.mockResolvedValue({ moments: [], exhausted: true });
    const { job } = fakeJob();

    const result = await handleInternetSearch(job);

    expect(result.unexamined).toBeUndefined();
    expect(result.phase).toBe('answered');
  });
});
