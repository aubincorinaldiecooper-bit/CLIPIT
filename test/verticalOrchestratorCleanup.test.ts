import { beforeEach, describe, expect, it, vi } from 'vitest';

const uploaded: string[] = [];
const removed: string[] = [];

const uploadFile = vi.fn(async (key: string) => { uploaded.push(key); });
const remove = vi.fn(async (key: string) => { removed.push(key); });

vi.mock('../src/services/storage/s3.js', () => ({
  getStorage: () => ({ uploadFile, remove }),
}));

const renderVerticalDerivative = vi.fn(async () => ({
  width: 1080,
  height: 1920,
  durationSeconds: 20,
  sizeBytes: 5_000,
}));
const extractFrameAt = vi.fn(async () => true);
const ffprobe = vi.fn(async () => ({ width: 1920, height: 1080, durationSeconds: 20 }));
const cutClip = vi.fn(async () => ({ durationSeconds: 20, sizeBytes: 5_000 }));

vi.mock('../src/services/media/ffmpeg.js', () => ({
  renderVerticalDerivative,
  extractFrameAt,
  ffprobe,
  cutClip,
}));

const upsertClipForMatch = vi.fn(async () => ({
  id: 'clip-1',
  status: 'pending',
  storageKey: null,
  derivativeStatus: null,
  derivativeStorageKey: null,
  posterStorageKey: null,
}));
const setClipStatus = vi.fn(async () => undefined);
vi.mock('../src/db/repositories/clips.js', () => ({
  upsertClipForMatch,
  setClipStatus,
}));

const setVerticalMedia = vi.fn(async () => undefined);
const markVerticalFailed = vi.fn(async () => undefined);
vi.mock('../src/db/repositories/verticalMedia.js', () => ({
  setVerticalMedia,
  markVerticalFailed,
}));

const markAttemptsRecovered = vi.fn(async () => undefined);
const recordVerticalRenderAttempt = vi.fn(async () => undefined);
vi.mock('../src/db/repositories/verticalRenders.js', () => ({
  markAttemptsRecovered,
  recordVerticalRenderAttempt,
}));

const recordModelUsage = vi.fn(async () => undefined);
vi.mock('../src/db/repositories/usage.js', () => ({
  recordModelUsage,
}));

const askVideoModel = vi.fn(async () => ({
  content: JSON.stringify({ mode: 'smart_crop', focal_x: 0.5, focal_y: 0.5, crop_safe: true }),
  provider: 'modal',
  model: 'openbmb/MiniCPM-V-4.6',
}));
const videoPartFromFile = vi.fn(async () => ({
  part: { type: 'video_url', video_url: { url: 'data:video/mp4;base64,test' } },
  bytes: 5_000,
}));
vi.mock('../src/services/search/openrouterVideo.js', () => ({
  askVideoModel,
  videoPartFromFile,
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { orchestrateVerticalDeck } =
  await import('../src/services/media/verticalOrchestrator.js');
const { resolvePlatformIntent } =
  await import('../src/services/search/platformIntent.js');
const { UsageTally } =
  await import('../src/services/usageTally.js');

beforeEach(() => {
  uploaded.length = 0;
  removed.length = 0;
  vi.clearAllMocks();
  renderVerticalDerivative.mockResolvedValue({
    width: 1080,
    height: 1920,
    durationSeconds: 20,
    sizeBytes: 5_000,
  });
  extractFrameAt.mockResolvedValue(true);
  ffprobe.mockResolvedValue({ width: 1920, height: 1080, durationSeconds: 20 });
  cutClip.mockResolvedValue({ durationSeconds: 20, sizeBytes: 5_000 });
  upsertClipForMatch.mockResolvedValue({
    id: 'clip-1',
    status: 'pending',
    storageKey: null,
    derivativeStatus: null,
    derivativeStorageKey: null,
    posterStorageKey: null,
  });
  setVerticalMedia.mockResolvedValue(undefined);
  askVideoModel.mockResolvedValue({
    content: JSON.stringify({ mode: 'smart_crop', focal_x: 0.5, focal_y: 0.5, crop_safe: true }),
    provider: 'modal',
    model: 'openbmb/MiniCPM-V-4.6',
  });
  videoPartFromFile.mockResolvedValue({
    part: { type: 'video_url', video_url: { url: 'data:video/mp4;base64,test' } },
    bytes: 5_000,
  });
});

describe('the orchestrator cleans up when media persistence fails', () => {
  it('removes both post-ready objects and returns a failed candidate', async () => {
    setVerticalMedia.mockRejectedValueOnce(new Error('database refused the media row'));

    const result = await orchestrateVerticalDeck({
      videoId: 'video-1',
      clipRequestId: 'request-1',
      sessionId: null,
      userId: null,
      workspaceId: null,
      sourcePath: '/tmp/source.mp4',
      workDir: '/tmp',
      hasAudio: true,
      videoDurationSeconds: 20,
      intent: resolvePlatformIntent('find a moment to post on TikTok', 90),
      requestedResultCount: 1,
      effectiveDeckTarget: 1,
      candidates: [{
        matchId: 'match-1',
        confidence: 0.9,
        startSeconds: 0,
        endSeconds: 20,
        derivativeStatus: 'pending',
        derivativeStorageKey: null,
        posterStorageKey: null,
      }],
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      } as any,
      tally: new UsageTally(),
    });

    expect(result.outcome.complete).toBe(false);
    expect(result.outcome.deck).toEqual([]);
    expect(result.outcome.failed).toHaveLength(1);
    expect(result.outcome.failed[0]?.derivativeStatus).toBe('failed');
    expect(removed).toEqual(['clips/video-1/clip-1-vertical.mp4', 'posters/video-1/clip-1.jpg']);
  });
});
