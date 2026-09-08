import { describe, expect, it } from 'vitest';
import { cosineSimilarity, packVector, unpackVector } from '../src/services/mediaIndex/vectors.js';

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
    expect(() => packVector([1, Number.NaN, 3])).toThrow(/index 1 is not a finite number/);
    expect(() => packVector([Number.POSITIVE_INFINITY])).toThrow(/not a finite number/);
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
