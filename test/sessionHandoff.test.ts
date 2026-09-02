import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sign-in link opens wherever the email is read — a new tab, a phone —
 * and the guest token that names the work stays behind in the tab that made
 * it. A hand-over carries that claim in the link itself. It must be worth
 * nothing to a database reader, answer one address only, be usable once,
 * be dead within the hour, and never pile up.
 */

const query = vi.fn();
const client = { query: vi.fn() };
const withTransaction = vi.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(client));

vi.mock('../src/db/pool.js', () => ({
  query: (...args: unknown[]) => query(...args),
  queryOne: vi.fn(),
  queryRows: vi.fn(),
  withTransaction: (fn: (c: unknown) => Promise<unknown>) => withTransaction(fn),
}));

const { createHandoff, redeemHandoff, hashEmail, HANDOFF_TTL_SECONDS, LIVE_HANDOFFS_PER_SESSION } = await import(
  '../src/db/repositories/sessionHandoffs.js'
);
const { hashToken } = await import('../src/db/repositories/sessions.js');

const expiresAt = new Date('2026-09-02T21:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [] });
  // The lock and the prune answer nothing; the insert answers its row.
  client.query.mockImplementation(async (sql: string) =>
    /INSERT INTO session_handoffs/.test(sql) ? { rows: [{ expires_at: expiresAt }] } : { rows: [] },
  );
});

/** The statements run on the transaction's client, in order. */
function onClient(): [string, unknown[]][] {
  return client.query.mock.calls.map((call) => [String(call[0]), call[1] as unknown[]]);
}

describe('createHandoff', () => {
  it('stores only digests — of the token it hands back and of the address the link goes to — for the named session, with an hour to live', async () => {
    const handoff = await createHandoff('guest-session', '  Person@Example.COM ');

    expect(handoff.token.length).toBeGreaterThanOrEqual(40);
    expect(handoff.expiresAt).toBe(expiresAt);
    const insert = onClient().find(([sql]) => /INSERT INTO session_handoffs/.test(sql));
    expect(insert).toBeDefined();
    const params = insert![1];
    expect(params[0]).toBe(hashToken(handoff.token));
    expect(params[0]).not.toBe(handoff.token);
    expect(params[1]).toBe(hashEmail('person@example.com'));
    expect(String(params[1])).not.toContain('example');
    expect(params[2]).toBe('guest-session');
    expect(params[3]).toBe(String(HANDOFF_TTL_SECONDS));
    expect(HANDOFF_TTL_SECONDS).toBe(3600);
  });

  it('sweeps expired claims on an ordinary connection, then holds the guest’s session row while keeping its newest few and adding this one', async () => {
    await createHandoff('guest-session', 'a@b.c');

    // The sweep: on the pool, before any connection is held for the transaction.
    expect(String(query.mock.calls[0]![0])).toMatch(/DELETE FROM session_handoffs WHERE expires_at <= now\(\)/);
    expect(withTransaction).toHaveBeenCalledTimes(1);

    // Inside, in order: the lock, the prune, the insert — all on the one client.
    const statements = onClient();
    expect(statements[0]![0]).toMatch(/SELECT id FROM sessions WHERE id = \$1 FOR UPDATE/);
    expect(statements[0]![1]).toEqual(['guest-session']);
    expect(statements[1]![0]).toMatch(/DELETE FROM session_handoffs/);
    expect(statements[1]![0]).toMatch(/redeemed_at IS NULL/);
    expect(statements[1]![0]).toMatch(/ORDER BY created_at DESC/);
    expect(statements[1]![1]).toEqual(['guest-session', LIVE_HANDOFFS_PER_SESSION - 1]);
    expect(statements[2]![0]).toMatch(/INSERT INTO session_handoffs/);
    expect(LIVE_HANDOFFS_PER_SESSION).toBeGreaterThan(1);
  });

  it('hands out a different token every time', async () => {
    const a = await createHandoff('s', 'a@b.c');
    const b = await createHandoff('s', 'a@b.c');
    expect(a.token).not.toBe(b.token);
  });
});

describe('redeemHandoff', () => {
  beforeEach(() => {
    client.query.mockReset();
  });

  it('marks the row used on the caller’s transaction, in the statement that finds it, for the address it was sent to, only while live and unused', async () => {
    client.query.mockResolvedValueOnce({ rows: [{ session_id: 'guest-session', user_id: null }] });

    const redeemed = await redeemHandoff('the-token', 'Person@Example.com', client as never);

    expect(redeemed).toEqual({ sessionId: 'guest-session', userId: null });
    expect(query).not.toHaveBeenCalled();
    const [sql, params] = client.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/UPDATE session_handoffs/);
    expect(sql).toMatch(/SET redeemed_at = now\(\)/);
    expect(sql).toMatch(/h\.email_hash = \$2/);
    expect(sql).toMatch(/redeemed_at IS NULL/);
    expect(sql).toMatch(/expires_at > now\(\)/);
    expect(params).toEqual([hashToken('the-token'), hashEmail('person@example.com')]);
  });

  it('reports the named session’s owner, so a session that already belongs to somebody is never adopted', async () => {
    client.query.mockResolvedValueOnce({ rows: [{ session_id: 'owned-session', user_id: 'user-1' }] });
    expect(await redeemHandoff('t', 'a@b.c', client as never)).toEqual({ sessionId: 'owned-session', userId: 'user-1' });
  });

  it('answers null for a token that is unknown, expired, already used, or sent to another address', async () => {
    client.query.mockResolvedValueOnce({ rows: [] });
    expect(await redeemHandoff('stale', 'a@b.c', client as never)).toBeNull();
  });
});
