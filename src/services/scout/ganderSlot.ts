/**
 * The Thinker slot.
 *
 * There are four scouts and one model. The runtime enforces that itself — a
 * second session gets refused while the first holds the lock — but a refusal
 * is a lost candidate, so the scouts queue here instead of racing and losing.
 *
 * "Four scouts time-sharing the constrained underlying Thinker capacity,
 * rather than four copies of the model" (CLIPIT#131). This is the
 * time-sharing.
 */
export class ThinkerSlot {
  private held = false;
  private readonly waiting: Array<() => void> = [];

  /**
   * Wait for the slot, then run. The slot is released even when the work
   * throws — a scout that failed while holding it must not strand the others.
   */
  async use<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('cancelled before the Thinker was free');
    if (!this.held) {
      this.held = true;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const take = () => {
        signal?.removeEventListener('abort', onAbort);
        this.held = true;
        resolve();
      };
      const onAbort = () => {
        const at = this.waiting.indexOf(take);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(new Error('cancelled while waiting for the Thinker'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(take);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      // Handed straight on rather than cleared first: clearing would let a
      // scout that is not in this queue take the slot out of turn.
      next();
      return;
    }
    this.held = false;
  }

  /** How many scouts are waiting. For logging, not for decisions. */
  get queued(): number {
    return this.waiting.length;
  }
}
