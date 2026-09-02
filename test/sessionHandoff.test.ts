import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sign-in link opens wherever the email is read — a new tab, a phone —
 * and the guest token that names the work stays behind in the tab that made
 * it. A hand-over carries that claim in the link itself. It must be worth
 * nothing to a database reader, usable once, and dead within the hour.
 */

const queryOne = vi.fn();

vi.mock('../src/db/pool.js', () => ({
  queryOne: (...args: unknown[]) => queryOne(...args),
  queryRows: vi.fn(),
}));

const { createHandoff, redeemHandoff, HANDOFF_TTL_SECONDS } = await import(
  '../src/db/repositories/sessionHandoffs.js'
);
const { hashToken } = await import('../src/db/repositories/sessions.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createHandoff', () => {
  it('stores only the digest of the token it hands back, for the named session, with an hour to live', async () => {
    const expiresAt = new Date('2026-09-02T21:00:00Z');
    queryOne.mockResolvedValueOnce({ expires_at: expiresAt });

    const handoff = await createHandoff('guest-session');

    expect(handoff.token.length).toBeGreaterThanOrEqual(40);
    expect(handoff.expiresAt).toBe(expiresAt);
    const [sql, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO session_handoffs/);
    expect(params[0]).toBe(hashToken(handoff.token));
    expect(params[0]).not.toBe(handoff.token);
    expect(params[1]).toBe('guest-session');
    expect(params[2]).toBe(String(HANDOFF_TTL_SECONDS));
    expect(HANDOFF_TTL_SECONDS).toBe(3600);
  });

  it('hands out a different token every time', async () => {
    queryOne.mockResolvedValue({ expires_at: new Date() });
    const a = await createHandoff('s');
    const b = await createHandoff('s');
    expect(a.token).not.toBe(b.token);
  });
});

describe('redeemHandoff', () => {
  it('marks the row used in the same statement that finds it, and only a live, unused one', async () => {
    queryOne.mockResolvedValueOnce({ session_id: 'guest-session', user_id: null });

    const redeemed = await redeemHandoff('the-token');

    expect(redeemed).toEqual({ sessionId: 'guest-session', userId: null });
    const [sql, params] = queryOne.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE session_handoffs/);
    expect(sql).toMatch(/SET redeemed_at = now\(\)/);
    expect(sql).toMatch(/redeemed_at IS NULL/);
    expect(sql).toMatch(/expires_at > now\(\)/);
    expect(params).toEqual([hashToken('the-token')]);
  });

  it('reports the named session’s owner, so a session that already belongs to somebody is never adopted', async () => {
    queryOne.mockResolvedValueOnce({ session_id: 'owned-session', user_id: 'user-1' });
    expect(await redeemHandoff('t')).toEqual({ sessionId: 'owned-session', userId: 'user-1' });
  });

  it('answers null for a token that is unknown, expired, or already used', async () => {
    queryOne.mockResolvedValueOnce(null);
    expect(await redeemHandoff('stale')).toBeNull();
  });
});
