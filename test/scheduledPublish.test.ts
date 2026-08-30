import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A scheduled publish is a promise with a record. These tests hold the
 * worker to the promise's rules: only a claimable row fires; every outcome
 * — kept, or failed with a reason a person can read — lands back on the
 * row; and a failure never escapes the handler, because this queue runs
 * single-attempt and a blind retry could double-post to a real audience.
 */

const rows = {
  claimScheduledPost: vi.fn(),
  markScheduledPostFired: vi.fn(),
  markScheduledPostFailed: vi.fn(),
};
const executeClipPublish = vi.fn();
const zernioConfigured = vi.fn();

vi.mock('../src/db/repositories/scheduledPosts.js', () => ({
  claimScheduledPost: rows.claimScheduledPost,
  markScheduledPostFired: rows.markScheduledPostFired,
  markScheduledPostFailed: rows.markScheduledPostFailed,
}));
vi.mock('../src/services/social/publishClip.js', () => ({ executeClipPublish }));
vi.mock('../src/services/zernio/client.js', () => ({ zernioConfigured }));

const { handleScheduledPublish } = await import('../src/worker/handlers/scheduledPublish.js');

const claimedRow = {
  id: 'sched-1',
  user_id: 'user-1',
  workspace_id: 'ws-1',
  clip_id: 'clip-1',
  caption: 'the reveal',
  account_ids: ['acct-1', 'acct-2'],
  scheduled_at: new Date('2026-08-31T18:00:00Z'),
  status: 'firing' as const,
  error: null,
  created_at: new Date(),
  claimed_at: new Date(),
  fired_at: null,
};

function job() {
  return { data: { scheduledPostId: 'sched-1' } } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  zernioConfigured.mockReturnValue(true);
  rows.markScheduledPostFired.mockResolvedValue(undefined);
  rows.markScheduledPostFailed.mockResolvedValue(undefined);
});

describe('handleScheduledPublish', () => {
  it('does nothing when the row cannot be claimed (canceled, fired, or held elsewhere)', async () => {
    rows.claimScheduledPost.mockResolvedValue(null);
    await handleScheduledPublish(job());
    expect(executeClipPublish).not.toHaveBeenCalled();
    expect(rows.markScheduledPostFired).not.toHaveBeenCalled();
    expect(rows.markScheduledPostFailed).not.toHaveBeenCalled();
  });

  it('runs the same publish act as an immediate publish and marks the promise kept', async () => {
    rows.claimScheduledPost.mockResolvedValue(claimedRow);
    executeClipPublish.mockResolvedValue([{ id: 'post-1' }]);

    await handleScheduledPublish(job());

    expect(executeClipPublish).toHaveBeenCalledWith({
      userId: 'user-1',
      workspaceId: 'ws-1',
      clipId: 'clip-1',
      caption: 'the reveal',
      accountIds: ['acct-1', 'acct-2'],
    });
    expect(rows.markScheduledPostFired).toHaveBeenCalledWith('sched-1');
    expect(rows.markScheduledPostFailed).not.toHaveBeenCalled();
  });

  it('an empty account selection at scheduling time means "all connected" at fire time', async () => {
    rows.claimScheduledPost.mockResolvedValue({ ...claimedRow, account_ids: [] });
    executeClipPublish.mockResolvedValue([]);

    await handleScheduledPublish(job());

    expect(executeClipPublish).toHaveBeenCalledWith(expect.objectContaining({ accountIds: null }));
  });

  it('records a publish failure on the row, in its own words, and does not throw', async () => {
    rows.claimScheduledPost.mockResolvedValue(claimedRow);
    executeClipPublish.mockRejectedValue(new Error('No connected accounts. Connect one on the Publishing page first.'));

    await expect(handleScheduledPublish(job())).resolves.toBeUndefined();

    expect(rows.markScheduledPostFailed).toHaveBeenCalledWith(
      'sched-1',
      'No connected accounts. Connect one on the Publishing page first.',
    );
    expect(rows.markScheduledPostFired).not.toHaveBeenCalled();
  });

  it('fails the promise plainly when publishing is not configured, without calling out', async () => {
    rows.claimScheduledPost.mockResolvedValue(claimedRow);
    zernioConfigured.mockReturnValue(false);

    await handleScheduledPublish(job());

    expect(executeClipPublish).not.toHaveBeenCalled();
    expect(rows.markScheduledPostFailed).toHaveBeenCalledWith(
      'sched-1',
      'Publishing is not configured on this deployment.',
    );
  });
});
