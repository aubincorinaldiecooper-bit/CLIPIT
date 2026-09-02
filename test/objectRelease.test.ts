import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Objects a render's row stopped naming are removed LATER, by the retention
 * queue, once no signed URL to them can still be live — a publisher handed a
 * link to a shaped copy just before a re-render must still be able to
 * download it. Devin's finding on #80.
 */

const remove = vi.fn();
vi.mock('../src/services/storage/s3.js', () => ({ getStorage: () => ({ remove }) }));
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
vi.mock('../src/lib/logger.js', () => ({ logger: { ...log, child: () => log } }));
vi.mock('../src/db/repositories/verticalMedia.js', () => ({ claimUnkeptPreRenderedMedia: vi.fn() }));
vi.mock('../src/db/repositories/videos.js', () => ({ listVideosWithUnreachableFootage: vi.fn(async () => []) }));
vi.mock('../src/services/retention.js', () => ({ expireVideoFootage: vi.fn() }));

const { handleRetention } = await import('../src/worker/handlers/retention.js');

const context = { videoId: 'video-1', clipId: 'clip-1', reason: 'superseded_by_rerender' };
const job = (data: Record<string, unknown>) => ({ id: 'job-1', data } as never);

beforeEach(() => {
  for (const mock of [remove, ...Object.values(log)]) mock.mockReset();
  remove.mockResolvedValue(undefined);
});

describe('releasing objects a row no longer names', () => {
  it('removes every key when its turn comes', async () => {
    await handleRetention(job({ kind: 'release', keys: ['clips/video-1/clip-1.mp4', 'posters/video-1/clip-1.jpg'], context }));

    expect(remove).toHaveBeenCalledWith('clips/video-1/clip-1.mp4');
    expect(remove).toHaveBeenCalledWith('posters/video-1/clip-1.jpg');
    expect(log.info).toHaveBeenCalledWith('released objects removed', expect.objectContaining({ removed: 2, failed: 0 }));
  });

  it('keeps going past a key that will not go, names it, and fails the job so the queue tries again', async () => {
    remove.mockImplementation(async (key: string) => {
      if (key.endsWith('.jpg')) throw new Error('bucket refused');
    });

    await expect(
      handleRetention(job({ kind: 'release', keys: ['posters/video-1/clip-1.jpg', 'clips/video-1/clip-1.mp4'], context })),
    ).rejects.toThrow('1 of 2');

    expect(remove).toHaveBeenCalledWith('clips/video-1/clip-1.mp4');
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('could not be removed'),
      expect.objectContaining({ key: 'posters/video-1/clip-1.jpg', clipId: 'clip-1' }),
    );
  });

  it('is not the footage sweep: a sweep job still sweeps', async () => {
    await handleRetention(job({ requestedAt: '2026-09-02T15:00:00Z' }));
    expect(remove).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith('no footage to remove');
  });
});
