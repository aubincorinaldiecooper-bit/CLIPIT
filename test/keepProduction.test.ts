import { describe, expect, it, vi } from 'vitest';
import { KeepNotQueuedError, approveAndQueue } from '../src/services/media/keepProduction.js';

/**
 * Keep approves the moment and queues its render. Devin's finding on #95:
 * approval first, then a queue that refuses, left an owned, approved clip
 * that nothing would ever cut. The press is unwound instead — and only the
 * approval THIS press made is taken back.
 */

function acts(over: Partial<{
  approve: (clipId: string) => Promise<{ newlyApproved: boolean } | null>;
  enqueue: (clipId: string) => Promise<void>;
  undo: (clipId: string, input: { newlyApproved: boolean; reason: string }) => Promise<void>;
}> = {}) {
  return {
    approve: vi.fn(async () => ({ newlyApproved: true })),
    enqueue: vi.fn(async () => undefined),
    undo: vi.fn(async () => undefined),
    ...over,
  };
}

describe('approveAndQueue', () => {
  it('approves first, then queues, and unwinds nothing', async () => {
    const a = acts();
    await approveAndQueue({ clipId: 'clip-1', ...a });

    expect(a.approve).toHaveBeenCalledWith('clip-1');
    expect(a.enqueue).toHaveBeenCalledWith('clip-1');
    expect(a.approve.mock.invocationCallOrder[0]!).toBeLessThan(a.enqueue.mock.invocationCallOrder[0]!);
    expect(a.undo).not.toHaveBeenCalled();
  });

  it('takes the approval back when the queue refuses, and says so in words a person can act on', async () => {
    const a = acts({ enqueue: vi.fn(async () => { throw new Error('redis refused'); }) });

    await expect(approveAndQueue({ clipId: 'clip-1', ...a })).rejects.toBeInstanceOf(KeepNotQueuedError);
    await expect(approveAndQueue({ clipId: 'clip-1', ...a })).rejects.toThrow('try again in a moment');

    expect(a.undo).toHaveBeenCalledWith('clip-1', expect.objectContaining({ newlyApproved: true }));
    expect((a.undo.mock.calls[0]![1] as { reason: string }).reason).toMatch(/Keep it again/);
  });

  it('never takes back an approval an earlier Keep made', async () => {
    const a = acts({
      approve: vi.fn(async () => ({ newlyApproved: false })),
      enqueue: vi.fn(async () => { throw new Error('redis refused'); }),
    });

    await expect(approveAndQueue({ clipId: 'clip-1', ...a })).rejects.toBeInstanceOf(KeepNotQueuedError);
    expect(a.undo).toHaveBeenCalledWith('clip-1', expect.objectContaining({ newlyApproved: false }));
  });

  it('refuses when the clip is gone, without queueing anything', async () => {
    const a = acts({ approve: vi.fn(async () => null) });

    await expect(approveAndQueue({ clipId: 'clip-1', ...a })).rejects.toBeInstanceOf(KeepNotQueuedError);
    expect(a.enqueue).not.toHaveBeenCalled();
    expect(a.undo).not.toHaveBeenCalled();
  });

  it('still reports the queue failure when the unwind itself fails', async () => {
    const cause = new Error('redis refused');
    const a = acts({
      enqueue: vi.fn(async () => { throw cause; }),
      undo: vi.fn(async () => { throw new Error('database unreachable'); }),
    });

    const error = await approveAndQueue({ clipId: 'clip-1', ...a }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeepNotQueuedError);
    expect((error as KeepNotQueuedError).cause).toBe(cause);
  });
});
