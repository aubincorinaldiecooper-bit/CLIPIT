import { describe, expect, it } from 'vitest';
import { cosineSimilarity, packVector, unpackVector } from '../src/services/mediaIndex/vectors.js';
import { statusWriteDecision } from '../src/db/repositories/mediaIndex.js';

/**
 * A vector that survives storage and comes back wrong is worse than one that
 * fails to store: it produces a search that runs, returns moments, and ranks
 * them by nothing. Everything here is about making that impossible to do
 * quietly.
 */

describe('packVector / unpackVector', () => {
  it('returns the same numbers it was given, within float32 precision', () => {
    const values = [0, 1, -1, 0.5, -0.25, 1e-8, 12345.75];
    const back = unpackVector(packVector(values), values.length);

    for (let i = 0; i < values.length; i += 1) {
      expect(back[i]).toBeCloseTo(values[i], 5);
    }
  });

  it('uses four bytes per value', () => {
    expect(packVector([1, 2, 3]).length).toBe(12);
  });

  it('refuses to store a value that is not a finite number', () => {
    expect(() => packVector([1, Number.NaN, 3])).toThrow(/index 1 is not a finite float32/);
    expect(() => packVector([Number.POSITIVE_INFINITY])).toThrow(/not a finite float32/);
  });

  it('refuses a value that is finite in JavaScript but infinite once stored', () => {
    // 1e39 passes Number.isFinite and becomes Infinity as a float32. Stored,
    // it would turn every comparison it touches into NaN.
    expect(() => packVector([1e39])).toThrow(/not a finite float32/);
    expect(() => packVector([-1e39])).toThrow(/not a finite float32/);
    // The largest value that does survive is kept.
    expect(() => packVector([3.4e38])).not.toThrow();
  });

  it('refuses to read a vector whose byte length does not match its stated size', () => {
    const bytes = packVector([1, 2, 3]);

    expect(() => unpackVector(bytes, 4)).toThrow(/is not 4 float32 values/);
    expect(() => unpackVector(bytes.subarray(0, 8), 3)).toThrow(/8 bytes/);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for a vector against itself and -1 against its opposite', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 2, 3], [-1, -2, -3])).toBeCloseTo(-1);
  });

  it('is 0 for vectors at right angles', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it('ignores magnitude, so an unnormalised model ranks the same as a normalised one', () => {
    const query = [1, 2, 3];
    const short = [2, 1, 0];
    const long = short.map((value) => value * 1000);

    expect(cosineSimilarity(query, long)).toBeCloseTo(cosineSimilarity(query, short));
  });

  it('scores a zero vector as similar to nothing rather than returning NaN', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it('stays finite for every value a float32 vector can hold', () => {
    // Raised in review as an overflow: "a vector containing 1e30 is not
    // similar to itself". It is — the accumulators are float64, and the
    // largest sum of squares a 2048-dimension float32 vector can produce is
    // about 2.4e80, against a limit near 1.8e308. Pinned so the claim does
    // not come back.
    expect(cosineSimilarity([1e30], [1e30])).toBeCloseTo(1);
    expect(cosineSimilarity([1e-38], [1e-38])).toBeCloseTo(1);
    expect(cosineSimilarity([3.4e38, 1e-38], [3.4e38, 1e-38])).toBeCloseTo(1);

    const wide = new Array(2048).fill(3.4e38);
    const self = cosineSimilarity(wide, wide);
    expect(Number.isFinite(self)).toBe(true);
    expect(self).toBeCloseTo(1);
  });

  it('refuses to compare vectors of different sizes', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/2-dimension vector with a 3-dimension/);
  });

  it('ranks a stored vector the same after a round trip through bytes', () => {
    const query = [0.1, 0.9, -0.4, 0.2];
    const near = [0.12, 0.88, -0.38, 0.25];
    const far = [-0.9, 0.1, 0.7, -0.6];

    const nearBack = unpackVector(packVector(near), near.length);
    const farBack = unpackVector(packVector(far), far.length);

    expect(cosineSimilarity(query, nearBack)).toBeGreaterThan(cosineSimilarity(query, farBack));
    expect(cosineSimilarity(query, nearBack)).toBeCloseTo(cosineSimilarity(query, near), 5);
  });
});


describe('statusWriteDecision', () => {
  it('keeps the recorded failure when a later write does not mention it', () => {
    // The bug this pins: a progress update on a failed row erased why it failed.
    expect(statusWriteDecision('failed', { windowsStored: 5 }).writeError).toBe(false);
  });

  it('clears the failure when a fresh run starts', () => {
    for (const state of ['queued', 'running'] as const) {
      const decision = statusWriteDecision(state, {});
      expect(decision.writeError).toBe(true);
      expect(decision.errorValue).toBeNull();
    }
  });

  it('writes an error that was given, and clears one given as null', () => {
    expect(statusWriteDecision('failed', { error: 'the model refused' })).toMatchObject({
      writeError: true,
      errorValue: 'the model refused',
    });
    expect(statusWriteDecision('ready', { error: null })).toMatchObject({
      writeError: true,
      errorValue: null,
    });
  });

  it('empties the finish time whenever the run is not over', () => {
    // Otherwise a row reads `running` and claims it finished during the last
    // attempt — two things that cannot both be true.
    expect(statusWriteDecision('queued', {}).clearFinished).toBe(true);
    expect(statusWriteDecision('running', {}).clearFinished).toBe(true);
  });

  it('keeps the finish time on every state that means the run is over', () => {
    for (const state of ['ready', 'partial', 'failed', 'unavailable'] as const) {
      expect(statusWriteDecision(state, {}).clearFinished).toBe(false);
    }
  });
});
