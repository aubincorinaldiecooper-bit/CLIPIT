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
const assertReady = vi.fn<[string], Promise<void>>();
vi.mock('../src/services/video/adapters/videochat3.js', () => ({
  videoChat3Adapter: { id: 'videochat3', sourceKinds: new Set(['frame-stream']), assertReady: (kind: string) => assertReady(kind) },
}));

const logged: Array<{ level: string; message: string; context: Record<string, unknown> }> = [];
vi.mock('../src/lib/logger.js', () => {
  const record = (level: string) => (message: string, context: Record<string, unknown> = {}) => {
    logged.push({ level, message, context });
  };
  const made: Record<string, unknown> = { error: record('error'), warn: record('warn'), info: record('info'), debug: record('debug') };
  made.child = () => made;
  return { logger: made };
});

const { handleInternetSearch } = await import('../src/worker/handlers/internetSearch.js');

function said(message: string) {
  return logged.filter((line) => line.message === message);
}

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
  assertReady.mockReset();
  assertReady.mockResolvedValue(undefined);
  logged.length = 0;
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
    expect(result).toEqual({ phase: 'answered', moments: [], candidatesFound: 0, candidatesWatched: 0, outcome: 'no_candidates' });
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

/**
 * The 17 September production failure, and the four other ways a search can
 * end. Every one of these ran green before the fix and told the person the
 * same thing: an empty list. The point of these is that the five endings are
 * now distinguishable, and that only two of them are allowed to mean "we
 * looked and it is not there".
 */
describe('what a finished internet search is allowed to claim', () => {
  const DEPLOYED_WITHOUT_THE_METHOD =
    "Modal cannot find clipit-videochat3/VideoChat3Service in main (Method 'watch_stream' not found on class)";

  it('does not say nothing matched when every watch failed', async () => {
    found.mockResolvedValue([candidate('a'), candidate('b')]);
    inspect.mockRejectedValue(new Error(DEPLOYED_WITHOUT_THE_METHOD));
    const { job, reported } = fakeJob();
    const result = await handleInternetSearch(job);

    expect(result.phase).toBe('failed');
    expect(result.outcome).toBe('watch_failed');
    expect(result.candidatesWatched).toBe(0);
    expect(result.moments).toEqual([]);
    expect(result.failure).toEqual({ kind: 'video_model_unavailable', count: 8 });
    // Nothing that reaches the screen may be read as an answer about the videos.
    expect(reported.at(-1)?.outcome).toBe('watch_failed');
  });

  it('says nothing matched only when every second of every video was actually seen', async () => {
    found.mockResolvedValue([candidate('a'), candidate('b')]);
    inspect.mockResolvedValue({ moments: [], exhausted: true, exhaustive: true });
    const { job } = fakeJob();
    const result = await handleInternetSearch(job);

    expect(result.phase).toBe('answered');
    expect(result.outcome).toBe('no_matches');
    expect(result.candidatesWatched).toBe(2);
    expect(result.failure).toBeUndefined();
  });

  it('will not call a sampled scan "watched", however cleanly it succeeded', async () => {
    // Every candidate is first read by a coarse scan, which looks at one
    // second in every five and comes back `exhaustive: false` having
    // succeeded. Counting that as full coverage would let a fifth of a video
    // stand in for all of it — the same false absence, one level down.
    found.mockResolvedValue([candidate('a'), candidate('b')]);
    inspect.mockResolvedValue({ moments: [], exhausted: true, exhaustive: false });
    const { job } = fakeJob();
    const result = await handleInternetSearch(job);

    expect(result.outcome).toBe('partly_watched');
    // Nothing failed, so nothing is reported as unwatchable — it is the depth
    // of the watching that was short, not the number of videos opened.
    expect(result.candidatesWatched).toBe(2);
    expect(result.failure).toBeUndefined();
  });

  it('will not call a watch cut short by its event cap a complete one', async () => {
    found.mockResolvedValue([candidate('a')]);
    inspect.mockResolvedValue({ moments: [], exhausted: false, exhaustive: true });
    const { job } = fakeJob();
    const result = await handleInternetSearch(job);
    expect(result.outcome).toBe('partly_watched');
  });

  it('calls a search partial when one video was watched and another could not be', async () => {
    found.mockResolvedValue([candidate('a'), candidate('b')]);
    inspect.mockImplementation(async ({ candidate: page }) => {
      if (page.id === 'a') throw new Error('the browser refused to watch this page (503)');
      return { moments: [], exhausted: true, exhaustive: false };
    });
    const { job } = fakeJob();
    const result = await handleInternetSearch(job);

    expect(result.outcome).toBe('partly_watched');
    expect(result.candidatesWatched).toBe(1);
    expect(result.failure).toEqual({ kind: 'browser_unavailable', count: 4 });
  });

  it('calls a search partial when a stretch of the only video was never opened', async () => {
    found.mockResolvedValue([candidate('a')]);
    let calls = 0;
    inspect.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) throw new Error('the video never started playing');
      return { moments: [], exhausted: true, exhaustive: false };
    });
    const { job } = fakeJob();
    const result = await handleInternetSearch(job);

    expect(result.outcome).toBe('partly_watched');
    expect(result.candidatesWatched).toBe(1);
  });

  it('calls it a match when the video was watched through and something was found', async () => {
    found.mockResolvedValue([candidate('a')]);
    inspect.mockImplementation(async ({ plan }) => {
      if (plan.mode === 'coarse' && plan.startSeconds === 0) return { moments: [{ startSeconds: 2, endSeconds: 3, description: 'Maybe.' }], exhausted: true, exhaustive: true };
      if (plan.mode === 'continuous') return { moments: [{ startSeconds: 2, endSeconds: 5, description: 'A dog on a skateboard.' }], exhausted: true, exhaustive: true };
      return { moments: [], exhausted: true, exhaustive: true };
    });
    const { job } = fakeJob();
    const result = await handleInternetSearch(job);

    expect(result.phase).toBe('answered');
    expect(result.outcome).toBe('matched');
    expect(result.moments).toHaveLength(1);
    expect(result.failure).toBeUndefined();
  });
});

