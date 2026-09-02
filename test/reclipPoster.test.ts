import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Devin's finding on #78: a moment cut on find carries a poster taken from
 * its cut, and a re-render (a Re-clip's new boundaries, a caption Replace)
 * puts a different file under the same id. The card's picture must be a
 * frame of THAT file, so the render takes the poster again — for a moment
 * whose deliverable is the cut itself. A moment cut on demand never had a
 * poster; a vertical moment's poster comes from its derivative and is not
 * this render's to touch.
 */

const clips = { getClip: vi.fn(), setClipStatus: vi.fn(), restoreClipBoundaries: vi.fn() };
const reclips = { appendReclipVersion: vi.fn(), clearReclipPending: vi.fn(), markReclipFailed: vi.fn() };
const discardVariants = vi.fn();
const getVideo = vi.fn();
const storage = { downloadToFile: vi.fn(), uploadFile: vi.fn() };
const media = { cutClip: vi.fn(), ffprobe: vi.fn() };
const setPosterFromCut = vi.fn();
const runOriginalPipeline = vi.fn();
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

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
vi.mock('../src/db/repositories/videos.js', () => ({ getVideo }));
vi.mock('../src/db/repositories/verticalMedia.js', () => ({ setPosterFromCut }));
vi.mock('../src/services/media/verticalPipeline.js', () => ({ runOriginalPipeline }));
vi.mock('../src/services/storage/s3.js', () => ({ getStorage: () => storage }));
vi.mock('../src/services/media/ffmpeg.js', () => ({
  cutClip: media.cutClip,
  ffprobe: media.ffprobe,
}));
vi.mock('../src/lib/workdir.js', () => ({
  withWorkDir: (_name: string, fn: (dir: string) => Promise<void>) => fn('/tmp/clipit-test'),
}));
vi.mock('../src/lib/logger.js', () => ({
  logger: { ...log, child: () => log },
}));

const { handleClipGeneration } = await import('../src/worker/handlers/clipGeneration.js');

const reclipPayload = {
  matchId: 'match-1',
  startSeconds: 128,
  endSeconds: 151,
  provider: 'modal',
  model: 'openbmb/MiniCPM-V-4.6',
  promptVersion: 'reclip-v1',
  previous: { startSeconds: 130, endSeconds: 150, boundariesEditedAt: null, status: 'ready' as const },
};

function job(data: Record<string, unknown>) {
  return {
    data: { clipId: 'clip-1', ...data },
    attemptsMade: 0,
    opts: { attempts: 1 },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  } as never;
}

const cutOnFind = {
  id: 'clip-1',
  videoId: 'video-1',
  startSeconds: 128,
  endSeconds: 151,
  status: 'pending',
  storageKey: 'clips/video-1/clip-1.mp4',
  captions: null,
  preRendered: true,
  presentation: 'original',
  posterStorageKey: 'posters/video-1/clip-1.jpg',
};

beforeEach(() => {
  for (const mock of [
    ...Object.values(clips), ...Object.values(reclips), ...Object.values(storage), ...Object.values(media),
    ...Object.values(log), discardVariants, getVideo, setPosterFromCut, runOriginalPipeline,
  ]) {
    mock.mockReset();
  }
  clips.getClip.mockResolvedValue(cutOnFind);
  clips.setClipStatus.mockResolvedValue(undefined);
  reclips.appendReclipVersion.mockResolvedValue({ version: 2 });
  reclips.clearReclipPending.mockResolvedValue(undefined);
  discardVariants.mockResolvedValue(undefined);
  getVideo.mockResolvedValue({ id: 'video-1', originalStorageKey: 'videos/video-1/original.mp4', durationSeconds: 600, hasAudio: true });
  storage.downloadToFile.mockResolvedValue(undefined);
  storage.uploadFile.mockResolvedValue(undefined);
  media.cutClip.mockResolvedValue({ sizeBytes: 500, durationSeconds: 23, width: 1920, height: 1080 });
  media.ffprobe.mockResolvedValue({ width: 1920, height: 1080 });
  runOriginalPipeline.mockResolvedValue({
    posterStorageKey: 'posters/video-1/clip-1.jpg',
    posterTimestampSeconds: 5.75,
    posterGenerationMs: 40,
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceAspectRatio: '16:9',
  });
  setPosterFromCut.mockResolvedValue(undefined);
});

describe('a re-render of a moment cut on find', () => {
  it('takes the poster again from the new cut, over the same key, and still finalizes the Re-clip', async () => {
    await handleClipGeneration(job({ reclip: reclipPayload }));

    expect(runOriginalPipeline).toHaveBeenCalledWith(expect.objectContaining({
      videoId: 'video-1',
      clipId: 'clip-1',
      canonicalPath: '/tmp/clipit-test/clip-1.mp4',
      durationSeconds: 23,
      width: 1920,
      height: 1080,
      snapshotPosterKey: 'posters/video-1/clip-1.jpg',
    }));
    expect(setPosterFromCut).toHaveBeenCalledWith('clip-1', {
      posterStorageKey: 'posters/video-1/clip-1.jpg',
      posterTimestampSeconds: 5.75,
      sourceWidth: 1920,
      sourceHeight: 1080,
      posterGenerationMs: 40,
    });
    expect(reclips.appendReclipVersion).toHaveBeenCalled();
    expect(reclips.clearReclipPending).toHaveBeenCalledWith('match-1');
  });

  it('does the same for a caption Replace — the burned-in words belong in the picture too', async () => {
    await handleClipGeneration(job({ captions: [] }));

    expect(runOriginalPipeline).toHaveBeenCalledTimes(1);
    expect(setPosterFromCut).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous poster, says so, and still finishes when the new poster cannot be made', async () => {
    runOriginalPipeline.mockRejectedValueOnce(new Error('poster frame extracted to nothing'));

    await expect(handleClipGeneration(job({ reclip: reclipPayload }))).resolves.toBeUndefined();

    expect(setPosterFromCut).not.toHaveBeenCalled();
    // The cut is the truth and it landed; the Re-clip is applied, not rolled back.
    expect(clips.setClipStatus).toHaveBeenCalledWith('clip-1', 'ready', expect.objectContaining({ storageKey: 'clips/video-1/clip-1.mp4' }));
    expect(reclips.clearReclipPending).toHaveBeenCalledWith('match-1');
    expect(clips.restoreClipBoundaries).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('the re-cut clip kept its previous poster', expect.anything());
  });
});

describe('a re-render of any other moment', () => {
  it('leaves a moment cut on demand alone — it never had a poster', async () => {
    clips.getClip.mockResolvedValue({ ...cutOnFind, preRendered: false, presentation: null, posterStorageKey: null });

    await handleClipGeneration(job({ reclip: reclipPayload }));

    expect(runOriginalPipeline).not.toHaveBeenCalled();
    expect(setPosterFromCut).not.toHaveBeenCalled();
  });

  it("leaves a vertical moment alone — its poster is its derivative's, not this render's", async () => {
    clips.getClip.mockResolvedValue({ ...cutOnFind, presentation: 'vertical' });

    await handleClipGeneration(job({ reclip: reclipPayload }));

    expect(runOriginalPipeline).not.toHaveBeenCalled();
    expect(setPosterFromCut).not.toHaveBeenCalled();
  });
});
