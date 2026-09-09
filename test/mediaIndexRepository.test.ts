import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryRows = vi.fn();

vi.mock('../src/db/pool.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  queryRows: (...args: unknown[]) => queryRows(...args),
  withTransaction: vi.fn(),
}));

const { listIndexedWindows } = await import('../src/db/repositories/mediaIndex.js');

beforeEach(() => {
  vi.clearAllMocks();
  queryRows.mockResolvedValue([]);
});

describe('listIndexedWindows', () => {
  it('loads only windows whose complete provenance matches the active index status', async () => {
    await listIndexedWindows('video-1');

    const [sql, params] = queryRows.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['video-1']);
    expect(sql).toMatch(/m\.model = s\.model/);
    expect(sql).toMatch(/m\.revision = s\.revision/);
    expect(sql).toMatch(/m\.dims = s\.dims/);
    expect(sql).toMatch(/m\.index_version = s\.index_version/);
    expect(sql).toMatch(/m\.source_identity = s\.source_identity/);
  });
});
