import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Devin's and Codex's findings on #78/#79: a moment cut on find carries media
 * made FROM its cut — a poster, and for a vertical moment the 9:16 file —
 * and a re-render (a Re-clip's new boundaries, a caption Replace) puts a
 * different file under the same id.
 *
 * The protocol these tests pin: the new media is made at fresh keys, the new
 * cut is stored at a fresh key, and the row takes every new key in ONE
 * write. A failure anywhere before that write leaves the previous cut and
 * its media exactly as they were and takes the fresh objects back out; the
 * Re-clip is finalized only after the row names the new cut and media; the
 * old objects go after that. No model is asked: a vertical moment is
 * reframed with the decision its first render stored.
 */

const clips = { getClip: vi.fn(), setClipStatus: vi.fn(), restoreClipBoundaries: vi.fn() };
const reclips = { appendReclipVersion: vi.fn(), clearReclipPending: vi.fn(), markReclipFailed: vi.fn() };
const discardVariants = vi.fn();
const getVideo = vi.fn();
const storage = { downloadToFile: vi.fn(), uploadFile: vi.fn(), remove: vi.fn() };
const media = { cutClip: vi.fn(), ffprobe: vi.fn() };
const commitRender = vi.fn();
const enqueueObjectRelease = vi.fn();
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
vi.mock('../src/db/repositories/verticalMedia.js', () => ({ commitRender }));
vi.mock('../src/queues/index.js', () => ({ enqueueObjectRelease }));
const recordObjectRelease = vi.fn();
vi.mock('../src/db/repositories/objectReleases.js', () => ({ recordObjectRelease }));
const recordUnknownRender = vi.fn();
vi.mock('../src/db/repositories/unknownRenders.js', () => ({ recordUnknownRender }));
const txClient = { query: vi.fn() };
vi.mock('../src/db/pool.js', () => ({ withTransaction: (fn: (client: unknown) => Promise<unknown>) => fn(txClient) }));
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

const OLD_CANONICAL = 'clips/video-1/clip-1.mp4';
const OLD_POSTER = 'posters/video-1/clip-1.jpg';
const OLD_DERIVATIVE = 'clips/video-1/clip-1-vertical.mp4';
const FRESH_CANONICAL = /^clips\/video-1\/clip-1-[0-9a-f]{8}\.mp4$/;

const reclipPayload = {
  matchId: 'match-1',
  startSeconds: 128,
  endSeconds: 151,
  provider: 'modal',
  model: 'openbmb/MiniCPM-V-4.6',
  promptVersion: 'reclip-v1',
  previous: { startSeconds: 130, endSeconds: 150, boundariesEditedAt: null, status: 'ready' as const },
};

function job(data: Record<string, unknown>, overrides: { attemptsMade?: number; attempts?: number } = {}) {
  return {
    data: { clipId: 'clip-1', ...data },
    attemptsMade: overrides.attemptsMade ?? 0,
    opts: { attempts: overrides.attempts ?? 1 },
    updateProgress: vi.fn().mockResolvedValue(undefined),
    updateData: vi.fn().mockResolvedValue(undefined),
  } as never;
}

const original = {
  id: 'clip-1',
  videoId: 'video-1',
  startSeconds: 128,
  endSeconds: 151,
  status: 'pending',
  storageKey: OLD_CANONICAL,
  captions: null,
  preRendered: true,
  presentation: 'original',
  posterStorageKey: OLD_POSTER,
  derivativeStorageKey: null,
  compositionMode: 'original',
  focalX: null,
  focalY: null,
  retentionClass: 'temporary',
};

const vertical = {
  ...original,
  presentation: 'vertical',
  derivativeStorageKey: OLD_DERIVATIVE,
  compositionMode: 'smart_crop',
  focalX: 0.7,
  focalY: 0.4,
  retentionClass: 'owned',
};

const onDemand = { ...original, preRendered: false, presentation: null, posterStorageKey: null };

const orderOf = (mock: { mock: { invocationCallOrder: number[] } }) => mock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
const canonicalUpload = () => storage.uploadFile.mock.calls.find(([key]) => typeof key === 'string' && key.startsWith('clips/'));
const committed = () => commitRender.mock.calls[0]?.[1] as Record<string, unknown> | undefined;

beforeEach(() => {
  for (const mock of [
    ...Object.values(clips), ...Object.values(reclips), ...Object.values(storage), ...Object.values(media),
    ...Object.values(pipeline), ...Object.values(log), discardVariants, getVideo, commitRender, enqueueObjectRelease, recordObjectRelease, recordUnknownRender,
  ]) {
    mock.mockReset();
  }
  enqueueObjectRelease.mockResolvedValue(undefined);
  recordObjectRelease.mockResolvedValue(undefined);
  recordUnknownRender.mockResolvedValue(undefined);
  clips.getClip.mockResolvedValue(original);
  clips.setClipStatus.mockResolvedValue(true);
  reclips.appendReclipVersion.mockResolvedValue({ version: 2 });
  reclips.clearReclipPending.mockResolvedValue(undefined);
  discardVariants.mockResolvedValue(undefined);
  getVideo.mockResolvedValue({ id: 'video-1', originalStorageKey: 'videos/video-1/original.mp4', durationSeconds: 600, hasAudio: true });
  storage.downloadToFile.mockResolvedValue(undefined);
  storage.uploadFile.mockResolvedValue(undefined);
  storage.remove.mockResolvedValue(undefined);
  media.cutClip.mockResolvedValue({ sizeBytes: 500, durationSeconds: 23, width: 1920, height: 1080 });
  media.ffprobe.mockResolvedValue({ width: 1920, height: 1080 });
  commitRender.mockResolvedValue(true);
  pipeline.runOriginalPipeline.mockImplementation(async (input: { render?: string }) => ({
    posterStorageKey: `posters/video-1/clip-1${input.render ? `-${input.render}` : ''}.jpg`,
    posterTimestampSeconds: 5.75,
    posterGenerationMs: 40,
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceAspectRatio: '16:9',
  }));
  pipeline.runVerticalPipeline.mockImplementation(async (input: { render?: string }) => ({
    compositionMode: 'smart_crop',
    focalX: 0.7,
    focalY: 0.4,
    derivativeStorageKey: `clips/video-1/clip-1${input.render ? `-${input.render}` : ''}-vertical.mp4`,
    posterStorageKey: `posters/video-1/clip-1${input.render ? `-${input.render}` : ''}.jpg`,
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
});

describe('a re-render of a moment cut on find, original framing', () => {
  it('stores the new cut and its poster at fresh keys, takes both in one row write, then lets the old objects go', async () => {
    await handleClipGeneration(job({ reclip: reclipPayload }));

    const upload = canonicalUpload()!;
    const freshCanonical = upload[0] as string;
    expect(freshCanonical).toMatch(FRESH_CANONICAL);
    expect(freshCanonical).not.toBe(OLD_CANONICAL);
    const render = freshCanonical.slice('clips/video-1/clip-1-'.length, -'.mp4'.length);

    // The poster first, sharing the render's name, then the cut.
    const posterCall = pipeline.runOriginalPipeline.mock.calls[0]![0] as Record<string, unknown>;
    expect(posterCall).toMatchObject({ canonicalPath: '/tmp/clipit-test/clip-1.mp4', render, snapshotPosterKey: OLD_POSTER });
    expect(orderOf(pipeline.runOriginalPipeline)).toBeLessThan(storage.uploadFile.mock.invocationCallOrder[storage.uploadFile.mock.calls.indexOf(upload)]!);

    // One write, both keys — inside the same transaction as the Re-clip's
    // version and cleared pending state, and the stale variants.
    expect(commitRender).toHaveBeenCalledTimes(1);
    expect(commitRender.mock.calls[0]![2]).toBe(txClient);
    expect(reclips.appendReclipVersion.mock.calls[0]![1]).toBe(txClient);
    expect(reclips.clearReclipPending.mock.calls[0]![1]).toBe(txClient);
    expect(discardVariants.mock.calls[0]![1]).toBe(txClient);
    expect(committed()).toMatchObject({
      storageKey: freshCanonical,
      durationSeconds: 23,
      sizeBytes: 500,
      media: { kind: 'original', poster: { posterStorageKey: `posters/video-1/clip-1-${render}.jpg`, sourceWidth: 1920 } },
    });
    expect(committed()!.captions).toBeUndefined();

    // Only after the row names the new: the old cut and poster are queued
    // to go once no signed URL to them can still be live, and the Re-clip
    // is finalized.
    const released = enqueueObjectRelease.mock.calls[0]![0] as string[];
    expect(released).toEqual(expect.arrayContaining([OLD_CANONICAL, OLD_POSTER]));
    expect(orderOf(commitRender)).toBeLessThan(orderOf(enqueueObjectRelease));
    expect(orderOf(commitRender)).toBeLessThan(orderOf(reclips.appendReclipVersion));
    expect(reclips.clearReclipPending).toHaveBeenCalledWith('match-1', txClient);
    expect(pipeline.discardUploadedObjects).not.toHaveBeenCalled();
  });

  it('does the same for a caption Replace, whose spec rides in the same write', async () => {
    await handleClipGeneration(job({ captions: [] }));
    expect(canonicalUpload()![0]).toMatch(FRESH_CANONICAL);
    expect(pipeline.runOriginalPipeline).toHaveBeenCalledTimes(1);
    expect(committed()).toMatchObject({ captions: [], media: { kind: 'original' } });
    expect(enqueueObjectRelease.mock.calls[0]![0]).toEqual(expect.arrayContaining([OLD_CANONICAL]));
  });

  it('queues the files of the platform shapes it discarded for release, after the write, never before', async () => {
    discardVariants.mockResolvedValueOnce(['variants/video-1/clip-1-9x16.mp4'] as never);

    await handleClipGeneration(job({ reclip: reclipPayload }));

    expect(enqueueObjectRelease.mock.calls[0]![0]).toEqual(expect.arrayContaining(['variants/video-1/clip-1-9x16.mp4']));
    expect(orderOf(commitRender)).toBeLessThan(orderOf(enqueueObjectRelease));
    // Never removed on the spot: a publisher may still hold a signed URL to one.
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('leaves the platform shapes\' files alone when the write fails', async () => {
    discardVariants.mockResolvedValueOnce(['variants/video-1/clip-1-9x16.mp4'] as never);
    reclips.appendReclipVersion.mockRejectedValueOnce(new Error('versions table locked'));

    await expect(handleClipGeneration(job({ reclip: reclipPayload }))).rejects.toThrow('versions table locked');

    expect(enqueueObjectRelease).not.toHaveBeenCalled();
  });

  it('replaces nothing and rolls the Re-clip back when the new poster cannot be made', async () => {
    pipeline.runOriginalPipeline.mockRejectedValueOnce(new Error('poster frame extracted to nothing'));

    await expect(handleClipGeneration(job({ reclip: reclipPayload }))).rejects.toThrow('poster frame');

    expect(canonicalUpload()).toBeUndefined();
    expect(commitRender).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(clips.restoreClipBoundaries).toHaveBeenCalledWith('clip-1', expect.objectContaining({ startSeconds: 130, endSeconds: 150 }));
    expect(reclips.markReclipFailed).toHaveBeenCalled();
    expect(reclips.appendReclipVersion).not.toHaveBeenCalled();
  });

  it('takes the fresh cut and poster back out when the new cut cannot be stored', async () => {
    storage.uploadFile.mockImplementation(async (key: string) => {
      if (key.startsWith('clips/')) throw new Error('bucket refused');
    });

    await expect(handleClipGeneration(job({ reclip: reclipPayload }))).rejects.toThrow('bucket refused');

    const [keys, context] = pipeline.discardUploadedObjects.mock.calls[0]!;
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(FRESH_CANONICAL);
    expect(keys[1]).toMatch(/^posters\/video-1\/clip-1-[0-9a-f]{8}\.jpg$/);
    expect(context).toMatchObject({ clipId: 'clip-1', reason: 'render_commit_failed' });
    expect(commitRender).not.toHaveBeenCalled();
    expect(enqueueObjectRelease).not.toHaveBeenCalled();
    expect(reclips.appendReclipVersion).not.toHaveBeenCalled();
  });

  it('takes the fresh objects back out, keeps the previous pair, and does NOT finalize when the row write fails', async () => {
    commitRender.mockRejectedValueOnce(new Error('database refused'));

    await expect(handleClipGeneration(job({ reclip: reclipPayload }))).rejects.toThrow('database refused');

    const [keys] = pipeline.discardUploadedObjects.mock.calls[0]!;
    expect(keys).toHaveLength(2);
    // The previous cut and poster are still what the row names, so they stay.
    expect(enqueueObjectRelease).not.toHaveBeenCalled();
    // A failed render like any other: rolled back, no version, the failure on record.
    expect(clips.restoreClipBoundaries).toHaveBeenCalled();
    expect(reclips.markReclipFailed).toHaveBeenCalled();
    expect(reclips.appendReclipVersion).not.toHaveBeenCalled();
    expect(reclips.clearReclipPending).not.toHaveBeenCalled();
  });

  it('keeps the old objects when the finalization fails, because it is the same write', async () => {
    // A version that cannot be recorded fails the whole transaction: the
    // row still names the previous cut, so nothing old is removed and the
    // Re-clip rolls back like any failed render.
    reclips.appendReclipVersion.mockRejectedValueOnce(new Error('versions table locked'));

    await expect(handleClipGeneration(job({ reclip: reclipPayload }))).rejects.toThrow('versions table locked');

    expect(enqueueObjectRelease).not.toHaveBeenCalled();
    expect(pipeline.discardUploadedObjects).toHaveBeenCalledTimes(1);
    expect(clips.restoreClipBoundaries).toHaveBeenCalled();
    expect(reclips.markReclipFailed).toHaveBeenCalled();
  });

  it('carries on as committed when the write landed but its reply was lost', async () => {
    // The transaction committed; the connection dropped before the reply.
    // Asked afterwards, the row names the fresh cut — so nothing fresh is
    // deleted, the old objects go, and the Re-clip is not marked failed.
    commitRender.mockRejectedValueOnce(new Error('connection reset'));
    clips.getClip.mockImplementation(async () => {
      const upload = canonicalUpload();
      return upload ? { ...original, storageKey: upload[0], posterStorageKey: `posters/video-1/clip-1-${(upload[0] as string).slice(-12, -4)}.jpg` } : original;
    });

    await expect(handleClipGeneration(job({ reclip: reclipPayload }))).resolves.toBeUndefined();

    expect(pipeline.discardUploadedObjects).not.toHaveBeenCalled();
    expect(enqueueObjectRelease.mock.calls[0]![0]).toEqual(expect.arrayContaining([OLD_CANONICAL]));
    expect(clips.restoreClipBoundaries).not.toHaveBeenCalled();
    expect(reclips.markReclipFailed).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('carrying on as committed'), expect.anything());
  });

  it('asks the row again before giving up: one dropped read does not make the outcome unknown', async () => {
    commitRender.mockRejectedValueOnce(new Error('connection reset'));
    // First read: the handler's own. Second: the re-read, dropped. Third: answered — the write landed.
    clips.getClip
      .mockResolvedValueOnce(original)
      .mockRejectedValueOnce(new Error('connection reset'))
      .mockImplementation(async () => {
        const upload = canonicalUpload();
        return { ...original, storageKey: upload![0], posterStorageKey: `posters/video-1/clip-1-${(upload![0] as string).slice(-12, -4)}.jpg` };
      });

    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const outcome = expect(handleClipGeneration(job({ reclip: reclipPayload }))).resolves.toBeUndefined();
      await vi.runAllTimersAsync();
      await outcome;
    } finally {
      vi.useRealTimers();
    }

    expect(clips.getClip).toHaveBeenCalledTimes(3);
    expect(pipeline.discardUploadedObjects).not.toHaveBeenCalled();
    expect(enqueueObjectRelease.mock.calls[0]![0]).toEqual(expect.arrayContaining([OLD_CANONICAL]));
    expect(reclips.markReclipFailed).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('asking again'), expect.anything());
  });

  it('marks nothing failed and deletes nothing when the write failed and the row cannot be read either; both renders\' objects go to the release that will ask', async () => {
    // Devin's finding on #80: with the write's reply lost AND the row
    // unreadable, the outcome is unknown, and "unknown" was being treated
    // as "failed" — on the last attempt, a landed re-cut was labelled failed.
    // The reply is lost at the END of the transaction — after the shapes'
    // rows went — so their keys are in hand and must be queued too.
    discardVariants.mockResolvedValueOnce(['clips/video-1/clip-1/9x16-50-aaaaaaaa.mp4'] as never);
    reclips.clearReclipPending.mockRejectedValueOnce(new Error('database refused'));
    clips.getClip.mockResolvedValueOnce(original).mockRejectedValue(new Error('database unreachable'));

    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      // The job's LAST attempt — the case where a definite failure would roll the Re-clip back.
      const outcome = expect(handleClipGeneration(job({ reclip: reclipPayload }))).rejects.toThrow('database refused');
      await vi.runAllTimersAsync();
      await outcome;
    } finally {
      vi.useRealTimers();
    }

    // Five reads: the handler's own, then the re-read and its four retries.
    expect(clips.getClip).toHaveBeenCalledTimes(6);
    expect(pipeline.discardUploadedObjects).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    // Old cut, old poster, the discarded shape and this render's fresh pair —
    // all queued; the release keeps whichever the row names when it acts.
    const [keys, context] = enqueueObjectRelease.mock.calls[0]!;
    expect(keys).toEqual(expect.arrayContaining([OLD_CANONICAL, OLD_POSTER, 'clips/video-1/clip-1/9x16-50-aaaaaaaa.mp4']));
    expect(keys.some((key: string) => FRESH_CANONICAL.test(key))).toBe(true);
    expect(keys.some((key: string) => /^posters\/video-1\/clip-1-[0-9a-f]{8}\.jpg$/.test(key))).toBe(true);
    expect(context).toMatchObject({ clipId: 'clip-1', reason: 'render_outcome_unknown' });
    // Not a failure: nothing put back, nothing marked, no error written on the clip.
    expect(clips.restoreClipBoundaries).not.toHaveBeenCalled();
    expect(reclips.markReclipFailed).not.toHaveBeenCalled();
    expect(clips.setClipStatus).not.toHaveBeenCalledWith('clip-1', 'ready', expect.anything());
    expect(clips.setClipStatus).not.toHaveBeenCalledWith('clip-1', 'failed', expect.anything());
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('outcome is unknown'), expect.objectContaining({ keys: expect.any(Array) }));
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('nothing marked failed'), expect.objectContaining({ lastAttempt: true }));
    // The last attempt writes the render down for the sweep to settle.
    const [record] = recordUnknownRender.mock.calls[0]!;
    expect(record.clipId).toBe('clip-1');
    expect(record.storageKey).toMatch(FRESH_CANONICAL);
    expect(record.previousStorageKey).toBe(OLD_CANONICAL);
    expect(record.job.reclip.matchId).toBe('match-1');
  });

  it('does not write an unknown render down while attempts remain: the retry will settle it', async () => {
    reclips.clearReclipPending.mockRejectedValueOnce(new Error('database refused'));
    clips.getClip.mockResolvedValueOnce(original).mockRejectedValue(new Error('database unreachable'));

    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const outcome = expect(handleClipGeneration(job({ reclip: reclipPayload }, { attemptsMade: 0, attempts: 3 }))).rejects.toThrow('database refused');
      await vi.runAllTimersAsync();
      await outcome;
    } finally {
      vi.useRealTimers();
    }

    expect(recordUnknownRender).not.toHaveBeenCalled();
  });

  it('records the keys on the job when the release cannot be queued either, so the retry can', async () => {
    // Devin's finding on #81: the release was the only record of those
    // objects, and a queue that refused was being swallowed.
    reclips.clearReclipPending.mockRejectedValueOnce(new Error('database refused'));
    clips.getClip.mockResolvedValueOnce(original).mockRejectedValue(new Error('database unreachable'));
    enqueueObjectRelease.mockRejectedValueOnce(new Error('redis refused'));
    const attempt = job({ reclip: reclipPayload });

    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const outcome = expect(handleClipGeneration(attempt)).rejects.toThrow('database refused');
      await vi.runAllTimersAsync();
      await outcome;
    } finally {
      vi.useRealTimers();
    }

    const recorded = (attempt as { updateData: ReturnType<typeof vi.fn> }).updateData.mock.calls[0]![0] as { unresolvedKeys: string[] };
    expect(recorded.unresolvedKeys).toEqual(expect.arrayContaining([OLD_CANONICAL, OLD_POSTER]));
    expect(recorded.unresolvedKeys.some((key) => FRESH_CANONICAL.test(key))).toBe(true);
    // And in the database, where the sweep finds it even after the job's last attempt.
    const [dbKeys, dbContext] = recordObjectRelease.mock.calls[0]!;
    expect(dbKeys).toEqual(recorded.unresolvedKeys);
    expect(dbContext).toMatchObject({ clipId: 'clip-1', reason: 'render_outcome_unknown' });
    expect(storage.remove).not.toHaveBeenCalled();
    expect(reclips.markReclipFailed).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('recording the keys'), expect.objectContaining({ keys: expect.any(Array) }));
  });

  it('on a retry, queues an earlier attempt\'s unresolved objects for release before anything else, then clears the record', async () => {
    const attempt = job({ reclip: reclipPayload, unresolvedKeys: ['clips/video-1/clip-1-deadbeef.mp4', OLD_CANONICAL] }, { attemptsMade: 1, attempts: 3 });
    clips.getClip.mockResolvedValue({ ...original, status: 'generating' });

    await expect(handleClipGeneration(attempt)).resolves.toBeUndefined();

    const [keys, context] = enqueueObjectRelease.mock.calls[0]!;
    expect(keys).toEqual(['clips/video-1/clip-1-deadbeef.mp4', OLD_CANONICAL]);
    expect(context).toMatchObject({ clipId: 'clip-1', reason: 'render_outcome_unknown' });
    expect(orderOf(enqueueObjectRelease)).toBeLessThan(orderOf(media.cutClip));
    const cleared = (attempt as { updateData: ReturnType<typeof vi.fn> }).updateData.mock.calls[0]![0] as { unresolvedKeys?: string[] };
    expect(cleared.unresolvedKeys).toBeUndefined();
    // And the render itself went on as normal.
    expect(commitRender).toHaveBeenCalledTimes(1);
  });

  it('on a retry, queues them even when the clip is already generated — the earlier attempt landed, and this one would otherwise say nothing', async () => {
    // Devin's finding on #81: the "already generated" shortcut came first
    // and returned with the record unread.
    const attempt = job({ unresolvedKeys: ['clips/video-1/clip-1.mp4', OLD_POSTER] }, { attemptsMade: 1, attempts: 3 });
    clips.getClip.mockResolvedValue({ ...original, status: 'ready', storageKey: 'clips/video-1/clip-1.mp4' });

    await expect(handleClipGeneration(attempt)).resolves.toBeUndefined();

    expect(enqueueObjectRelease).toHaveBeenCalledWith(['clips/video-1/clip-1.mp4', OLD_POSTER], expect.objectContaining({ reason: 'render_outcome_unknown' }));
    expect(media.cutClip).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith('clip already generated, skipping');
  });

  it('on a retry, stops before cutting when those objects still cannot be queued', async () => {
    const attempt = job({ reclip: reclipPayload, unresolvedKeys: [OLD_CANONICAL] }, { attemptsMade: 1, attempts: 3 });
    clips.getClip.mockResolvedValue({ ...original, status: 'generating' });
    enqueueObjectRelease.mockRejectedValueOnce(new Error('redis refused'));

    await expect(handleClipGeneration(attempt)).rejects.toThrow('redis refused');

    expect(media.cutClip).not.toHaveBeenCalled();
    expect(commitRender).not.toHaveBeenCalled();
  });

  it('on a retry, sees that the earlier attempt landed and neither cuts again nor records the version twice', async () => {
    clips.getClip.mockResolvedValue({ ...original, status: 'ready', storageKey: 'clips/video-1/clip-1-0ddba11a.mp4', startSeconds: 128, endSeconds: 151 });

    await expect(handleClipGeneration({ ...(job({ reclip: reclipPayload }) as object), attemptsMade: 1, opts: { attempts: 3 } } as never)).resolves.toBeUndefined();

    expect(media.cutClip).not.toHaveBeenCalled();
    expect(commitRender).not.toHaveBeenCalled();
    expect(reclips.appendReclipVersion).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('earlier attempt of this render landed'), expect.objectContaining({ attemptsMade: 1 }));
  });

  it('on a retry, still renders a Re-clip whose earlier attempt failed for real: the row is not ready', async () => {
    clips.getClip.mockResolvedValue({ ...original, status: 'generating', startSeconds: 128, endSeconds: 151 });

    await expect(handleClipGeneration({ ...(job({ reclip: reclipPayload }) as object), attemptsMade: 1, opts: { attempts: 3 } } as never)).resolves.toBeUndefined();

    expect(media.cutClip).toHaveBeenCalledTimes(1);
    expect(commitRender).toHaveBeenCalledTimes(1);
  });

  it('on a retry of a Replace, reads the landed spec through its stored spelling', async () => {
    const captions = [{ text: 'hello', start: 1, end: 2, position: 85 }];
    // JSONB gives the keys back in its own order; the same spec all the same.
    clips.getClip.mockResolvedValue({ ...original, status: 'ready', captions: [{ end: 2, position: 85, start: 1, text: 'hello' }] });

    await expect(handleClipGeneration({ ...(job({ captions }) as object), attemptsMade: 1, opts: { attempts: 3 } } as never)).resolves.toBeUndefined();

    expect(media.cutClip).not.toHaveBeenCalled();
  });

  it('on a retry of a Replace whose earlier attempt failed for real, renders: the row is ready with the OLD spec', async () => {
    const captions = [{ text: 'hello', start: 1, end: 2, position: 85 }];
    clips.getClip.mockResolvedValue({ ...original, status: 'ready', captions: null });

    await expect(handleClipGeneration({ ...(job({ captions }) as object), attemptsMade: 1, opts: { attempts: 3 } } as never)).resolves.toBeUndefined();

    expect(media.cutClip).toHaveBeenCalledTimes(1);
  });

  it('treats a row that vanished the same way: nothing to record, so the fresh objects go', async () => {
    commitRender.mockResolvedValueOnce(false);

    await expect(handleClipGeneration(job({ reclip: reclipPayload }))).rejects.toThrow('no longer exists');

    expect(pipeline.discardUploadedObjects).toHaveBeenCalledTimes(1);
    expect(enqueueObjectRelease).not.toHaveBeenCalled();
    expect(reclips.appendReclipVersion).not.toHaveBeenCalled();
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
      askComposition: (path: string) => Promise<{ content: string; provider: string }>;
      snapshotDerivativeKey: string | null;
    };
    expect(call.snapshotDerivativeKey).toBe(OLD_DERIVATIVE);
    const answer = await call.askComposition('/tmp/clipit-test/clip-1.mp4');
    expect(JSON.parse(answer.content)).toEqual({ composition_mode: 'smart_crop', crop_safe: true, focal_x: 0.7, focal_y: 0.4 });
    expect(answer.provider).toBe('stored');

    expect(canonicalUpload()![0]).toBe(`clips/video-1/clip-1-${call.render}.mp4`);
    expect(committed()).toMatchObject({
      storageKey: `clips/video-1/clip-1-${call.render}.mp4`,
      media: {
        kind: 'vertical',
        media: {
          derivativeStorageKey: `clips/video-1/clip-1-${call.render}-vertical.mp4`,
          posterStorageKey: `posters/video-1/clip-1-${call.render}.jpg`,
          compositionMode: 'smart_crop',
        },
      },
    });
    expect(enqueueObjectRelease.mock.calls[0]![0]).toEqual(expect.arrayContaining([OLD_CANONICAL, OLD_DERIVATIVE, OLD_POSTER]));
    expect(pipeline.runOriginalPipeline).not.toHaveBeenCalled();
  });

  it('takes all three fresh objects back out when the new cut cannot be stored', async () => {
    storage.uploadFile.mockImplementation(async (key: string) => {
      if (key.startsWith('clips/') && !key.endsWith('-vertical.mp4')) throw new Error('bucket refused');
    });

    await expect(handleClipGeneration(job({ reclip: reclipPayload }))).rejects.toThrow('bucket refused');

    const [keys] = pipeline.discardUploadedObjects.mock.calls[0]!;
    expect(keys).toHaveLength(3);
    expect(commitRender).not.toHaveBeenCalled();
    expect(enqueueObjectRelease).not.toHaveBeenCalled();
  });
});

