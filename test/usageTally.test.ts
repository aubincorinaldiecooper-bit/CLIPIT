import { describe, expect, it } from 'vitest';
import { UsageTally } from '../src/services/usageTally.js';

const call = (overrides: Partial<{ promptTokens: number; completionTokens: number; totalTokens: number; costUsd: number | null }> = {}) => ({
  promptTokens: 1_000,
  completionTokens: 100,
  totalTokens: 1_100,
  costUsd: 0.002,
  ...overrides,
});

describe('UsageTally', () => {
  it('sums tokens and cost across calls', () => {
    const tally = new UsageTally();
    tally.add(call());
    tally.add(call());
    tally.add(call());

    expect(tally.summary()).toMatchObject({
      calls: 3,
      promptTokens: 3_000,
      completionTokens: 300,
      totalTokens: 3_300,
      costUsd: 0.006,
      costComplete: true,
    });
  });

  /**
   * `cost_usd` is nullable because a provider may report tokens and no price.
   * A total read off a log line has no way to carry that caveat itself, so it
   * has to be stated: otherwise an under-count reads as the real cost and
   * pricing is set from it.
   */
  it('flags a total that is a floor rather than the cost', () => {
    const tally = new UsageTally();
    tally.add(call());
    tally.add(call({ costUsd: null }));

    expect(tally.summary()).toMatchObject({
      calls: 2,
      costUsd: 0.002,
      costComplete: false,
      callsMissingCost: 1,
    });
  });

  it('omits the missing-cost count when every call reported a price', () => {
    const tally = new UsageTally();
    tally.add(call());

    expect(tally.summary()).not.toHaveProperty('callsMissingCost');
  });

  /** Floating-point sums otherwise log as 0.006000000000000001. */
  it('rounds cost to a readable number of places', () => {
    const tally = new UsageTally();
    tally.add(call({ costUsd: 0.1 }));
    tally.add(call({ costUsd: 0.2 }));

    expect(tally.summary().costUsd).toBe(0.3);
  });

  it('derives cost per minute of source, which is what scales to other videos', () => {
    const tally = new UsageTally();
    tally.add(call({ costUsd: 0.6 }));

    // 20 minutes of source at $0.60 total.
    expect(tally.perSourceMinute(1_200)).toBe(0.03);
  });

  it.each([
    ['unknown duration', null],
    ['zero duration', 0],
  ])('reports no per-minute figure for %s rather than dividing by it', (_label, duration) => {
    const tally = new UsageTally();
    tally.add(call());

    expect(tally.perSourceMinute(duration)).toBeNull();
  });

  it('reports no per-minute figure when nothing reported a cost', () => {
    const tally = new UsageTally();
    tally.add(call({ costUsd: null }));

    expect(tally.perSourceMinute(1_200)).toBeNull();
  });

  it('summarises an empty tally without inventing numbers', () => {
    const tally = new UsageTally();

    expect(tally.summary()).toMatchObject({ calls: 0, totalTokens: 0, costUsd: 0 });
    expect(tally.perSourceMinute(1_200)).toBeNull();
  });
});
