import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
const queryRows = vi.fn();
vi.mock('../src/db/pool.js', () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
  queryRows: (...args: unknown[]) => queryRows(...args),
  query: vi.fn(),
}));

const {
  claimFootageForExpiry,
  releaseFootageClaim,
  markFootageExpired,
  listVideosWithUnreachableFootage,
  STALE_FOOTAGE_CLAIM_SECONDS,
} = await import('../src/db/repositories/videos.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('claimFootageForExpiry', () => {
  it('for the sweep, claims only a video that is unowned, not removed, and not being removed — in one statement — and hands back the claim’s own time', async () => {
    const claimedAt = new Date('2026-09-02T20:30:00Z');
    queryOne.mockResolvedValueOnce({ footage_claimed_at: claimedAt });

    expect(await claimFootageForExpiry('v1', { onlyIfUnowned: true })).toBe(claimedAt);
    const [sql, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE videos/);
    expect(sql).toMatch(/SET footage_claimed_at = now\(\)/);
    expect(sql).toMatch(/footage_expired_at IS NULL/);
    expect(sql).toMatch(/\(footage_claimed_at IS NULL AND user_id IS NULL\)/);
    expect(sql).toMatch(/RETURNING footage_claimed_at/);
    expect(sql).not.toMatch(/SET footage_expired_at/);
    expect(params).toEqual(['v1', String(STALE_FOOTAGE_CLAIM_SECONDS)]);
  });

  it('takes over an abandoned claim — older than an hour, never completed — whoever decided the removal', async () => {
    queryOne.mockResolvedValueOnce({ footage_claimed_at: new Date() });

    await claimFootageForExpiry('v1', { onlyIfUnowned: true });

    const [sql] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/OR footage_claimed_at < now\(\) - \(\$2 \|\| ' seconds'\)::interval/);
    // No key is consulted: a video that never had a source file is taken over like any other.
    expect(sql).not.toMatch(/storage_key/);
    expect(STALE_FOOTAGE_CLAIM_SECONDS).toBe(3600);
  });

  it('for an owner’s own removal, does not ask whether the video is unowned', async () => {
    queryOne.mockResolvedValueOnce({ footage_claimed_at: new Date() });

    expect(await claimFootageForExpiry('v1', { onlyIfUnowned: false })).toBeInstanceOf(Date);
    const [sql] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/footage_expired_at IS NULL/);
    expect(sql).not.toMatch(/user_id IS NULL/);
  });

  it('refuses when the row is no longer a guest’s, already removed, or being removed', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect(await claimFootageForExpiry('v1', { onlyIfUnowned: true })).toBeNull();
  });
});

describe('releaseFootageClaim', () => {
  it('clears exactly the claim named, so a later sweep selects the video again and no other attempt is touched', async () => {
    const claimedAt = new Date('2026-09-02T20:30:00Z');
    queryOne.mockResolvedValueOnce(null);

    await releaseFootageClaim('v1', claimedAt);

    const [sql, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE videos/);
    expect(sql).toMatch(/SET footage_claimed_at = NULL/);
    expect(sql).toMatch(/footage_claimed_at = \$2/);
    expect(sql).not.toMatch(/footage_expired_at/);
    expect(params).toEqual(['v1', claimedAt]);
  });
});

describe('markFootageExpired', () => {
  it('records the completion and clears the claim in the same statement', async () => {
    queryOne.mockResolvedValueOnce(null);

    await markFootageExpired('v1');

    const [sql, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/SET footage_expired_at = now\(\)/);
    expect(sql).toMatch(/footage_claimed_at = NULL/);
    expect(params).toEqual(['v1']);
  });
});

describe('listVideosWithUnreachableFootage', () => {
  it('selects quiet guest footage as before, plus any removal begun and never finished — never a finished one', async () => {
    queryRows.mockResolvedValueOnce([{ id: 'v1', session_id: 's1' }]);

    const videos = await listVideosWithUnreachableFootage(86_400, 50);

    expect(videos).toEqual([{ videoId: 'v1', sessionId: 's1' }]);
    const [sql, params] = queryRows.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/WHERE v\.footage_expired_at IS NULL/);
    expect(sql).toMatch(/v\.footage_claimed_at IS NULL\s+(--[^\n]*\n\s*)*AND v\.user_id IS NULL/);
    expect(sql).toMatch(/OR v\.footage_claimed_at < now\(\) - \(\$3 \|\| ' seconds'\)::interval/);
    expect(sql).not.toMatch(/storage_key/);
    expect(params).toEqual(['86400', 50, String(STALE_FOOTAGE_CLAIM_SECONDS)]);
  });
});
