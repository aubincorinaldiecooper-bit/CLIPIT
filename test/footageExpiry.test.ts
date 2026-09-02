import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sweep selects an idle guest's video, then deletes its objects one by
 * one. If the guest signs in between the two, the video is an account's and
 * its footage must stay. Removal therefore starts with a claim that also
 * checks the video is still unowned, and deletes nothing without it.
 */

const videos = {
  claimFootageForExpiry: vi.fn(),
  releaseFootageClaim: vi.fn(),
  getVideo: vi.fn(),
  listChunks: vi.fn(),
  markFootageExpired: vi.fn(),
};
const remove = vi.fn();
const clears = {
  clearThumbnailsForVideo: vi.fn(),
  clearClipKeysForVideo: vi.fn(),
  clearVariantsForVideo: vi.fn(),
  deleteScenes: vi.fn(),
  deleteTranscript: vi.fn(),
};
const order: string[] = [];
const claimedAt = new Date('2026-09-02T20:30:00Z');

vi.mock('../src/db/repositories/videos.js', () => ({
  claimFootageForExpiry: (...args: unknown[]) => {
    order.push('claim');
    return videos.claimFootageForExpiry(...args);
  },
  releaseFootageClaim: (...args: unknown[]) => videos.releaseFootageClaim(...args),
  getVideo: (...args: unknown[]) => videos.getVideo(...args),
  listChunks: (...args: unknown[]) => videos.listChunks(...args),
  markFootageExpired: (...args: unknown[]) => videos.markFootageExpired(...args),
}));
vi.mock('../src/db/repositories/clipRequests.js', () => ({
  clearThumbnailsForVideo: (...args: unknown[]) => clears.clearThumbnailsForVideo(...args),
  listThumbnailKeysForVideo: vi.fn(async () => ['stills/1.jpg']),
}));
vi.mock('../src/db/repositories/clips.js', () => ({
  clearClipKeysForVideo: (...args: unknown[]) => clears.clearClipKeysForVideo(...args),
  listClipKeysForVideo: vi.fn(async () => ['clips/1.mp4']),
}));
vi.mock('../src/db/repositories/clipVariants.js', () => ({
  clearVariantsForVideo: (...args: unknown[]) => clears.clearVariantsForVideo(...args),
  listVariantKeysForVideo: vi.fn(async () => []),
}));
vi.mock('../src/db/repositories/scenes.js', () => ({ deleteScenes: (...args: unknown[]) => clears.deleteScenes(...args) }));
vi.mock('../src/db/repositories/transcripts.js', () => ({
  deleteTranscript: (...args: unknown[]) => clears.deleteTranscript(...args),
}));
vi.mock('../src/services/storage/s3.js', () => ({
  getStorage: () => ({
    remove: (...args: unknown[]) => {
      order.push('remove');
      return remove(...args);
    },
  }),
}));

const { expireVideoFootage } = await import('../src/services/retention.js');
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

beforeEach(() => {
  vi.clearAllMocks();
  order.length = 0;
  videos.getVideo.mockResolvedValue({
    id: 'v1',
    footageExpiredAt: null,
    originalStorageKey: 'videos/v1/original.mp4',
    proxyStorageKey: null,
    playbackStorageKey: null,
    captionsStorageKey: null,
  });
  videos.listChunks.mockResolvedValue([]);
  remove.mockResolvedValue(undefined);
  for (const clear of Object.values(clears)) clear.mockResolvedValue(undefined);
  videos.markFootageExpired.mockResolvedValue(undefined);
  videos.releaseFootageClaim.mockResolvedValue(undefined);
});

describe('expireVideoFootage', () => {
  it('claims the video — still a guest’s, for the sweep — before any object is removed', async () => {
    videos.claimFootageForExpiry.mockResolvedValueOnce(claimedAt);

    const result = await expireVideoFootage('v1', log, { onlyIfUnowned: true });

    expect(order[0]).toBe('claim');
    expect(videos.claimFootageForExpiry).toHaveBeenCalledWith('v1', { onlyIfUnowned: true });
    // The original, one clip, one still.
    expect(order.filter((step) => step === 'remove')).toHaveLength(3);
    expect(result).toEqual({ outcome: 'removed', objectsDeleted: 3, objectsFailed: 0 });
    expect(videos.markFootageExpired).toHaveBeenCalledWith('v1');
  });

  it('lets an owner remove their own video whoever it belonged to before', async () => {
    videos.claimFootageForExpiry.mockResolvedValueOnce(claimedAt);

    await expireVideoFootage('v1', log, { onlyIfUnowned: false });

    expect(videos.claimFootageForExpiry).toHaveBeenCalledWith('v1', { onlyIfUnowned: false });
    expect(remove).toHaveBeenCalledTimes(3);
  });

  it('gives the claim back and rethrows when the removal fails after it, so the next sweep tries again', async () => {
    videos.claimFootageForExpiry.mockResolvedValueOnce(claimedAt);
    videos.listChunks.mockRejectedValueOnce(new Error('db down'));

    await expect(expireVideoFootage('v1', log, { onlyIfUnowned: true })).rejects.toThrow('db down');

    // This exact claim, no other.
    expect(videos.releaseFootageClaim).toHaveBeenCalledWith('v1', claimedAt);
    expect(videos.markFootageExpired).not.toHaveBeenCalled();
  });

  it('keeps the claim once the removal has finished', async () => {
    videos.claimFootageForExpiry.mockResolvedValueOnce(claimedAt);

    await expireVideoFootage('v1', log, { onlyIfUnowned: true });

    expect(videos.releaseFootageClaim).not.toHaveBeenCalled();
  });

  it('says so when the video was removed before this request came, and deletes nothing', async () => {
    videos.claimFootageForExpiry.mockResolvedValueOnce(null);
    videos.getVideo.mockResolvedValueOnce({ id: 'v1', footageExpiredAt: new Date(), footageClaimedAt: null });

    const result = await expireVideoFootage('v1', log, { onlyIfUnowned: false });

    expect(result).toEqual({ outcome: 'already-removed', objectsDeleted: 0, objectsFailed: 0 });
    expect(remove).not.toHaveBeenCalled();
  });

  it('says so when another removal holds the claim right now — it may yet fail and give it back', async () => {
    videos.claimFootageForExpiry.mockResolvedValueOnce(null);
    videos.getVideo.mockResolvedValueOnce({ id: 'v1', footageExpiredAt: null, footageClaimedAt: new Date() });

    const result = await expireVideoFootage('v1', log, { onlyIfUnowned: false });

    expect(result).toEqual({ outcome: 'in-progress', objectsDeleted: 0, objectsFailed: 0 });
    expect(remove).not.toHaveBeenCalled();
  });

  it('deletes and clears nothing when the claim finds no row — adopted since it was selected', async () => {
    videos.claimFootageForExpiry.mockResolvedValueOnce(null);
    videos.getVideo.mockResolvedValueOnce({ id: 'v1', footageExpiredAt: null, footageClaimedAt: null });

    const result = await expireVideoFootage('v1', log, { onlyIfUnowned: true });

    expect(result).toEqual({ outcome: 'refused', objectsDeleted: 0, objectsFailed: 0 });
    expect(remove).not.toHaveBeenCalled();
    for (const clear of Object.values(clears)) expect(clear).not.toHaveBeenCalled();
    expect(videos.markFootageExpired).not.toHaveBeenCalled();
  });
});
