import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Signing in must not cost you what you just made.
 *
 * Someone can use CLIPIT signed out: upload a video, ask for a moment, cut a
 * clip. Publishing is where they are asked to sign in — and until this, that
 * sign-in minted a fresh session and left everything behind on the guest one.
 * Asking for an email address at the exact moment you take away the work
 * someone did to get there is the worst possible trade.
 */

const queryRows = vi.fn();

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(),
  queryRows: (...args: unknown[]) => queryRows(...args),
}));

const { adoptSessionWork } = await import('../src/db/repositories/sessions.js');

describe('adoptSessionWork', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryRows.mockResolvedValue([]);
  });

  it('claims every table a guest can own work in', async () => {
    await adoptSessionWork({ sessionId: 's1', userId: 'u1', workspaceId: 'w1' });

    const tables = queryRows.mock.calls.map((call) => String(call[0]));
    expect(tables.some((sql) => /UPDATE videos/.test(sql))).toBe(true);
    expect(tables.some((sql) => /UPDATE clip_requests/.test(sql))).toBe(true);
    expect(tables.some((sql) => /UPDATE clips\b/.test(sql))).toBe(true);
  });

  it('stamps the workspace as well as the user', async () => {
    await adoptSessionWork({ sessionId: 's1', userId: 'u1', workspaceId: 'w1' });

    for (const call of queryRows.mock.calls) {
      // A row with a user but a null workspace is invisible to every
      // workspace-scoped read — adopted and then unfindable is not adopted.
      expect(String(call[0])).toMatch(/workspace_id = \$3/);
      expect(call[1]).toEqual(['s1', 'u1', 'w1']);
    }
  });

  it('never takes a row that already belongs to somebody', async () => {
    await adoptSessionWork({ sessionId: 's1', userId: 'u1', workspaceId: 'w1' });

    for (const call of queryRows.mock.calls) {
      expect(String(call[0])).toMatch(/user_id IS NULL/);
    }
  });

  it('scopes strictly to the session presented', async () => {
    await adoptSessionWork({ sessionId: 's1', userId: 'u1', workspaceId: 'w1' });

    for (const call of queryRows.mock.calls) {
      expect(String(call[0])).toMatch(/session_id = \$1/);
    }
  });

  it('reports what it actually carried', async () => {
    queryRows
      .mockResolvedValueOnce([{ id: 'v1' }])
      .mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }])
      .mockResolvedValueOnce([{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]);

    const carried = await adoptSessionWork({ sessionId: 's1', userId: 'u1', workspaceId: 'w1' });
    expect(carried).toEqual({ videos: 1, clipRequests: 2, clips: 3 });
  });

  it('claims the video before the things that hang off it', async () => {
    await adoptSessionWork({ sessionId: 's1', userId: 'u1', workspaceId: 'w1' });

    // Interrupted part-way, work that is visible should have a visible source.
    const order = queryRows.mock.calls.map((call) =>
      /UPDATE videos/.test(String(call[0])) ? 'videos' : /clip_requests/.test(String(call[0])) ? 'requests' : 'clips',
    );
    expect(order[0]).toBe('videos');
  });
});
