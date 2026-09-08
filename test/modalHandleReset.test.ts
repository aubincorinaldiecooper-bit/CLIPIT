import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A health check must not borrow the client that serves live traffic.
 *
 * The readiness probe took three goes to get right, and each wrong answer was
 * a real failure in production terms:
 *
 * 1. It shared the cached deployment handle. A lookup that hung was then
 *    adopted by every later probe, so Modal could recover and the watch would
 *    never notice — defeating the recovery it exists to provide.
 * 2. Clearing the cache fixed that and left the abandoned call running: one
 *    per retry, each holding a connection, for an answer nobody wanted.
 * 3. Closing the shared client on the way out ended those calls — and every
 *    SEARCH's call with them, because the recovery watch runs in the same
 *    process as the clip-search worker. A failed health check would have
 *    cancelled a person's search and sent it to the slow, expensive path.
 *
 * The answer is a client per probe. These pin it: the probe builds and closes
 * its own, and resetting the shared cache never closes the client that live
 * searches are using.
 */

const closes: Array<{ id: number }> = [];
let built = 0;
/** Shared by every client the mock builds, so a test can steer any probe. */
const fromName = vi.fn(async () => ({ instance: vi.fn(async () => ({ method: vi.fn() })) }));

vi.mock('modal', () => {
  class InternalFailure extends Error {}
  class FunctionTimeoutError extends Error {}
  class NotFoundError extends Error {}
  class ExecutionError extends Error {}
  class RemoteError extends Error {}
  class InvalidError extends Error {}
  class ModalClient {
    id: number;
    constructor() {
      built += 1;
      this.id = built;
    }
    close = () => {
      closes.push({ id: this.id });
    };
    cls = { fromName };
  }
  return { ModalClient, InternalFailure, FunctionTimeoutError, NotFoundError, ExecutionError, RemoteError, InvalidError };
});

process.env.MODAL_TOKEN_ID ??= 'token-id';
process.env.MODAL_TOKEN_SECRET ??= 'token-secret';

const { invokeModal, probeModalTarget, resetModalHandles } = await import('../src/services/modal/invoke.js');

const target = {
  app: 'clipit-embedding',
  className: 'QwenEmbeddingService',
  method: 'embed_video_intervals',
  label: 'qwen-embedding',
};

beforeEach(() => {
  closes.length = 0;
  built = 0;
  fromName.mockReset();
  fromName.mockResolvedValue({ instance: vi.fn(async () => ({ method: vi.fn() })) } as never);
  resetModalHandles();
});

describe('a readiness probe owns its client', () => {
  it('closes the client it built, every time', async () => {
    await probeModalTarget(target);

    // One built, one closed: the probe leaves nothing running behind it, so
    // abandoning it on a deadline is safe to repeat.
    expect(closes).toHaveLength(1);
  });

  it('closes it even when the lookup fails', async () => {
    // A probe against a name that will not resolve still tidies up after
    // itself — an outage's worth of retries must not leak a client each.
    fromName.mockRejectedValue(new Error('no such app'));

    await expect(probeModalTarget({ ...target, app: 'missing' })).rejects.toThrow();

    expect(closes).toHaveLength(1);
  });

  it('builds a new one per probe, never reusing a cached lookup', async () => {
    await probeModalTarget(target);
    const afterFirst = built;
    await probeModalTarget(target);

    // Nothing is cached, so a hung probe cannot be adopted by the next one.
    expect(built).toBeGreaterThan(afterFirst);
  });
});

describe('resetting the shared handles leaves live traffic alone', () => {
  it('never closes the client that searches are using', async () => {
    // The regression this replaced. resetModalHandles runs where an inference
    // call has failed and the handle needs re-resolving; closing the client
    // there would abort every OTHER call in flight on it — the searches a
    // person is waiting on.
    await invokeModal(target, {}).catch(() => undefined);
    closes.length = 0;

    resetModalHandles();

    expect(closes).toHaveLength(0);
  });
});
