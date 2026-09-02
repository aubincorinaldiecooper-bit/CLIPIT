import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
vi.mock('../src/db/pool.js', () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
  queryRows: vi.fn(),
  query: vi.fn(),
}));

const { claimFootageForExpiry, releaseFootageClaim } = await import('../src/db/repositories/videos.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('claimFootageForExpiry', () => {
  it('for the sweep, marks the video expired only while it is still unowned and not yet expired, in one statement', async () => {
    const claimedAt = new Date('2026-09-02T20:30:00Z');
    queryOne.mockResolvedValueOnce({ footage_expired_at: claimedAt });

    expect(await claimFootageForExpiry('v1', { onlyIfUnowned: true })).toBe(claimedAt);
    const [sql, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE videos/);
    expect(sql).toMatch(/SET footage_expired_at = now\(\)/);
    expect(sql).toMatch(/footage_expired_at IS NULL/);
    expect(sql).toMatch(/user_id IS NULL/);
    expect(sql).toMatch(/RETURNING footage_expired_at/);
    expect(params).toEqual(['v1']);
  });

  it('for an owner’s own removal, does not ask whether the video is unowned', async () => {
    queryOne.mockResolvedValueOnce({ footage_expired_at: new Date() });

    expect(await claimFootageForExpiry('v1', { onlyIfUnowned: false })).toBeInstanceOf(Date);
    const [sql] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/footage_expired_at IS NULL/);
    expect(sql).not.toMatch(/user_id IS NULL/);
  });

  it('refuses when the row is no longer a guest’s, or already expired', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect(await claimFootageForExpiry('v1', { onlyIfUnowned: true })).toBeNull();
  });
});

describe('releaseFootageClaim', () => {
  it('clears exactly the claim named, so a later sweep selects the video again and a finished removal is never revived', async () => {
    const claimedAt = new Date('2026-09-02T20:30:00Z');
    queryOne.mockResolvedValueOnce(null);

    await releaseFootageClaim('v1', claimedAt);

    const [sql, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE videos/);
    expect(sql).toMatch(/SET footage_expired_at = NULL/);
    expect(sql).toMatch(/footage_expired_at = \$2/);
    expect(params).toEqual(['v1', claimedAt]);
  });
});
