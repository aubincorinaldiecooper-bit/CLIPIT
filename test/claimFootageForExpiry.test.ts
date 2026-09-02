import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
vi.mock('../src/db/pool.js', () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
  queryRows: vi.fn(),
  query: vi.fn(),
}));

const { claimFootageForExpiry } = await import('../src/db/repositories/videos.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('claimFootageForExpiry', () => {
  it('marks the video expired only while it is still unowned and not yet expired, in one statement', async () => {
    queryOne.mockResolvedValueOnce({ id: 'v1' });

    expect(await claimFootageForExpiry('v1')).toBe(true);
    const [sql, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE videos/);
    expect(sql).toMatch(/SET footage_expired_at = now\(\)/);
    expect(sql).toMatch(/footage_expired_at IS NULL/);
    expect(sql).toMatch(/user_id IS NULL/);
    expect(sql).toMatch(/RETURNING id/);
    expect(params).toEqual(['v1']);
  });

  it('refuses when the row is no longer a guest’s', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect(await claimFootageForExpiry('v1')).toBe(false);
  });
});
