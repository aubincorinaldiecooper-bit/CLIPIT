import { describe, expect, it, vi } from 'vitest';

/**
 * Dropping a Modal client is not the same as ending it.
 *
 * The readiness probe abandons a deployment lookup that overruns its deadline,
 * and clears the cached handle so the next probe starts a fresh one — without
 * which a single hung lookup is adopted by every later probe and Modal can
 * recover unnoticed.
 *
 * But abandoning the promise does not end the call underneath it. During an
 * outage the probe retries every minute, so forgetting the reference would
 * leave one dead lookup and one client behind per attempt, each holding a
 * connection open for an answer nobody is waiting for any more.
 *
 * This pins the half of that this repository controls: reset CLOSES the client
 * before dropping it. Whether close() tears down the in-flight call is the
 * SDK's contract — it exports ClientClosedError for exactly that — and is not
 * something a test here can prove.
 */

const close = vi.fn();
const constructed = vi.fn();

vi.mock('modal', () => {
  class InternalFailure extends Error {}
  class FunctionTimeoutError extends Error {}
  class NotFoundError extends Error {}
  class ExecutionError extends Error {}
  class RemoteError extends Error {}
  class InvalidError extends Error {}
  class ModalClient {
    constructor() {
      constructed();
    }
    close = close;
    cls = { fromName: vi.fn(async () => ({ instance: vi.fn(async () => ({ method: vi.fn() })) })) };
  }
  return { ModalClient, InternalFailure, FunctionTimeoutError, NotFoundError, ExecutionError, RemoteError, InvalidError };
});

process.env.MODAL_TOKEN_ID ??= 'token-id';
process.env.MODAL_TOKEN_SECRET ??= 'token-secret';

const { assertModalTargetAvailable, resetModalHandles } = await import('../src/services/modal/invoke.js');

const target = { app: 'clipit-embedding', className: 'QwenEmbeddingService', method: 'embed_video_intervals', label: 'qwen-embedding' };

describe('resetting the Modal handles', () => {
  it('closes the client rather than only forgetting it', async () => {
    // A probe that built a client.
    await assertModalTargetAvailable(target);
    expect(constructed).toHaveBeenCalled();

    resetModalHandles();

    // Without this, an outage's worth of retries leaves one live client each.
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('survives a close that throws, because a health check must not fail on cleanup', async () => {
    close.mockImplementationOnce(() => {
      throw new Error('already closed');
    });
    await assertModalTargetAvailable(target);

    expect(() => resetModalHandles()).not.toThrow();
  });

  it('builds a fresh client for the next probe', async () => {
    await assertModalTargetAvailable(target);
    const before = constructed.mock.calls.length;

    resetModalHandles();
    await assertModalTargetAvailable(target);

    // The point of resetting: the next probe must not adopt the old lookup.
    expect(constructed.mock.calls.length).toBeGreaterThan(before);
  });
});
