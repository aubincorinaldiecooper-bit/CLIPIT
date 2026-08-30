import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Re-clip job, with every external mocked — database, storage, ffmpeg,
 * queue, and the model seam. No test here can reach a GPU.
 *
 * The rules pinned:
 * - the model sees a WIDER window around the current boundaries, clamped to
 *   the footage that exists;
 * - the answer must be the SAME moment (overlap enforced) or nothing changes;
 * - the original version is never touched — success only APPENDS;
 * - usage is recorded under the 'reclip' stage with the answering model;
 * - a failure at any step leaves the original clip intact and writes a
 *   visible reason;
 * - the per-moment ceiling is enforced.
 */

const repos = {
  getClipRequest: vi.fn(),
  listMatchesByIds: vi.fn(),
  getVideo: vi.fn(),
  ensureInitialVersion: vi.fn(),
  listVersions: vi.fn(),
  appendReclipVersion: vi.fn(),
  countReclips: vi.fn(),
  clearReclipPending: vi.fn(),
  markReclipFailed: vi.fn(),
  getRootClipByMatchId: vi.fn(),
  setClipBoundaries: vi.fn(),
  restoreClipBoundaries: vi.fn(),
  listTranscriptSegmentsInRange: vi.fn(),
  recordModelUsage: vi.fn(),
};

const storage = {
  downloadToFile: vi.fn(),
  uploadFile: vi.fn(),
  remove: vi.fn(),
};

const media = { cutClip: vi.fn(), ffprobe: vi.fn() };
const askVideoModel = vi.fn();
const enqueueClipGeneration = vi.fn();

vi.mock('../src/db/repositories/clipRequests.js', () => ({
  getClipRequest: repos.getClipRequest,
  listMatchesByIds: repos.listMatchesByIds,
}));
vi.mock('../src/db/repositories/videos.js', () => ({ getVideo: repos.getVideo }));
vi.mock('../src/db/repositories/reclips.js', () => ({
  ensureInitialVersion: repos.ensureInitialVersion,
  listVersions: repos.listVersions,
  appendReclipVersion: repos.appendReclipVersion,
  countReclips: repos.countReclips,
  clearReclipPending: repos.clearReclipPending,
  markReclipFailed: repos.markReclipFailed,
}));
vi.mock('../src/db/repositories/clips.js', () => ({
  getRootClipByMatchId: repos.getRootClipByMatchId,
  setClipBoundaries: repos.setClipBoundaries,
  restoreClipBoundaries: repos.restoreClipBoundaries,
}));
vi.mock('../src/db/repositories/transcripts.js', () => ({
  listTranscriptSegmentsInRange: repos.listTranscriptSegmentsInRange,
}));
vi.mock('../src/db/repositories/usage.js', () => ({ recordModelUsage: repos.recordModelUsage }));
vi.mock('../src/services/storage/s3.js', () => ({ getStorage: () => storage }));
vi.mock('../src/services/media/ffmpeg.js', () => ({
  cutClip: media.cutClip,
  ffprobe: media.ffprobe,
}));
vi.mock('../src/services/search/openrouterVideo.js', () => ({
  askVideoModel,
  videoPartFromFile: vi.fn().mockResolvedValue({ part: { type: 'video', data: 'x' }, bytes: 10 }),
}));
vi.mock('../src/queues/index.js', () => ({ enqueueClipGeneration }));

const { handleReclip } = await import('../src/worker/handlers/reclip.js');
const { env } = await import('../src/config/env.js');

const job = { data: { matchId: 'match-1', clipRequestId: 'request-1' } } as never;

const match = {
  id: 'match-1',
  globalStartSeconds: 130,
  globalEndSeconds: 150,
  provider: 'modal',
  model: 'openbmb/MiniCPM-V-4.6',
  promptVersion: 'v1',
};

