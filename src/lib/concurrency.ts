/** Counting semaphore used to cap in-flight calls to an external API. */
export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.available = Math.max(1, Math.floor(permits));
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return this.createRelease();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
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