describe('a re-render of a moment cut on demand', () => {
  it('remakes no media, but still stores the new cut beside the old and swaps them in one write', async () => {
    clips.getClip.mockResolvedValue(onDemand);

    await handleClipGeneration(job({ reclip: reclipPayload }));

    expect(pipeline.runOriginalPipeline).not.toHaveBeenCalled();
    expect(pipeline.runVerticalPipeline).not.toHaveBeenCalled();
    expect(canonicalUpload()![0]).toMatch(FRESH_CANONICAL);
    expect(committed()).toMatchObject({ media: { kind: 'none' } });
    expect(enqueueObjectRelease.mock.calls[0]![0]).toEqual([OLD_CANONICAL]);
  });
});

describe('a first render', () => {
  it('keeps the plain key it always had, and removes nothing', async () => {
    clips.getClip.mockResolvedValue({ ...onDemand, storageKey: null, status: 'pending' });

    await handleClipGeneration(job({}));

    expect(canonicalUpload()![0]).toBe(OLD_CANONICAL);
    expect(committed()).toMatchObject({ storageKey: OLD_CANONICAL, media: { kind: 'none' } });
    expect(enqueueObjectRelease).not.toHaveBeenCalled();
  });

  it('takes its own cut back out when the row write fails and the row never came to name it', async () => {
    clips.getClip.mockResolvedValue({ ...onDemand, storageKey: null, status: 'pending' });
    commitRender.mockRejectedValueOnce(new Error('database refused'));

    await expect(handleClipGeneration(job({}))).rejects.toThrow('database refused');

    // A cut no row names would sit in storage for good; a retry uploads again.
    expect(pipeline.discardUploadedObjects).toHaveBeenCalledWith([OLD_CANONICAL], expect.objectContaining({ reason: 'render_commit_failed' }));
    expect(clips.setClipStatus).toHaveBeenCalledWith('clip-1', 'failed', expect.objectContaining({ errorMessage: 'database refused' }));
  });

  it('keeps a plain-key cut the row already named, and does not mistake that for a landed write', async () => {
    // A failed clip being generated again: its row still names the plain key
    // from the earlier attempt. The write fails. The row naming the key says
    // nothing about this write, so it is a failure — and the object stays.
    clips.getClip.mockResolvedValue({ ...onDemand, storageKey: OLD_CANONICAL, status: 'failed' });
    commitRender.mockRejectedValueOnce(new Error('database refused'));

    await expect(handleClipGeneration(job({}))).rejects.toThrow('database refused');

    for (const [keys] of pipeline.discardUploadedObjects.mock.calls) expect(keys).toEqual([]);
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('carrying on as committed'), expect.anything());
    expect(clips.setClipStatus).toHaveBeenCalledWith('clip-1', 'ready', expect.objectContaining({ errorMessage: 'database refused' }));
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
