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
/**
 * Rejects whatever lookup is pending, which is what closing a real client does
 * — the SDK exports ClientClosedError for exactly that. Without modelling it,
 * a test cannot tell "the deadline ended the call" from "the deadline gave up
 * on hearing about it", and those are the two things this file is about.
 */
let endPending: ((reason: Error) => void) | null = null;

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
      endPending?.(new Error('ClientClosedError'));
    };
    cls = { fromName };
  }
  return { ModalClient, InternalFailure, FunctionTimeoutError, NotFoundError, ExecutionError, RemoteError, InvalidError };
});

process.env.MODAL_TOKEN_ID ??= 'token-id';
process.env.MODAL_TOKEN_SECRET ??= 'token-secret';

const { assertModalTargetAvailable, probeModalTarget, resetModalHandles } = await import('../src/services/modal/invoke.js');

const target = {
  app: 'clipit-embedding',
  className: 'QwenEmbeddingService',
  method: 'embed_video_intervals',
  label: 'qwen-embedding',
};

beforeEach(() => {
  closes.length = 0;
  built = 0;
  endPending = null;
  fromName.mockReset();
  fromName.mockResolvedValue({ instance: vi.fn(async () => ({ method: vi.fn() })) } as never);
  resetModalHandles();
});

describe('a readiness probe owns its client', () => {
  it('closes the client it built, every time', async () => {
    await probeModalTarget(target, 5_000);

    // One built, one closed: the probe leaves nothing running behind it, so
    // abandoning it on a deadline is safe to repeat.
    expect(closes).toHaveLength(1);
  });

  it('closes it even when the lookup fails', async () => {
    // A probe against a name that will not resolve still tidies up after
    // itself — an outage's worth of retries must not leak a client each.
    fromName.mockRejectedValue(new Error('no such app'));

    await expect(probeModalTarget({ ...target, app: 'missing' }, 5_000)).rejects.toThrow();

    expect(closes).toHaveLength(1);
  });

  it('ends a lookup that never answers, instead of walking away from it', async () => {
    // The claim this replaced was false, and measurably so: a finally after an
    // await on a promise that never settles does NOT run when the caller races
    // out. Bounding the probe from outside left the client open and the call
    // running — one per retry, one per recovery cycle, for as long as the
    // outage lasted. The deadline has to hold the client and close it.
    vi.useFakeTimers();
    fromName.mockImplementation(
      () => new Promise((_resolve, reject) => {
        endPending = reject;
      }),
    );

    const probing = probeModalTarget(target, 1_000);
    const settled = probing.then(() => 'resolved').catch(() => 'rejected');

    await vi.advanceTimersByTimeAsync(1_000);

    // The deadline closed the client, which ended the lookup, which let the
    // probe unwind — so it is finished, not merely abandoned.
    await expect(settled).resolves.toBe('rejected');
    // One client, and it was closed. Closed twice, in fact — once by the
    // deadline and once by the cleanup on the way out — which is exactly why
    // both swallow the attempt.
    expect(built).toBe(1);
    expect(new Set(closes.map((c) => c.id)).size).toBe(1);
    expect(closes.length).toBeGreaterThan(0);

    vi.useRealTimers();
  });

  it('builds a new one per probe, never reusing a cached lookup', async () => {
    await probeModalTarget(target, 5_000);
    const afterFirst = built;
    await probeModalTarget(target, 5_000);

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
    await assertModalTargetAvailable(target);
    expect(built).toBe(1);
    closes.length = 0;

    resetModalHandles();

    expect(closes).toHaveLength(0);
  });
});
