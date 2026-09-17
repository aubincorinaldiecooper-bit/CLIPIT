import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FrameStreamVideoSource } from '../src/services/video/source.js';

/**
 * A page with no video in it must not take the worker down with it.
 *
 * On 17 September a real search died this way. One candidate page had no
 * `<video>` element, the browser said so, and the whole worker process
 * exited — every queue on it, not just the search. BullMQ's lock outlived
 * the dead process by five minutes, re-ran the same search from scratch,
 * and it died again. The person watching got a spinner for ten minutes and
 * then "job stalled more than allowable limit".
 *
 * The mechanism is a promise nobody was holding. The frame producer runs as
 * its own task while the consumer polls Modal for output. If the browser
 * fails before Modal answers — and a page with no video fails immediately —
 * the producer rejects with no handler attached to it yet, because the only
 * `await` on it sits below the consumer loop. Node's answer to an unhandled
 * rejection is to end the process.
 *
 * So this test does not check an error message. It checks that no unhandled
 * rejection is ever raised, which is the thing that actually killed us.
 */

const spawnModal = vi.fn();
const createEphemeralModalQueue = vi.fn();

vi.mock('../src/services/modal/invoke.js', () => ({
  spawnModal,
  createEphemeralModalQueue,
  invokeModal: vi.fn(),
  assertModalTargetAvailable: vi.fn(),
}));

const { watchStreamWithVideoChat3 } = await import('../src/services/videochat3/client.js');

/** A browser that reports the page has no video, exactly as watch.mjs does. */
function pageWithNoVideo(): FrameStreamVideoSource {
  return {
    kind: 'frame-stream',
    id: 'candidate-with-no-video',
    // eslint-disable-next-line require-yield
    async *open() {
      throw new Error('no video element on the page');
    },
    completion: Promise.resolve({
      exhausted: false,
      reason: 'no video element on the page',
      watchedThroughSeconds: 0,
      mediaSecondsObserved: 0,
    }),
  };
}

/**
 * Modal, answering slowly.
 *
 * The delay is the whole point: it holds the consumer loop open long enough
 * for the producer's rejection to go unhandled, which is what happens in
 * production every time, since a page with no video fails in milliseconds
 * and a GPU container takes seconds to answer.
 */
function modalThatAnswersAfter(ms: number) {
  const queue = () => ({ queueId: 'q', put: vi.fn().mockResolvedValue(undefined), closeEphemeral: vi.fn() });
  createEphemeralModalQueue.mockImplementation(async () => queue());
  spawnModal.mockResolvedValue({ get: vi.fn().mockResolvedValue(undefined) });

  let answered = false;
  const output = {
    queueId: 'out',
    put: vi.fn().mockResolvedValue(undefined),
    closeEphemeral: vi.fn(),
    get: vi.fn().mockImplementation(async () => {
      if (answered) return null;
      await new Promise((resolve) => setTimeout(resolve, ms));
      answered = true;
      return {
        type: 'done',
        ok: true,
        model: 'MCG-NJU/VideoChat3-4B',
        revision: 'test',
        duration_seconds: 0,
        watched_through_seconds: 0,
        exhausted: false,
        metrics: {},
      };
    }),
  };
  let call = 0;
  createEphemeralModalQueue.mockImplementation(async () => (call++ === 0 ? queue() : output));
}

let seen: unknown[] = [];
const record = (reason: unknown) => { seen.push(reason); };

afterEach(() => {
  process.off('unhandledRejection', record);
  seen = [];
  vi.clearAllMocks();
});

describe('a candidate page that cannot be watched', () => {
  it('does not raise an unhandled rejection, which is what ended the worker', async () => {
    modalThatAnswersAfter(40);
    seen = [];
    process.on('unhandledRejection', record);

    await watchStreamWithVideoChat3({ source: pageWithNoVideo(), query: 'anything' })
      .catch(() => undefined);

    // Node decides a rejection is unhandled at the end of the turn it settled
    // in, so give it turns to decide in before asking.
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(seen).toEqual([]);
  });

  it('still reports the browser reason to its caller rather than swallowing it', async () => {
    modalThatAnswersAfter(40);
    await expect(watchStreamWithVideoChat3({ source: pageWithNoVideo(), query: 'anything' }))
      .rejects.toThrow(/no video element on the page/);
  });
});
