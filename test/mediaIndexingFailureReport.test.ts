import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * When indexing breaks, SOMETHING has to say so.
 *
 * The handler records `failed` in its error path, and that is the record every
 * later question depends on. But the record is itself a database write, and a
 * write can fail. When it does, the row keeps saying `running` — for a video
 * nothing is reading, with nothing alive to correct it.
 *
 * That case used to be `.catch(() => undefined)`: the one moment the system
 * loses its own failure was the one moment it said nothing at all. These tests
 * pin the two error paths where that happens. They do not test that indexing
 * works; they test what is left behind when it doesn't.
 */

const logError = vi.fn();
const logWarn = vi.fn();
vi.mock('../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ error: logError, warn: logWarn, info: vi.fn(), debug: vi.fn() }),
    error: logError,
    warn: logWarn,
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

const getVideo = vi.fn();
vi.mock('../src/db/repositories/videos.js', () => ({ getVideo }));

const setMediaIndexStatus = vi.fn(async () => true);
const RUN_ID = '3f2a6c1e-0b7d-4c8a-9e5f-1d2b3c4a5e6f';
const beginIndexRun = vi.fn(async () => ({ cleared: 0, retained: [], runId: RUN_ID }));
const storeIndexedWindows = vi.fn(async () => 0);
const touchMediaIndexRun = vi.fn(async () => true);
vi.mock('../src/db/repositories/mediaIndex.js', () => ({
  beginIndexRun,
  setMediaIndexStatus,
  storeIndexedWindows,
  touchMediaIndexRun,
}));

vi.mock('../src/db/repositories/usage.js', () => ({ recordModelUsage: vi.fn(async () => undefined) }));

const createDownloadUrl = vi.fn(async () => 'https://example.invalid/proxy.mp4');
vi.mock('../src/services/storage/s3.js', () => ({ getStorage: () => ({ createDownloadUrl }) }));

const embedVideoIntervals = vi.fn();
vi.mock('../src/services/mediaIndex/qwen.js', () => ({ embedVideoIntervals }));

const sourceIdentity = vi.fn(async () => ({ identity: 'sha-original', bytes: 1_000 }));
vi.mock('../src/services/mediaIndex/sourceIdentity.js', () => ({ sourceIdentity }));

const { handleMediaIndexing } = await import('../src/worker/handlers/mediaIndexing.js');

const job = { data: { videoId: 'video-1' } } as never;

beforeEach(() => {
  vi.clearAllMocks();
  getVideo.mockResolvedValue({
    id: 'video-1',
    proxyStorageKey: 'proxies/video-1.mp4',
    durationSeconds: 30,
    footageExpiredAt: null,
  });
  setMediaIndexStatus.mockResolvedValue(true);
  beginIndexRun.mockResolvedValue({ cleared: 0, retained: [], runId: RUN_ID });
  sourceIdentity.mockResolvedValue({ identity: 'sha-original', bytes: 1_000 });
  touchMediaIndexRun.mockResolvedValue(true);
});

describe('a run says it is alive for as long as it is working', () => {
  /**
   * Why a heartbeat exists at all.
   *
   * Progress lands when a batch of windows returns, and a batch first waits
   * for a Modal permit that SEARCHES also draw on — a wait no timeout bounds.
   * Judging liveness by time-since-progress therefore measures how busy the
   * system is, and starves a healthy run into looking dead. Only a tick that
   * keeps running while the batch waits can tell the two apart.
   */
  // The identity a run proves itself with — a minted id, never a timestamp.
  const emptyBatch = {
    embedded: [], failed: [], model: 'Qwen/Qwen3-VL-Embedding-2B', revision: '', dims: 2048, metrics: {},
  };

  /**
   * A run only opens once the first batch has come back — that is where the
   * model's identity is learned. Before then the row is still `queued`, which
   * the read path never calls stopped, so the interesting case is the SECOND
   * batch: the run is open, `running`, and stuck.
   *
   * A long enough video to need more than one batch of 32 windows.
   */
  const longVideo = () => {
    getVideo.mockResolvedValue({
      id: 'video-1',
      proxyStorageKey: 'proxies/video-1.mp4',
      durationSeconds: 400,
      footageExpiredAt: null,
    });
  };

  it('keeps saying so while a later batch is stuck waiting for a permit', async () => {
    vi.useFakeTimers();
    longVideo();
    // First batch returns and opens the run; the next never comes back,
    // because searches are holding the only Modal permit. Under the old rule
    // this run went quiet and got called stopped while perfectly healthy.
    embedVideoIntervals
      .mockResolvedValueOnce(emptyBatch)
      .mockImplementation(() => new Promise(() => {}));

    void handleMediaIndexing(job);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(touchMediaIndexRun).toHaveBeenCalledWith('video-1', RUN_ID);
    const afterOne = touchMediaIndexRun.mock.calls.length;
    expect(afterOne).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(90_000);
    // Still beating, with no batch having returned in all that time.
    expect(touchMediaIndexRun.mock.calls.length).toBeGreaterThan(afterOne);

    vi.useRealTimers();
  });

  it('never has two beats in flight, however slow the database is', async () => {
    // A plain interval fires on the clock whether or not the last write came
    // back. On a struggling database that stacks writes up faster than they
    // drain — adding load to the exact thing already in trouble, at the exact
    // moment the heartbeat matters most.
    vi.useFakeTimers();
    longVideo();
    embedVideoIntervals
      .mockResolvedValueOnce(emptyBatch)
      .mockImplementation(() => new Promise(() => {}));
    // A touch that never comes back.
    touchMediaIndexRun.mockImplementation(() => new Promise(() => {}));

    void handleMediaIndexing(job);
    await vi.advanceTimersByTimeAsync(0);

    // Ten intervals pass with the first write still hanging.
    await vi.advanceTimersByTimeAsync(300_000);
    expect(touchMediaIndexRun).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('stops beating once the run is over, so a dead row never looks alive', async () => {
    vi.useFakeTimers();
    longVideo();
    embedVideoIntervals
      .mockResolvedValueOnce(emptyBatch)
      .mockRejectedValue(new Error('the embedding service refused every window'));

    await expect(handleMediaIndexing(job)).rejects.toThrow('refused every window');

    const afterRun = touchMediaIndexRun.mock.calls.length;
    await vi.advanceTimersByTimeAsync(300_000);
    // A heartbeat outliving its run would keep a dead row looking alive —
    // this code telling the exact lie the mechanism exists to stop.
    expect(touchMediaIndexRun.mock.calls.length).toBe(afterRun);

    vi.useRealTimers();
  });

  it('gives up the beat when the row has moved on to another run', async () => {
    vi.useFakeTimers();
    longVideo();
    embedVideoIntervals
      .mockResolvedValueOnce(emptyBatch)
      .mockImplementation(() => new Promise(() => {}));
    // Superseded: a newer run owns this row now.
    touchMediaIndexRun.mockResolvedValue(false);

    void handleMediaIndexing(job);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    const afterFirst = touchMediaIndexRun.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);

    await vi.advanceTimersByTimeAsync(300_000);
    // One refusal is enough: this run must not keep a row it lost looking
    // alive on behalf of the run that replaced it.
    expect(touchMediaIndexRun.mock.calls.length).toBe(afterFirst);

    vi.useRealTimers();
  });
});

describe('a failure that could not be written down is still reported', () => {
  it('says the status row is now stale when recording the failure fails', async () => {
    // The read dies...
    embedVideoIntervals.mockRejectedValue(new Error('the embedding service refused every window'));
    // ...and so does the write that was meant to record that it died.
    setMediaIndexStatus.mockRejectedValue(new Error('connection terminated unexpectedly'));

    // The original failure is what the job reports — a database blip must not
    // replace the real cause — so this still throws.
    await expect(handleMediaIndexing(job)).rejects.toThrow('the embedding service refused every window');

    // But the lost write is never silent. Without this line, nothing anywhere
    // knows the row is lying.
    expect(logError).toHaveBeenCalledWith(
      'could not record that indexing failed; the status row will keep saying it is running',
      expect.objectContaining({
        videoId: 'video-1',
        // The failure that never reached the row survives in the log instead.
        unrecordedFailure: expect.stringContaining('refused every window'),
      }),
    );
  });

  it('still reports the original failure when the status write succeeds', async () => {
    embedVideoIntervals.mockRejectedValue(new Error('the embedding service refused every window'));

    await expect(handleMediaIndexing(job)).rejects.toThrow('the embedding service refused every window');

    // The write got through, so the row tells the truth and there is nothing
    // stale to warn about. The "lost write" line must not cry wolf.
    expect(setMediaIndexStatus).toHaveBeenCalledWith(
      'video-1',
      'failed',
      expect.objectContaining({ error: expect.stringContaining('refused every window') }),
    );
    expect(logError).not.toHaveBeenCalledWith(
      'could not record that indexing failed; the status row will keep saying it is running',
      expect.anything(),
    );
  });

  it('says so when it cannot record that the footage was swapped mid-read', async () => {
    // Every window embeds fine...
    embedVideoIntervals.mockResolvedValue({
      embedded: [],
      failed: [],
      model: 'Qwen/Qwen3-VL-Embedding-2B',
      revision: '',
      dims: 2048,
      metrics: {},
    });
    // ...but the proxy was replaced while it ran, so none of them are believed.
    sourceIdentity
      .mockResolvedValueOnce({ identity: 'sha-original', bytes: 1_000 })
      .mockResolvedValue({ identity: 'sha-replaced', bytes: 2_000 });
    // And the write recording THAT is the one that is lost. Only that one:
    // the progress writes during the read went through, which is what makes
    // this the realistic shape of the failure — a database that was fine all
    // the way through the read and blinked at the final write. (Making every
    // write fail instead never reaches this path at all: the in-loop progress
    // write throws first and the job takes its ordinary error path, which is
    // correct behaviour and a different test.)
    setMediaIndexStatus.mockImplementation(async (_videoId: string, state: string) => {
      if (state === 'unavailable') throw new Error('connection terminated unexpectedly');
      return true;
    });

    // This path returns rather than throws: the condition was handled
    // correctly, it just could not be written down.
    await handleMediaIndexing(job);

    expect(logError).toHaveBeenCalledWith(
      'could not record that the footage was replaced mid-index; the status row is now stale',
      expect.objectContaining({ videoId: 'video-1' }),
    );
  });
});
