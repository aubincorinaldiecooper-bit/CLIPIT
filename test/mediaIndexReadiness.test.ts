import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalServiceError } from '../src/lib/errors.js';

/**
 * Reading videos into vectors is now on by default. This decides whether it
 * can actually run — and, far more importantly, what happens to everything
 * else when it cannot.
 *
 * The rule these pin: a missing credential or an undeployed Modal app takes
 * out the vector index and NOTHING ELSE. Ingestion, transcription, search and
 * rendering do not need it and must not stop for it. The first version of this
 * threw on a missing credential, before any worker started, which turned an
 * optional feature's misconfiguration into a total outage.
 */

const logError = vi.fn();
const logWarn = vi.fn();
const logInfo = vi.fn();
vi.mock('../src/lib/logger.js', () => ({
  logger: { error: logError, warn: logWarn, info: logInfo, debug: vi.fn(), child: () => ({}) },
}));

const assertMediaIndexDeploymentsAvailable = vi.fn(async () => undefined);
vi.mock('../src/services/mediaIndex/qwen.js', () => ({ assertMediaIndexDeploymentsAvailable }));

const envValues: Record<string, unknown> = {};
vi.mock('../src/config/env.js', () => ({ env: new Proxy({}, { get: (_t, key: string) => envValues[key] }) }));

const { mediaIndexReadiness, watchMediaIndexRecovery } = await import('../src/worker/mediaIndexReadiness.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
  Object.assign(envValues, {
    MEDIA_INDEX_ENABLED: true,
    MODAL_TOKEN_ID: 'token-id',
    MODAL_TOKEN_SECRET: 'token-secret',
    MODAL_ENVIRONMENT: 'main',
    MEDIA_INDEX_EMBED_APP: 'clipit-embedding',
    MEDIA_INDEX_RERANK_APP: 'clipit-reranker',
  });
  assertMediaIndexDeploymentsAvailable.mockResolvedValue(undefined);
});

describe('a misconfigured vector index degrades itself and nothing else', () => {
  it('is ready when both services resolve', async () => {
    await expect(mediaIndexReadiness()).resolves.toBe(true);
    expect(logError).not.toHaveBeenCalled();
  });

  it('reports and returns false — never throws — when the credentials are missing', async () => {
    // The regression that matters. Throwing here ran before any worker
    // started, so an absent token for the OPTIONAL index stopped ingestion,
    // transcription, search and rendering too.
    envValues.MODAL_TOKEN_ID = undefined;

    await expect(mediaIndexReadiness()).resolves.toBe(false);

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('the Modal credentials are missing'),
      expect.objectContaining({ remedy: expect.stringContaining('MODAL_TOKEN_ID') }),
    );
    // Never asked Modal anything: there was nothing to ask with.
    expect(assertMediaIndexDeploymentsAvailable).not.toHaveBeenCalled();
  });

  it('does not ask, and is not ready, when the feature is switched off', async () => {
    envValues.MEDIA_INDEX_ENABLED = false;

    await expect(mediaIndexReadiness()).resolves.toBe(false);

    expect(assertMediaIndexDeploymentsAvailable).not.toHaveBeenCalled();
    // Off is not broken: nothing to report.
    expect(logError).not.toHaveBeenCalled();
  });
});

describe('a blip at startup is not a verdict', () => {
  it('retries a retryable failure and succeeds', async () => {
    // Modal's own weather during a deploy. Without the retry this left
    // indexing off until somebody happened to restart the worker — silently,
    // while uploads kept queueing.
    vi.useFakeTimers();
    assertMediaIndexDeploymentsAvailable
      .mockRejectedValueOnce(new ExternalServiceError('qwen-embedding', 'modal internal failure', { retryable: true }))
      .mockResolvedValue(undefined);

    const readiness = mediaIndexReadiness();
    await vi.runAllTimersAsync();

    await expect(readiness).resolves.toBe(true);
    expect(assertMediaIndexDeploymentsAvailable).toHaveBeenCalledTimes(2);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining('retrying'), expect.objectContaining({ attempt: 1 }));
    // Recovered, so nothing is wrong and nothing is shouted about.
    expect(logError).not.toHaveBeenCalled();
  });

  it('gives up after a bounded number of attempts, and says so', async () => {
    vi.useFakeTimers();
    assertMediaIndexDeploymentsAvailable.mockRejectedValue(
      new ExternalServiceError('qwen-embedding', 'modal internal failure', { retryable: true }),
    );

    const readiness = mediaIndexReadiness();
    await vi.runAllTimersAsync();

    await expect(readiness).resolves.toBe(false);
    // Bounded: this runs before the worker reports ready, so it must never
    // become the reason the worker never does.
    expect(assertMediaIndexDeploymentsAvailable).toHaveBeenCalledTimes(3);
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('could not be resolved'),
      expect.objectContaining({ attempts: 3 }),
    );
  });

  it('keeps asking after a startup outage, and starts the consumer when Modal comes back', async () => {
    // The gap a bounded startup retry leaves. Six seconds of retries covers a
    // blip; a Modal incident lasting minutes would otherwise leave indexing
    // off for this process's whole life, while uploads keep queueing jobs
    // nothing consumes — recoverable only by somebody noticing and restarting
    // a worker that looks completely healthy.
    vi.useFakeTimers();
    const onReady = vi.fn();
    const check = vi.fn<[], Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    watchMediaIndexRecovery(onReady, { intervalMs: 1_000, check });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onReady).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onReady).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onReady).toHaveBeenCalledTimes(1);

    // And then it stops: the queue now has a consumer, and a second one would
    // read the same jobs twice.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledTimes(3);
  });

  it('survives a probe that rejects, and keeps trying', async () => {
    // A thrown re-check must never take the worker down over an optional
    // feature — and must not end the watch either, or one bad probe becomes
    // the permanent outage this whole mechanism exists to prevent.
    vi.useFakeTimers();
    const onReady = vi.fn();
    const check = vi.fn<[], Promise<boolean>>()
      .mockRejectedValueOnce(new Error('modal client blew up'))
      .mockResolvedValue(true);

    watchMediaIndexRecovery(onReady, { intervalMs: 1_000, check });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onReady).not.toHaveBeenCalled();
    expect(logWarn).toHaveBeenCalledWith(
      'media index readiness re-check failed',
      expect.objectContaining({ err: expect.any(Error) }),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it('does not retry a name that will never resolve', async () => {
    // A wrong app name fails identically on the third try. Waiting on it only
    // delays the worker for no gain — and the error already says it is final.
    assertMediaIndexDeploymentsAvailable.mockRejectedValue(
      new ExternalServiceError('qwen-embedding', 'Modal cannot resolve clipit-embedding', { retryable: false }),
    );

    await expect(mediaIndexReadiness()).resolves.toBe(false);

    expect(assertMediaIndexDeploymentsAvailable).toHaveBeenCalledTimes(1);
    expect(logWarn).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('could not be resolved'),
      expect.objectContaining({ remedy: expect.stringContaining('deploy both Modal apps') }),
    );
  });
});
