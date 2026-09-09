import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryRows = vi.fn();

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(),
  queryRows: (...args: unknown[]) => queryRows(...args),
}));

vi.mock('../src/lib/logger.js', () => ({ logger: { warn: vi.fn() } }));

const { usageForVideo } = await import('../src/db/repositories/usage.js');

beforeEach(() => {
  vi.clearAllMocks();
  queryRows.mockResolvedValue([]);
});

describe('usageForVideo', () => {
  it('counts vector generation as ingestion without counting per-question stages', async () => {
    await usageForVideo('video-1');

    const [sql, params] = queryRows.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('stage = ANY($2::text[])');
    expect(params).toEqual(['video-1', ['transcription', 'indexing', 'embedding']]);
    expect(params[1]).not.toContain('search');
    expect(params[1]).not.toContain('rerank');
  });
});
