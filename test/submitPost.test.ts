import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a failed publish is allowed to claim.
 *
 * Three outcomes, and the difference between them is the difference between
 * "we tried and it refused", "we never tried", and "we do not know". Getting
 * the third one wrong is the worst: if an accepted post whose response was
 * lost is recorded as failed, the retry guard lets it through and someone's
 * audience sees the same clip twice.
 */

const updates: Array<{ id: string; status: string }> = [];
const createDownloadUrl = vi.fn();
const createPost = vi.fn();

class FakeZernioApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ZernioApiError';
  }
}

vi.mock('../src/services/storage/s3.js', () => ({
  getStorage: () => ({ createDownloadUrl }),
}));

vi.mock('../src/services/zernio/client.js', () => ({
  zernio: { createPost: (...args: unknown[]) => createPost(...args) },
  ZernioApiError: FakeZernioApiError,
}));

vi.mock('../src/db/repositories/social.js', () => ({
  updatePublishedPost: async (id: string, input: { status: string }) => {
    updates.push({ id, status: input.status });
    return { id, status: input.status };
  },
}));

const { submitRecordedPost } = await import('../src/services/social/submitPost.js');

const input = {
  postId: 'post-1',
  caption: 'hello',
  targets: [{ platform: 'tiktok', accountId: 'a' }],
  storageKey: 'clips/v/c/9x16-50.mp4',
};

describe('submitRecordedPost', () => {
  beforeEach(() => {
    updates.length = 0;
    createDownloadUrl.mockReset();
    createPost.mockReset();
  });

  it('records the post as submitted when the service accepts it', async () => {
    createDownloadUrl.mockResolvedValue('https://signed.example/clip.mp4');
    createPost.mockResolvedValue({ id: 'z-1', status: 'submitted' });

    const result = await submitRecordedPost(input);

    expect(result.status).toBe('submitted');
    expect(updates.at(-1)).toEqual({ id: 'post-1', status: 'submitted' });
  });

  it('fails a post that never reached the service', async () => {
    // No URL, so nothing was sent — definite, and the render job that called
    // this completes either way, so this is the only chance to say so.
    // Leaving it 'rendering' would be endless progress for work never begun.
    createDownloadUrl.mockRejectedValue(new Error('no credentials'));

    await expect(submitRecordedPost(input)).rejects.toThrow('no credentials');
    expect(updates).toEqual([{ id: 'post-1', status: 'failed' }]);
    expect(createPost).not.toHaveBeenCalled();
  });

  it('fails a post the service definitely refused', async () => {
    createDownloadUrl.mockResolvedValue('https://signed.example/clip.mp4');
    createPost.mockRejectedValue(new FakeZernioApiError('bad request', 400));

    await expect(submitRecordedPost(input)).rejects.toThrow('bad request');
    expect(updates).toEqual([{ id: 'post-1', status: 'failed' }]);
  });

  it('leaves an ambiguous submission alone rather than inviting a duplicate', async () => {
    // The request went out and the answer did not come back. The service may
    // have posted it. Marking this failed would let the retry guard pass and
    // put the same clip in front of someone's audience twice.
    createDownloadUrl.mockResolvedValue('https://signed.example/clip.mp4');
    createPost.mockRejectedValue(new Error('socket hang up'));

    await expect(submitRecordedPost(input)).rejects.toThrow('socket hang up');
    expect(updates).toEqual([]);
  });
});
