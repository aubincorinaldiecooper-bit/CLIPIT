import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Devin's findings on #78: a moment cut on find carries media made FROM its
 * cut — a poster, and for a vertical moment the 9:16 file — and a re-render
 * (a Re-clip's new boundaries, a caption Replace) puts a different file
 * under the same id. The media is made again from the new cut, BEFORE the
 * cut is replaced and at fresh keys, so a failure leaves the previous pair
 * intact; the row takes the new keys only once the new cut is stored, and
 * the old objects go after that. No model is asked: a vertical moment is
 * reframed with the decision its first render stored.
 */

const clips = { getClip: vi.fn(), setClipStatus: vi.fn(), restoreClipBoundaries: vi.fn() };
const reclips = { appendReclipVersion: vi.fn(), clearReclipPending: vi.fn(), markReclipFailed: vi.fn() };
const discardVariants = vi.fn();
const getVideo = vi.fn();
const storage = { downloadToFile: vi.fn(), uploadFile: vi.fn(), remove: vi.fn() };
const media = { cutClip: vi.fn(), ffprobe: vi.fn() };
const verticalMedia = { setPosterFromCut: vi.fn(), setVerticalMedia: vi.fn() };
const pipeline = { runOriginalPipeline: vi.fn(), runVerticalPipeline: vi.fn(), discardUploadedObjects: vi.fn() };
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
vi.mock('../src/db/repositories/verticalMedia.js', () => ({
  setPosterFromCut: verticalMedia.setPosterFromCut,
  setVerticalMedia: verticalMedia.setVerticalMedia,
}));
vi.mock('../src/services/media/verticalPipeline.js', () => ({
  runOriginalPipeline: pipeline.runOriginalPipeline,
  runVerticalPipeline: pipeline.runVerticalPipeline,
  discardUploadedObjects: pipeline.discardUploadedObjects,
}));
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
const { storedCompositionAnswer } = await import('../src/services/media/rerender.js');

const CANONICAL_KEY = 'clips/video-1/clip-1.mp4';

const reclipPayload = {
  matchId: 'match-1',
  startSeconds: 128,
  endSeconds: 151,
  provider: 'modal',
  model: 'openbmb/MiniCPM-V-4.6',
  promptVersion: 'reclip-v1',
  previous: { startSeconds: 130, endSeconds: 150, boundariesEditedAt: null, status: 'ready' as const },
};

function job(data: Record<string, unknown>, attempts = 1) {
  return {
    data: { clipId: 'clip-1', ...data },
    attemptsMade: 0,
    opts: { attempts },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  } as never;
}

const original = {
  id: 'clip-1',
  videoId: 'video-1',
  startSeconds: 128,
  endSeconds: 151,
  status: 'pending',
  storageKey: CANONICAL_KEY,
  captions: null,
  preRendered: true,
  presentation: 'original',
  posterStorageKey: 'posters/video-1/clip-1.jpg',
  derivativeStorageKey: null,
  compositionMode: 'original',
  focalX: null,
  focalY: null,
  retentionClass: 'temporary',
};

const vertical = {
  ...original,
  presentation: 'vertical',
  derivativeStorageKey: 'clips/video-1/clip-1-vertical.mp4',
  compositionMode: 'smart_crop',
  focalX: 0.7,
  focalY: 0.4,
  retentionClass: 'owned',
};

const orderOf = (mock: { mock: { invocationCallOrder: number[] } }) => mock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;

beforeEach(() => {
  for (const mock of [
    ...Object.values(clips), ...Object.values(reclips), ...Object.values(storage), ...Object.values(media),
    ...Object.values(verticalMedia), ...Object.values(pipeline), ...Object.values(log), discardVariants, getVideo,
  ]) {
    mock.mockReset();
  }
  clips.getClip.mockResolvedValue(original);
  clips.setClipStatus.mockResolvedValue(undefined);
  reclips.appendReclipVersion.mockResolvedValue({ version: 2 });
  reclips.clearReclipPending.mockResolvedValue(undefined);
  discardVariants.mockResolvedValue(undefined);
  getVideo.mockResolvedValue({ id: 'video-1', originalStorageKey: 'videos/video-1/original.mp4', durationSeconds: 600, hasAudio: true });
  storage.downloadToFile.mockResolvedValue(undefined);
  storage.uploadFile.mockResolvedValue(undefined);
  storage.remove.mockResolvedValue(undefined);
  media.cutClip.mockResolvedValue({ sizeBytes: 500, durationSeconds: 23, width: 1920, height: 1080 });
  media.ffprobe.mockResolvedValue({ width: 1920, height: 1080 });
  pipeline.runOriginalPipeline.mockImplementation(async (input: { render: string }) => ({
    posterStorageKey: `posters/video-1/clip-1-${input.render}.jpg`,
    posterTimestampSeconds: 5.75,
    posterGenerationMs: 40,
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceAspectRatio: '16:9',
  }));
  pipeline.runVerticalPipeline.mockImplementation(async (input: { render: string }) => ({
    compositionMode: 'smart_crop',
    focalX: 0.7,
    focalY: 0.4,
    derivativeStorageKey: `clips/video-1/clip-1-${input.render}-vertical.mp4`,
    posterStorageKey: `posters/video-1/clip-1-${input.render}.jpg`,
    posterTimestampSeconds: 5.75,
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceAspectRatio: '16:9',
    outputWidth: 1080,
    outputHeight: 1920,
    compositionDecisionMs: 1,
    derivativeGenerationMs: 300,
    posterGenerationMs: 40,
    provider: 'stored',
    model: 'first-render',
  }));
  pipeline.discardUploadedObjects.mockResolvedValue(undefined);
  verticalMedia.setPosterFromCut.mockResolvedValue(undefined);
  verticalMedia.setVerticalMedia.mockResolvedValue(undefined);
});

describe('a re-render of a moment cut on find, original framing', () => {
  it('makes the new poster BEFORE the cut is replaced, at a fresh key, then points the row at it and lets the old one go', async () => {
    await handleClipGeneration(job({ reclip: reclipPayload }));

    const call = pipeline.runOriginalPipeline.mock.calls[0]![0] as Record<string, unknown>;
    expect(call).toMatchObject({
      videoId: 'video-1',
      clipId: 'clip-1',
      canonicalPath: '/tmp/clipit-test/clip-1.mp4',
      durationSeconds: 23,
      width: 1920,
      height: 1080,
      snapshotPosterKey: 'posters/video-1/clip-1.jpg',
    });
    const render = call.render as string;
    expect(render).toMatch(/^[0-9a-f]{8}$/);
    // Poster first; the canonical replaced only after.
    const canonicalUpload = storage.uploadFile.mock.calls.findIndex(([key]) => key === CANONICAL_KEY);
    expect(canonicalUpload).toBeGreaterThanOrEqual(0);
    expect(orderOf(pipeline.runOriginalPipeline)).toBeLessThan(storage.uploadFile.mock.invocationCallOrder[canonicalUpload]!);

    expect(verticalMedia.setPosterFromCut).toHaveBeenCalledWith('clip-1', {
      posterStorageKey: `posters/video-1/clip-1-${render}.jpg`,
      posterTimestampSeconds: 5.75,
      sourceWidth: 1920,
      sourceHeight: 1080,
      posterGenerationMs: 40,
    });
    expect(storage.remove).toHaveBeenCalledWith('posters/video-1/clip-1.jpg');
    // And the Re-clip is finalized only after the row names the new media.
    expect(orderOf(verticalMedia.setPosterFromCut)).toBeLessThan(orderOf(reclips.appendReclipVersion));
    expect(reclips.clearReclipPending).toHaveBeenCalledWith('match-1');
  });

  it('does the same for a caption Replace — the burned-in words belong in the picture too', async () => {
    await handleClipGeneration(job({ captions: [] }));
    expect(pipeline.runOriginalPipeline).toHaveBeenCalledTimes(1);
    expect(verticalMedia.setPosterFromCut).toHaveBeenCalledTimes(1);
  });

  it('leaves the previous cut and poster untouched, and rolls the Re-clip back, when the new poster cannot be made', async () => {
    pipeline.runOriginalPipeline.mockRejectedValueOnce(new Error('poster frame extracted to nothing'));

    await expect(handleClipGeneration(job({ reclip: reclipPayload }))).rejects.toThrow('poster frame');

    // Nothing was replaced: no canonical upload, no row write, no old object removed.
    expect(storage.uploadFile.mock.calls.some(([key]) => key === CANONICAL_KEY)).toBe(false);
    expect(verticalMedia.setPosterFromCut).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    // The render's own rollback applies: previous boundaries, no version.
    expect(clips.restoreClipBoundaries).toHaveBeenCalledWith('clip-1', expect.objectContaining({ startSeconds: 130, endSeconds: 150 }));
    expect(reclips.markReclipFailed).toHaveBeenCalled();
    expect(reclips.appendReclipVersion).not.toHaveBeenCalled();
  });

  it('takes the new poster back out when the new cut itself cannot be stored', async () => {
    storage.uploadFile.mockImplementation(async (key: string) => {
      if (key === CANONICAL_KEY) throw new Error('bucket refused');
    });

    await expect(handleClipGeneration(job({ reclip: reclipPayload }))).rejects.toThrow('bucket refused');

    const render = (pipeline.runOriginalPipeline.mock.calls[0]![0] as { render: string }).render;
    expect(pipeline.discardUploadedObjects).toHaveBeenCalledWith(
      [`posters/video-1/clip-1-${render}.jpg`],
      expect.objectContaining({ clipId: 'clip-1', reason: 'canonical_replace_failed' }),
    );
    expect(verticalMedia.setPosterFromCut).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('keeps the previous media, says so, and still finishes when the row cannot take the new keys', async () => {
    verticalMedia.setPosterFromCut.mockRejectedValueOnce(new Error('database refused'));

    await expect(handleClipGeneration(job({ reclip: reclipPayload }))).resolves.toBeUndefined();

    // The cut is the truth and it landed; the old poster is not removed
    // because the row still names it; the disagreement is on record.
    expect(clips.setClipStatus).toHaveBeenCalledWith('clip-1', 'ready', expect.objectContaining({ storageKey: CANONICAL_KEY }));
    expect(storage.remove).not.toHaveBeenCalled();
    expect(reclips.clearReclipPending).toHaveBeenCalledWith('match-1');
    expect(log.error).toHaveBeenCalledWith('the re-cut clip kept its previous delivered media', expect.anything());
  });
});

describe('a re-render of a moment cut on find, vertical', () => {
  beforeEach(() => {
    clips.getClip.mockResolvedValue(vertical);
  });

  it('remakes the 9:16 file and its poster from the new cut with the framing its first render stored — no model call', async () => {
    await handleClipGeneration(job({ reclip: reclipPayload }));

    const call = pipeline.runVerticalPipeline.mock.calls[0]![0] as {
      render: string;
      askComposition: (path: string) => Promise<{ content: string; provider: string; model: string }>;
      snapshotDerivativeKey: string | null;
    };
    expect(call.snapshotDerivativeKey).toBe('clips/video-1/clip-1-vertical.mp4');
    const answer = await call.askComposition('/tmp/clipit-test/clip-1.mp4');
    expect(JSON.parse(answer.content)).toEqual({ composition_mode: 'smart_crop', crop_safe: true, focal_x: 0.7, focal_y: 0.4 });
    expect(answer.provider).toBe('stored');

    expect(verticalMedia.setVerticalMedia).toHaveBeenCalledWith('clip-1', expect.objectContaining({
      derivativeStorageKey: `clips/video-1/clip-1-${call.render}-vertical.mp4`,
      posterStorageKey: `posters/video-1/clip-1-${call.render}.jpg`,
      compositionMode: 'smart_crop',
      // A kept moment stays kept.
      retentionClass: 'owned',
    }));
    expect(storage.remove).toHaveBeenCalledWith('clips/video-1/clip-1-vertical.mp4');
    expect(storage.remove).toHaveBeenCalledWith('posters/video-1/clip-1.jpg');
    expect(pipeline.runOriginalPipeline).not.toHaveBeenCalled();
  });

  it('takes both new objects back out when the new cut cannot be stored', async () => {
    storage.uploadFile.mockImplementation(async (key: string) => {
      if (key === CANONICAL_KEY) throw new Error('bucket refused');
    });

    await expect(handleClipGeneration(job({ reclip: reclipPayload }))).rejects.toThrow('bucket refused');

    const render = (pipeline.runVerticalPipeline.mock.calls[0]![0] as { render: string }).render;
    expect(pipeline.discardUploadedObjects).toHaveBeenCalledWith(
      [`clips/video-1/clip-1-${render}-vertical.mp4`, `posters/video-1/clip-1-${render}.jpg`],
      expect.objectContaining({ reason: 'canonical_replace_failed' }),
    );
    expect(verticalMedia.setVerticalMedia).not.toHaveBeenCalled();
  });
});

describe('what the first render decided, said back', () => {
  it('repeats a smart crop with its focal point', () => {
    expect(JSON.parse(storedCompositionAnswer({ compositionMode: 'smart_crop', focalX: 0.25, focalY: 0.5 })))
      .toEqual({ composition_mode: 'smart_crop', crop_safe: true, focal_x: 0.25, focal_y: 0.5 });
  });

  it('keeps the whole frame for a whole-frame mode, or a crop with no focal point', () => {
    expect(JSON.parse(storedCompositionAnswer({ compositionMode: 'blurred_background', focalX: null, focalY: null })).composition_mode)
      .toBe('blurred_background');
    expect(JSON.parse(storedCompositionAnswer({ compositionMode: 'smart_crop', focalX: null, focalY: 0.5 })).composition_mode)
      .toBe('blurred_background');
  });
});

describe('a re-render of a moment cut on demand', () => {
  it('remakes nothing — it never had delivered media', async () => {
    clips.getClip.mockResolvedValue({ ...original, preRendered: false, presentation: null, posterStorageKey: null });

    await handleClipGeneration(job({ reclip: reclipPayload }));

    expect(pipeline.runOriginalPipeline).not.toHaveBeenCalled();
    expect(pipeline.runVerticalPipeline).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });
});
