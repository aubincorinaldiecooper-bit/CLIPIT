import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The truth behind the Publish button: a post is "posted" only on the
 * platform's own word, never on CLIPIT's acceptance of it — the button says
 * Published only then, and "Sent" until then.
 */

const queryRows = vi.fn();
vi.mock('../src/db/pool.js', () => ({
  queryOne: vi.fn(),
  queryRows: (...args: unknown[]) => queryRows(...args),
}));

const { postOutcome, serializeClipPost, targetsOfPost } = await import('../src/services/social/postOutcome.js');
const { listRecentPostsForClip } = await import('../src/db/repositories/social.js');

beforeEach(() => queryRows.mockReset());

describe('postOutcome — the status word, read for a person', () => {
  it('is "posting" for everything on its way, CLIPIT\'s own words included', () => {
    for (const word of ['submitting', 'rendering', 'submitted', 'pending', 'processing', 'queued', 'scheduled', 'in_progress']) {
      expect(postOutcome(word)).toBe('posting');
    }
  });

  it('is "posted" only on the platform\'s word that it is up', () => {
    for (const word of ['published', 'Published', ' posted ', 'success', 'completed', 'live']) expect(postOutcome(word)).toBe('posted');
  });

  it('is "failed" on a refusal, however the provider spells it', () => {
    for (const word of ['failed', 'error', 'rejected', 'cancelled', 'expired']) expect(postOutcome(word)).toBe('failed');
  });

  it('never says "posted" of a word it does not know', () => {
    expect(postOutcome('something_new')).toBe('posting');
    expect(postOutcome('')).toBe('posting');
  });
});

describe('serializeClipPost — what the client reads', () => {
  it('carries the word, its reading, the targets and the time', () => {
    const view = serializeClipPost({
      id: 'post-1',
      clip_id: 'clip-1',
      status: 'published',
      targets: [{ platform: 'tiktok', accountId: 'acc-1', status: 'ok' }],
      created_at: new Date('2026-09-02T18:00:00Z'),
    });
    expect(view).toEqual({
      id: 'post-1',
      clipId: 'clip-1',
      status: 'published',
      outcome: 'posted',
      targets: [{ platform: 'tiktok', accountId: 'acc-1' }],
      createdAt: '2026-09-02T18:00:00.000Z',
    });
  });

  it('drops targets it cannot read rather than guessing at them', () => {
    expect(targetsOfPost('not a list')).toEqual([]);
    expect(targetsOfPost([{ platform: 'x' }])).toEqual([]);
    expect(targetsOfPost(null)).toEqual([]);
  });
});

describe('listRecentPostsForClip', () => {
  it('reads a clip\'s posts newest first, bounded', async () => {
    queryRows.mockResolvedValue([]);
    await listRecentPostsForClip('clip-1');
    const [sql, params] = queryRows.mock.calls[0]!;
    expect(sql).toContain('FROM published_posts WHERE clip_id = $1');
    expect(sql).toContain('ORDER BY created_at DESC LIMIT $2');
    expect(params).toEqual(['clip-1', 20]);
  });
});
