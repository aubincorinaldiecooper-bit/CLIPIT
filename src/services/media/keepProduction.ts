/**
 * Keep, on a moment whose file is about to be made: approve it, then queue
 * the render — and unwind the approval if the queue refuses.
 *
 * Order matters and both orders are wrong on their own. Queue first, and a
 * render can finish for a moment nobody has approved, which a retried search
 * is allowed to sweep away with its file. Approve first — as this does — and
 * a queue that refuses leaves an owned, approved clip that nothing will ever
 * cut (Devin's finding on #95). So the approval is recorded first, for the
 * protection it gives, and taken back when the queue says no, exactly as
 * the Re-clip route unwinds its claim when its job cannot be queued.
 *
 * Pure of any database: the three acts are injected so this is a decision
 * with tests, not a route with side effects.
 */
export class KeepNotQueuedError extends Error {
  constructor(readonly clipId: string, override readonly cause: unknown) {
    super('Keep could not be queued. Nothing was changed — try again in a moment.');
    this.name = 'KeepNotQueuedError';
  }
}

export async function approveAndQueue(input: {
  clipId: string;
  /** Records the approval; says whether this press made it. Null when the clip is gone. */
  approve: (clipId: string) => Promise<{ newlyApproved: boolean } | null>;
  enqueue: (clipId: string) => Promise<void>;
  /** Unwinds a press whose job could not be queued. */
  undo: (clipId: string, input: { newlyApproved: boolean; reason: string }) => Promise<void>;
}): Promise<void> {
  const approval = await input.approve(input.clipId);
  if (!approval) {
    throw new KeepNotQueuedError(input.clipId, new Error('the clip no longer exists'));
  }
  try {
    await input.enqueue(input.clipId);
  } catch (cause) {
    // Best-effort: if the unwind itself fails the row stays approved and
    // unqueued, which the next Keep repairs; the person is told either way.
    await input.undo(input.clipId, {
      newlyApproved: approval.newlyApproved,
      reason: 'The cut could not be queued. Keep it again to retry.',
    }).catch(() => undefined);
    throw new KeepNotQueuedError(input.clipId, cause);
  }
}
