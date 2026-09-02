import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
const queryRows = vi.fn();
vi.mock('../src/db/pool.js', () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
  queryRows: (...args: unknown[]) => queryRows(...args),
  query: vi.fn(),
}));

const { claimFootageForExpiry, releaseFootageClaim, listVideosWithUnreachableFootage, STALE_FOOTAGE_CLAIM_SECONDS } =
  await import('../src/db/repositories/videos.js');

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
    expect(params).toEqual(['v1', String(STALE_FOOTAGE_CLAIM_SECONDS)]);
  });

  it('takes over an abandoned claim — keys never cleared, older than an hour — whoever decided the removal', async () => {
    queryOne.mockResolvedValueOnce({ footage_expired_at: new Date() });

    await claimFootageForExpiry('v1', { onlyIfUnowned: true });

    const [sql] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/footage_expired_at IS NOT NULL\s+AND original_storage_key IS NOT NULL\s+AND footage_expired_at < now\(\) - \(\$2 \|\| ' seconds'\)::interval/);
    // The guest-only rule binds a fresh claim only; the abandoned branch has no ownership condition.
    expect(sql).toMatch(/\(footage_expired_at IS NULL AND user_id IS NULL\)/);
    expect(STALE_FOOTAGE_CLAIM_SECONDS).toBe(3600);
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

describe('listVideosWithUnreachableFootage', () => {
  it('selects quiet guest footage as before, and any removal that was decided and never finished', async () => {
    queryRows.mockResolvedValueOnce([{ id: 'v1', session_id: 's1' }]);

    const videos = await listVideosWithUnreachableFootage(86_400, 50);

    expect(videos).toEqual([{ videoId: 'v1', sessionId: 's1' }]);
    const [sql, params] = queryRows.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/v\.footage_expired_at IS NULL\s+(--[^\n]*\n\s*)*AND v\.user_id IS NULL/);
    expect(sql).toMatch(/v\.footage_expired_at IS NOT NULL\s+AND v\.original_storage_key IS NOT NULL\s+AND v\.footage_expired_at < now\(\) - \(\$3 \|\| ' seconds'\)::interval/);
    expect(params).toEqual(['86400', 50, String(STALE_FOOTAGE_CLAIM_SECONDS)]);
  });
});