beforeEach(() => {
  for (const mock of [...Object.values(repos), ...Object.values(storage), ...Object.values(media), askVideoModel, enqueueClipGeneration]) {
    mock.mockReset();
  }
  // Side-effect mocks the handler chains .catch() onto must resolve.
  storage.downloadToFile.mockResolvedValue(undefined);
  storage.uploadFile.mockResolvedValue(undefined);
  storage.remove.mockResolvedValue(undefined);
  repos.markReclipFailed.mockResolvedValue(undefined);
  repos.clearReclipPending.mockResolvedValue(undefined);
  repos.restoreClipBoundaries.mockResolvedValue(undefined);
  repos.recordModelUsage.mockResolvedValue(undefined);
  enqueueClipGeneration.mockResolvedValue(undefined);
  repos.getClipRequest.mockResolvedValue({ id: 'request-1', videoId: 'video-1', instruction: 'the goal' });
  repos.listMatchesByIds.mockResolvedValue([match]);
  repos.getVideo.mockResolvedValue({ id: 'video-1', proxyStorageKey: 'videos/video-1/proxy.mp4', durationSeconds: 600 });
  repos.countReclips.mockResolvedValue(0);
  repos.ensureInitialVersion.mockResolvedValue(undefined);
  repos.listVersions.mockResolvedValue([
    { matchId: 'match-1', version: 1, trigger: 'initial', startSeconds: 130, endSeconds: 150 },
  ]);
  repos.appendReclipVersion.mockResolvedValue({ version: 2, startSeconds: 128, endSeconds: 151 });
  repos.getRootClipByMatchId.mockResolvedValue(null);
  repos.listTranscriptSegmentsInRange.mockResolvedValue([]);
  media.ffprobe.mockResolvedValue({ durationSeconds: 40, hasAudio: true });
  media.cutClip.mockResolvedValue({ sizeBytes: 1000, durationSeconds: 40 });
  askVideoModel.mockResolvedValue({
    content: '{"start_seconds":8.0,"end_seconds":31.0}',
    provider: 'modal',
    model: 'openbmb/MiniCPM-V-4.6',
    promptVersion: 'reclip-v1',
    reasoningDisabled: false,
  });
});

