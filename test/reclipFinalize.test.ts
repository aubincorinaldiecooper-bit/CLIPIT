import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The rule Codex's review pinned down: a Re-clip against a rendered clip
 * becomes TRUE only when the replacement render succeeds. The version row
 * and the cleared pending state are written by the render's success; a
 * terminal render failure rolls the clip back to exactly its previous
 * boundaries and status and records the failure — never a version. And a
 * changed master always discards its platform variants, or a later publish
 * would post footage from the old cut.
 */

const clips = { getClip: vi.fn(), setClipStatus: vi.fn(), restoreClipBoundaries: vi.fn() };
const reclips = { appendReclipVersion: vi.fn(), clearReclipPending: vi.fn(), markReclipFailed: vi.fn() };
const discardVariants = vi.fn();
const getVideo = vi.fn();
const storage = { downloadToFile: vi.fn(), uploadFile: vi.fn(), remove: vi.fn() };
const commitRender = vi.fn(async () => true);
const media = { cutClip: vi.fn(), ffprobe: vi.fn() };

vi.mock('../src/db/repositories/clips.js', () => ({
  getClip: clips.getClip,
  setClipStatus: clips.setClipStatus,
  restoreClipBoundaries: clips.restoreClipBoundaries,
}));
vi.mock('../src/db/repositories/reclips.js', () => ({
  appendReclipVersion: reclips.appendReclipVersion,
  clearReclipPending: reclips.clearReclipPending,
  markReclipFailed: reclips.markReclipFailed,
}));
vi.mock('../src/db/repositories/clipVariants.js', () => ({ discardVariants }));
vi.mock('../src/db/repositories/verticalMedia.js', () => ({ commitRender }));
vi.mock('../src/db/pool.js', () => ({ withTransaction: (fn: (client: unknown) => Promise<unknown>) => fn({ query: vi.fn() }) }));
vi.mock('../src/queues/index.js', () => ({ enqueueObjectRelease: vi.fn(async () => undefined) }));
vi.mock('../src/db/repositories/videos.js', () => ({ getVideo }));
vi.mock('../src/services/storage/s3.js', () => ({ getStorage: () => storage }));
vi.mock('../src/services/media/ffmpeg.js', () => ({
  cutClip: media.cutClip,
  ffprobe: media.ffprobe,
}));
vi.mock('../src/lib/workdir.js', () => ({
  withWorkDir: (_name: string, fn: (dir: string) => Promise<void>) => fn('/tmp/clipit-test'),
}));

const { handleClipGeneration } = await import('../src/worker/handlers/clipGeneration.js');

const reclipPayload = {
  matchId: 'match-1',
  startSeconds: 128,
  endSeconds: 151,
  provider: 'modal',
  model: 'openbmb/MiniCPM-V-4.6',
  promptVersion: 'reclip-v1',
  previous: {
    startSeconds: 130,
    endSeconds: 150,
    boundariesEditedAt: null,
    status: 'ready' as const,
  },
};

function job(overrides: Partial<{ attemptsMade: number; attempts: number }> = {}) {
  return {
    data: { clipId: 'clip-1', reclip: reclipPayload },
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 1 },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  } as never;
}

beforeEach(() => {
  for (const mock of [
    ...Object.values(clips),
    ...Object.values(reclips),
    ...Object.values(storage),
    ...Object.values(media),
    discardVariants,
    getVideo,
  ]) {
    mock.mockReset();
  }
  clips.getClip.mockResolvedValue({
    id: 'clip-1',
    videoId: 'video-1',
    startSeconds: 128,
    endSeconds: 151,
    status: 'pending',
    storageKey: 'videos/video-1/clips/clip-1.mp4',
    captions: null,
  });
  clips.setClipStatus.mockResolvedValue(undefined);
  clips.restoreClipBoundaries.mockResolvedValue(undefined);
  reclips.appendReclipVersion.mockResolvedValue({ version: 2 });
  reclips.clearReclipPending.mockResolvedValue(undefined);
  reclips.markReclipFailed.mockResolvedValue(undefined);
  discardVariants.mockResolvedValue(undefined);
  getVideo.mockResolvedValue({
    id: 'video-1',
    originalStorageKey: 'videos/video-1/original.mp4',
    durationSeconds: 600,
    hasAudio: true,
  });
  storage.downloadToFile.mockResolvedValue(undefined);
  storage.uploadFile.mockResolvedValue(undefined);
  media.cutClip.mockResolvedValue({ sizeBytes: 500, durationSeconds: 23 });
  media.ffprobe.mockResolvedValue({ width: 640, height: 360 });
});

describe('a Re-clip render succeeding', () => {
  it('finalizes the version, clears pending, and discards stale variants — in that render, not before', async () => {
    await handleClipGeneration(job());

    // Inside the render's transaction: the client rides along.
    expect(discardVariants).toHaveBeenCalledWith('clip-1', expect.anything());
    expect(reclips.appendReclipVersion).toHaveBeenCalledWith({
      matchId: 'match-1',
      startSeconds: 128,
      endSeconds: 151,
      provider: 'modal',
      model: 'openbmb/MiniCPM-V-4.6',
      promptVersion: 'reclip-v1',
    }, expect.anything());
    expect(reclips.clearReclipPending).toHaveBeenCalledWith('match-1', expect.anything());
    expect(clips.restoreClipBoundaries).not.toHaveBeenCalled();
  });
});

describe('a Re-clip render failing terminally', () => {
  it('rolls the clip back to its previous boundaries and status and records the failure — no version', async () => {
    media.cutClip.mockRejectedValue(new Error('ffmpeg died'));

    await expect(handleClipGeneration(job())).rejects.toThrow('ffmpeg died');

    expect(clips.restoreClipBoundaries).toHaveBeenCalledWith('clip-1', {
      startSeconds: 130,
      endSeconds: 150,
      boundariesEditedAt: null,
      status: 'ready',
    });
    expect(reclips.markReclipFailed).toHaveBeenCalledWith('match-1', expect.stringContaining('untouched'));
    expect(reclips.appendReclipVersion).not.toHaveBeenCalled();
    expect(reclips.clearReclipPending).not.toHaveBeenCalled();
  });

  it('leaves the new boundaries in place on a NON-final attempt so the retry renders them', async () => {
    media.cutClip.mockRejectedValue(new Error('transient'));

    await expect(handleClipGeneration(job({ attemptsMade: 0, attempts: 3 }))).rejects.toThrow('transient');

    expect(clips.restoreClipBoundaries).not.toHaveBeenCalled();
    expect(reclips.markReclipFailed).not.toHaveBeenCalled();
  });
});