describe('refusing to search against a watcher that cannot take the call', () => {
  it('stops before any page is opened, and says so', async () => {
    found.mockResolvedValue([candidate('a'), candidate('b'), candidate('c')]);
    assertReady.mockRejectedValue(new Error("Modal cannot find clipit-videochat3/VideoChat3Service in main (Method 'watch_stream' not found on class)"));
    const { job, reported } = fakeJob();
    const result = await handleInternetSearch(job);

    expect(result.phase).toBe('failed');
    expect(result.outcome).toBe('watch_failed');
    expect(result.failure?.kind).toBe('video_model_unavailable');
    // The whole point: not one browser session, not one Modal queue.
    expect(inspect).not.toHaveBeenCalled();
    // And the screen is never told pages are being watched when none will be.
    expect(reported.some((step) => step.phase === 'searching')).toBe(false);
  });

  it('checks the method the scouts will actually call, not merely that something is deployed', async () => {
    found.mockResolvedValue([candidate('a')]);
    inspect.mockResolvedValue({ moments: [], exhausted: true, exhaustive: false });
    const { job } = fakeJob();
    await handleInternetSearch(job);
    expect(assertReady).toHaveBeenCalledWith('frame-stream');
  });

  it('does not reach for the watcher at all when there is nothing to watch', async () => {
    found.mockResolvedValue([]);
    const { job } = fakeJob();
    await handleInternetSearch(job);
    expect(assertReady).not.toHaveBeenCalled();
  });
});

/**
 * Telemetry has to survive the thing it is there to diagnose.
 *
 * On 17 September a search died and left nothing behind: no
 * `internet search finished` line, no per-candidate record, no page address —
 * because every one of those is written at the end, and the end never came.
 * The post-mortem had a stack trace and a guess.
 */
describe("what a search leaves behind while it is still running", () => {
  it("reports how many videos it has read as it goes, not only at the end", async () => {
    found.mockResolvedValue([candidate('a'), candidate('b')]);
    inspect.mockResolvedValue({ moments: [], exhausted: true, exhaustive: true });
    const { job, reported } = fakeJob();
    await handleInternetSearch(job);

    // A search cut off half way is answered from the last progress it wrote,
    // so the count has to be in there before the summary exists.
    const midFlight = reported.filter((step) => step.phase === 'searching');
    expect(midFlight.length).toBeGreaterThan(1);
    expect(midFlight.at(-1)?.candidatesWatched).toBe(2);
    // And it starts honest: nothing watched yet is nothing claimed.
    expect(midFlight[0]?.candidatesWatched).toBe(0);
  });

  it("counts a video as read only once something was actually read from it", async () => {
    // Candidate 'a' fails every way; 'b' succeeds. The swarm finishes with
    // both, but only one of them was ever opened.
    found.mockResolvedValue([candidate('a'), candidate('b')]);
    inspect.mockImplementation(async ({ candidate: page }) => {
      if (page.id === 'a') throw new Error('the browser refused to watch this page (503)');
      return { moments: [], exhausted: true, exhaustive: true };
    });
    const { job, reported } = fakeJob();
    await handleInternetSearch(job);

    const midFlight = reported.filter((step) => step.phase === 'searching');
    expect(midFlight.at(-1)?.candidatesWatched).toBe(1);
  });

  it("names the page each scout went to, so a failure points somewhere", async () => {
    found.mockResolvedValue([candidate('a'), candidate('b')]);
    inspect.mockResolvedValue({ moments: [], exhausted: true, exhaustive: true });
    const { job } = fakeJob();
    await handleInternetSearch(job);

    const pages = said('watching a page');
    // Once per video, not once per scout: four scouts take a quarter of the
    // same video each, and four identical lines say nothing extra.
    expect(pages).toHaveLength(2);
    expect(pages.map((line) => line.context.page_url)).toEqual([
      'https://publisher.example/watch/a',
      'https://publisher.example/watch/b',
    ]);
  });

  it("writes down what it knew before letting the error through", async () => {
    // Redis going away mid-search is the realistic version of this: reporting
    // progress throws, the swarm carries it out, and the summary at the bottom
    // of the handler never runs.
    found.mockResolvedValue([candidate('a'), candidate('b')]);
    inspect.mockResolvedValue({ moments: [], exhausted: true, exhaustive: true });
    const { job } = fakeJob();
    let updates = 0;
    (job as unknown as { updateProgress: (p: unknown) => Promise<void> }).updateProgress = async () => {
      updates += 1;
      if (updates > 2) throw new Error('Redis connection lost');
    };

    await expect(handleInternetSearch(job)).rejects.toThrow(/Redis connection lost/);

    const stopped = said('internet search stopped part-way');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.level).toBe('error');
    expect(stopped[0]?.context).toMatchObject({ status: 'stopped', candidates_selected: 2 });
    // It got to the first video and not the second, and the record says so.
    // That is the whole point: the account is of how far it actually got, not
    // of what it set out to do.
    expect(stopped[0]?.context.candidates_announced).toEqual(['a']);
    expect(stopped[0]?.context.candidates_selected).toBe(2);
    expect(stopped[0]?.context.err).toMatch(/Redis connection lost/);
  });
});
