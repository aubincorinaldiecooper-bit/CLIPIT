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
    expect(reported.some((step) => step.phase === 'searching' && step.moments[0]?.marks[0]?.description === 'A dog rolls past.')).toBe(true);
  });
  it('shows one card for one event, however many frames the watcher answered about', async () => {
    found.mockResolvedValue([candidate('a')]);
    inspect.mockResolvedValue({
      moments: [42, 43, 44, 45].map((second) => ({ startSeconds: second, endSeconds: second + 1, description: 'The dog falls off the board.' })),
      exhausted: true,
    });
    const { job, reported } = fakeJob(); const result = await handleInternetSearch(job);
    expect(result.moments).toHaveLength(1);
    expect(result.moments[0]!.marks).toEqual([{ startSeconds: 42, endSeconds: 46, description: 'The dog falls off the board.' }]);
    // And no step on the way to that answer put more on screen than the answer
    // holds: a card that appeared and then had to be taken back is the bug.
    for (const step of reported) for (const moment of step.moments) expect(moment.marks.length).toBeLessThanOrEqual(1);
  });
  it('carries every moment on the final result', async () => {
    found.mockResolvedValue([candidate('a'), candidate('b')]);
    inspect.mockImplementation(async ({ candidate: page }) => ({ moments: [{ startSeconds: 1, endSeconds: 3, description: `something in ${page.id}` }], exhausted: true }));
    const { job } = fakeJob(); expect((await handleInternetSearch(job)).moments).toHaveLength(2);
  });
  it('returns an approved video with the page that plays it, and the site it came from', async () => {
    found.mockResolvedValue([candidate('a', null)]); inspect.mockResolvedValue({ moments: [{ startSeconds: 2, endSeconds: 5, description: 'A wave.' }], exhausted: true });
    const { job } = fakeJob(); const result = await handleInternetSearch(job);
    expect(result.moments[0]).toMatchObject({
      id: 'a',
      pageUrl: 'https://publisher.example/watch/a',
      title: 'page a',
      still: 'https://publisher.example/still/a.jpg',
      source: 'publisher.example',
    });
  });
  it('carries the surest thing the watcher said about a video, and nothing when it never said', async () => {
    found.mockResolvedValue([candidate('said'), candidate('quiet')]);
    inspect.mockImplementation(async ({ candidate: page }) => page.id === 'said'
      ? { moments: [
          { startSeconds: 10, endSeconds: 12, description: 'The first.', confidence: 0.4 },
          { startSeconds: 40, endSeconds: 43, description: 'The second.', confidence: 0.9 },
        ], exhausted: true }
      : { moments: [{ startSeconds: 5, endSeconds: 9, description: 'No number given.' }], exhausted: true });
    const { job } = fakeJob(); const result = await handleInternetSearch(job);

    const said = result.moments.find((moment) => moment.id === 'said')!;
    const quiet = result.moments.find((moment) => moment.id === 'quiet')!;
    // A video is worth opening for its best moment, so the card carries the
    // best — while each place keeps its own.
    expect(said.confidence).toBe(0.9);
    expect(said.marks.map((mark) => mark.confidence)).toEqual([0.4, 0.9]);
    // Said nothing is absent, not zero: the two mean very different things.
    expect('confidence' in quiet).toBe(false);
    expect('confidence' in quiet.marks[0]!).toBe(false);
  });
  it('never returns a page nothing was approved in', async () => {
    found.mockResolvedValue([candidate('watched'), candidate('empty')]);
    inspect.mockImplementation(async ({ candidate: page }) => page.id === 'watched'
      ? { moments: [{ startSeconds: 2, endSeconds: 5, description: 'A wave.' }], exhausted: true }
      : { moments: [], exhausted: true });
    const { job, reported } = fakeJob(); const result = await handleInternetSearch(job);
    // Discovery turned both up and both were watched. Only the one something
    // was found in is a result; the other is not a weaker result, it is none.
    expect(result.moments.map((moment) => moment.id)).toEqual(['watched']);
    expect(JSON.stringify(reported)).not.toContain('watch/empty');
  });
  it('gives one video one card however many places it was approved in, strongest first', async () => {
    found.mockResolvedValue([candidate('once'), candidate('thrice')]);
    inspect.mockImplementation(async ({ candidate: page }) => page.id === 'thrice'
      ? { moments: [
          { startSeconds: 10, endSeconds: 12, description: 'The first time.' },
          { startSeconds: 40, endSeconds: 43, description: 'The second time.' },
          { startSeconds: 70, endSeconds: 72, description: 'The third time.' },
        ], exhausted: true }
      : { moments: [{ startSeconds: 5, endSeconds: 9, description: 'The only time.' }], exhausted: true });
    const { job } = fakeJob(); const result = await handleInternetSearch(job);

    // Two videos, not four cards. The one approved three times leads, because
    // answering repeatedly is a stronger answer rather than more answers.
    expect(result.moments.map((moment) => moment.id)).toEqual(['thrice', 'once']);
    expect(result.moments[0]!.marks.map((mark) => mark.startSeconds)).toEqual([10, 40, 70]);
    expect(result.moments[1]!.marks).toHaveLength(1);
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