describe('handleReclip', () => {
  it('cuts a wider window around the current boundaries, clamped to the video', async () => {
    await handleReclip(job);

    const cut = media.cutClip.mock.calls[0]![0] as { startSeconds: number; endSeconds: number };
    expect(cut.startSeconds).toBe(130 - env.RECLIP_CONTEXT_BEFORE_SECONDS);
    expect(cut.endSeconds).toBe(150 + env.RECLIP_CONTEXT_AFTER_SECONDS);
  });

  it('clamps the window at the start of the video instead of asking for negative footage', async () => {
    repos.listVersions.mockResolvedValue([
      { matchId: 'match-1', version: 1, trigger: 'initial', startSeconds: 3, endSeconds: 12 },
    ]);
    await handleReclip(job);
    const cut = media.cutClip.mock.calls[0]![0] as { startSeconds: number };
    expect(cut.startSeconds).toBe(0);
  });

  it('re-evaluates the CURRENT version — a second Re-clip refines the first, not the original', async () => {
    repos.listVersions.mockResolvedValue([
      { matchId: 'match-1', version: 1, trigger: 'initial', startSeconds: 130, endSeconds: 150 },
      { matchId: 'match-1', version: 2, trigger: 'reclip', startSeconds: 200, endSeconds: 220 },
    ]);
    await handleReclip(job);
    const cut = media.cutClip.mock.calls[0]![0] as { startSeconds: number; endSeconds: number };
    expect(cut.startSeconds).toBe(200 - env.RECLIP_CONTEXT_BEFORE_SECONDS);
    expect(cut.endSeconds).toBe(220 + env.RECLIP_CONTEXT_AFTER_SECONDS);
  });

  it('maps the answer from window time to source time and appends the next version', async () => {
    await handleReclip(job);

    // Window starts at 120; 8.0s and 31.0s in the window are 128 and 151.
    expect(repos.appendReclipVersion).toHaveBeenCalledWith({
      matchId: 'match-1',
      startSeconds: 128,
      endSeconds: 151,
      provider: 'modal',
      model: 'openbmb/MiniCPM-V-4.6',
      promptVersion: 'reclip-v1',
    });
    expect(repos.clearReclipPending).toHaveBeenCalledWith('match-1');
    expect(repos.markReclipFailed).not.toHaveBeenCalled();
  });

  it('records the call under the reclip stage with the answering model', async () => {
    askVideoModel.mockImplementation(async (input: { onUsage?: (usage: unknown) => void }) => {
      input.onUsage?.({ provider: 'modal', model: 'openbmb/MiniCPM-V-4.6', promptTokens: 1, completionTokens: 1, totalTokens: 2, costUsd: null, latencyMs: 5 });
      return {
        content: '{"start_seconds":8.0,"end_seconds":31.0}',
        provider: 'modal',
        model: 'openbmb/MiniCPM-V-4.6',
        promptVersion: 'reclip-v1',
        reasoningDisabled: false,
      };
    });
    await handleReclip(job);
    expect(repos.recordModelUsage).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'reclip', videoId: 'video-1', clipRequestId: 'request-1' }),
    );
  });

  it('refuses an answer that wandered to a different moment — nothing changes', async () => {
    // Window is 120..160; this answer (0.5s..4s → 120.5..124) never overlaps
    // the original 130..150.
    askVideoModel.mockResolvedValue({
      content: '{"start_seconds":0.5,"end_seconds":4.0}',
      provider: 'modal',
      model: 'x',
      promptVersion: 'v',
      reasoningDisabled: false,
    });
    await handleReclip(job);
    expect(repos.appendReclipVersion).not.toHaveBeenCalled();
    expect(repos.markReclipFailed).toHaveBeenCalledWith('match-1', expect.stringContaining('different moment'));
  });

  it('refuses an unusable answer without inventing boundaries', async () => {
    askVideoModel.mockResolvedValue({ content: 'I think the clip is great!', provider: 'x', model: 'y', promptVersion: 'z', reasoningDisabled: false });
    await handleReclip(job);
    expect(repos.appendReclipVersion).not.toHaveBeenCalled();
    expect(repos.markReclipFailed).toHaveBeenCalledWith('match-1', expect.stringContaining('usable boundaries'));
  });

  it('enforces the per-moment ceiling before spending any GPU time', async () => {
    repos.countReclips.mockResolvedValue(env.MAX_RECLIPS_PER_MOMENT);
    await handleReclip(job);
    expect(askVideoModel).not.toHaveBeenCalled();
    expect(repos.markReclipFailed).toHaveBeenCalledWith('match-1', expect.stringContaining('limit'));
  });

  it('re-cuts an existing ready clip through the atomic claim, then records the version', async () => {
    repos.getRootClipByMatchId.mockResolvedValue({ id: 'clip-1', startSeconds: 130, endSeconds: 150, boundariesEditedAt: null });
    repos.setClipBoundaries.mockResolvedValue({ id: 'clip-1' });
    await handleReclip(job);
    expect(repos.setClipBoundaries).toHaveBeenCalledWith('clip-1', 128, 151);
    expect(enqueueClipGeneration).toHaveBeenCalledWith({ clipId: 'clip-1' });
    expect(repos.appendReclipVersion).toHaveBeenCalled();
  });

  it('a lost clip claim fails the Re-clip with the original untouched — no version, no render', async () => {
    repos.getRootClipByMatchId.mockResolvedValue({ id: 'clip-1', startSeconds: 130, endSeconds: 150, boundariesEditedAt: null });
    repos.setClipBoundaries.mockResolvedValue(null);
    await handleReclip(job);
    expect(enqueueClipGeneration).not.toHaveBeenCalled();
    expect(repos.appendReclipVersion).not.toHaveBeenCalled();
    expect(repos.markReclipFailed).toHaveBeenCalledWith('match-1', expect.stringContaining('busy rendering'));
  });

  it('a failed render enqueue restores the clip exactly and reports failure', async () => {
    repos.getRootClipByMatchId.mockResolvedValue({ id: 'clip-1', startSeconds: 130, endSeconds: 150, boundariesEditedAt: null });
    repos.setClipBoundaries.mockResolvedValue({ id: 'clip-1' });
    enqueueClipGeneration.mockRejectedValue(new Error('redis down'));
    await handleReclip(job);
    expect(repos.restoreClipBoundaries).toHaveBeenCalledWith('clip-1', {
      startSeconds: 130,
      endSeconds: 150,
      boundariesEditedAt: null,
    });
    expect(repos.appendReclipVersion).not.toHaveBeenCalled();
    expect(repos.markReclipFailed).toHaveBeenCalled();
  });

  it('footage already swept means a visible refusal, not a crash loop', async () => {
    repos.getVideo.mockResolvedValue({ id: 'video-1', proxyStorageKey: null, durationSeconds: 600 });
    await handleReclip(job);
    expect(askVideoModel).not.toHaveBeenCalled();
    expect(repos.markReclipFailed).toHaveBeenCalledWith('match-1', expect.stringContaining('no longer stored'));
  });

  it('cleans up the temporary window object it uploaded', async () => {
    await handleReclip(job);
    expect(storage.remove).toHaveBeenCalledWith(expect.stringContaining('reclip/match-1'));
  });
});
