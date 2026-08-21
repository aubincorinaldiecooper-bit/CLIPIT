/**
 * Counting semaphore used to cap in-flight calls to an external API.
 *
 * It counts what actually happened as well as capping it. That is not
 * decoration: a setting saying eight and a gate letting through four look
 * identical from the outside, and exactly that went unnoticed until the
 * numbers disagreed. What a limit is configured to be is a claim; how many
 * calls were genuinely in flight is evidence.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];
  private readonly permits: number;
  private inFlight = 0;
  private peakInFlight = 0;

  constructor(permits: number) {
    this.available = Math.max(1, Math.floor(permits));
    this.permits = this.available;
  }

  /**
   * What this gate is set to, how many calls are passing through it right now,
   * and the most that ever were. If `peak` never reaches `limit` under load,
   * something upstream is the real bottleneck — which is the fact that was
   * missing when reading a video was raised to eight and stayed at four.
   */
  snapshot(): { limit: number; inFlight: number; peak: number } {
    return { limit: this.permits, inFlight: this.inFlight, peak: this.peakInFlight };
  }

  /** Forgets the high-water mark, so one job's peak is that job's own. */
  resetPeak(): void {
    this.peakInFlight = this.inFlight;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.enter();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.enter();
  }

  private enter(): () => void {
    this.inFlight += 1;
    if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
    return this.createRelease();
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      const next = this.waiters.shift();
      if (next) next();
      else this.available += 1;
    };
  }
}

/**
 * Maps over items with bounded concurrency, preserving input order and never
 * rejecting: each result is tagged so one failure cannot abort the batch.
 */
export type SettledResult<T> = { status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown };

export async function mapWithConcurrency<TInput, TOutput>(
  items: TInput[],
  limit: number,
  fn: (item: TInput, index: number) => Promise<TOutput>,
): Promise<SettledResult<TOutput>[]> {
  const results: SettledResult<TOutput>[] = new Array(items.length);
  const concurrency = Math.max(1, Math.min(Math.floor(limit), items.length || 1));
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index] as TInput, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
