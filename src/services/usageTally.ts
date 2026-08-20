import type { ModelTokenUsage } from '../db/repositories/usage.js';

/**
 * Running total of what a piece of work cost, accumulated as each model call
 * reports in.
 *
 * `model_usage` is the durable record, but its rows are written fire-and-forget
 * so that losing one never fails the work that produced it. Reading them back
 * to summarise a job would therefore race its own inserts. Tallying the same
 * numbers in memory sidesteps that: the log line is exact, costs no query, and
 * the table stays authoritative for anything asked later.
 */
export class UsageTally {
  calls = 0;
  promptTokens = 0;
  completionTokens = 0;
  totalTokens = 0;
  costUsd = 0;
  /** Calls whose provider reported no price. */
  callsMissingCost = 0;

  add(usage: ModelTokenUsage): void {
    this.calls += 1;
    this.promptTokens += usage.promptTokens;
    this.completionTokens += usage.completionTokens;
    this.totalTokens += usage.totalTokens;
    if (typeof usage.costUsd === 'number') this.costUsd += usage.costUsd;
    else this.callsMissingCost += 1;
  }

  /**
   * Fields for one log line, complete enough to price from without a query.
   *
   * `costComplete` is the honest caveat: with any call missing a price the
   * total is a floor rather than the cost, and a number read out of a log has
   * no other way to carry that.
   */
  summary(): Record<string, unknown> {
    return {
      calls: this.calls,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      totalTokens: this.totalTokens,
      costUsd: round(this.costUsd, 6),
      costComplete: this.callsMissingCost === 0,
      ...(this.callsMissingCost > 0 ? { callsMissingCost: this.callsMissingCost } : {}),
    };
  }

  /** Cost per minute of source, the figure that scales to other videos. */
  perSourceMinute(durationSeconds: number | null): number | null {
    if (!durationSeconds || durationSeconds <= 0 || this.costUsd <= 0) return null;
    return round(this.costUsd / (durationSeconds / 60), 6);
  }
}

function round(value: number, places: number): number {
  return Number(value.toFixed(places));
}
