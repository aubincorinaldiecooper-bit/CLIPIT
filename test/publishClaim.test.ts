import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientQuery = vi.fn();
const withTransaction = vi.fn(async (fn: (client: { query: typeof clientQuery }) => Promise<unknown>) =>
  fn({ query: clientQuery }),
);

vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(),
  queryRows: vi.fn(),
  withTransaction,
}));

const { claimPublishedPost } = await import('../src/db/repositories/social.js');

const input = {
  userId: 'user-1',
  workspaceId: 'workspace-1',
  clipId: 'clip-1',
  zernioPostId: null,
  caption: 'hello',
  targets: [{ platform: 'youtube', accountId: 'account-1' }],
  status: 'submitting',
  variantId: null,
};

beforeEach(() => vi.clearAllMocks());

describe('claimPublishedPost', () => {
  it('locks the user and clip before checking and creating the first group', async () => {
    const created = { id: 'post-1' };
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [created] });

    await expect(claimPublishedPost(input, 120)).resolves.toBe(created);

    expect(clientQuery).toHaveBeenCalledTimes(3);
    expect(clientQuery.mock.calls[0]?.[0]).toContain('pg_advisory_xact_lock');
    expect(clientQuery.mock.calls[1]?.[0]).toContain("status IN ('submitting', 'rendering')");
    expect(clientQuery.mock.calls[2]?.[0]).toContain('INSERT INTO published_posts');
    expect(clientQuery.mock.calls[0]?.[1]).toEqual(['user-1:clip-1']);
  });

  it('does not insert when the serialized check finds another active attempt', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'other-post' }] });

    await expect(claimPublishedPost(input, 120)).resolves.toBeNull();

    expect(clientQuery).toHaveBeenCalledTimes(2);
  });
});
