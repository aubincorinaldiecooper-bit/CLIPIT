import { describe, expect, it } from 'vitest';
import { buildWindowInsert } from '../src/db/repositories/mediaIndex.js';
import { packVector } from '../src/services/mediaIndex/vectors.js';

/**
 * This file exists because the statement shipped once with a placeholder that
 * had no value behind it. Postgres would have rejected every insert for a
 * parameter-count mismatch — no video would ever have stored a vector — and
 * nothing caught it: TypeScript cannot see inside a SQL string, and nothing
 * else here reaches a real server.
 */

const provenance = {
  dims: 3,
  model: 'qwen-embed',
  revision: 'abc123',
  indexVersion: 'v1',
  sourceIdentity: 'proxies/v1/proxy.mp4#etag',
};
const runStartedAt = new Date('2026-09-08T09:00:00Z');

function windows(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    windowKey: `${i}`,
    startSeconds: i * 10,
    endSeconds: i * 10 + 10,
    embedding: [0.1, 0.2, 0.3],
  }));
}

function placeholders(text: string): number[] {
  return [...text.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
}

describe('buildWindowInsert', () => {
  it.each([1, 2, 5, 32])('binds a value for every placeholder with %i windows', (count) => {
    const { text, values } = buildWindowInsert('v1', windows(count), provenance, packVector, runStartedAt);
    const used = placeholders(text);

    // The exact failure that shipped: a placeholder numbered past the end of
    // the bound values.
    expect(Math.max(...used)).toBe(values.length);
    // And nothing bound that the statement never references.
    for (let i = 1; i <= values.length; i += 1) {
      expect(used).toContain(i);
    }
  });

  it('binds eight values per window plus three shared ones', () => {
    const { values } = buildWindowInsert('v1', windows(4), provenance, packVector, runStartedAt);

    expect(values).toHaveLength(4 * 8 + 3);
  });

  it('ends with the three values every row shares', () => {
    const { values } = buildWindowInsert('v1', windows(2), provenance, packVector, runStartedAt);

    expect(values.slice(-3)).toEqual([provenance.indexVersion, provenance.sourceIdentity, runStartedAt]);
  });

  it('names as many columns as each row supplies', () => {
    const { text } = buildWindowInsert('v1', windows(1), provenance, packVector, runStartedAt);
    const columns = text.slice(text.indexOf('(') + 1, text.indexOf(')')).split(',').length;
    const perRow = text.slice(text.indexOf('VALUES ('), text.indexOf(')', text.indexOf('VALUES ('))).split(',').length;

    expect(perRow).toBe(columns);
  });

  it('packs each window vector into its own parameter', () => {
    const { values } = buildWindowInsert('v1', windows(3), provenance, packVector, runStartedAt);
    const buffers = values.filter((value): value is Buffer => Buffer.isBuffer(value));

    expect(buffers).toHaveLength(3);
    for (const buffer of buffers) expect(buffer).toHaveLength(provenance.dims * 4);
  });
});
