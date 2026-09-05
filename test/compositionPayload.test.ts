import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The framing call must never be handed the delivery file.
 *
 * On 2026-09-01 production sent the full-quality canonical clip inline to the
 * OpenRouter lane: ~20MB of 1080p, ~27MB once base64-encoded. The provider
 * refused all three candidates with a 413 before looking at a frame, and each
 * one silently fell back to the safe composition — a deck of TikToks framed by
 * nothing that had watched them. These tests pin the rule rather than that
 * single symptom: whatever the framing call sends, it is not the file the
 * creator downloads.
 *
 * The call now happens on Keep, from the render job, rather than for every
 * moment a search finds. The rule is the same.
 */

const removedFiles: string[] = [];
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rm: vi.fn(async (target: string) => { removedFiles.push(target); }),
    stat: vi.fn(async () => ({ size: 20_000_000 })),
  };
});

const uploadFile = vi.fn(async () => {});
const remove = vi.fn(async () => {});
vi.mock('../src/services/storage/s3.js', () => ({ getStorage: () => ({ uploadFile, remove }) }));

const renderVerticalDerivative = vi.fn(async () => ({
  width: 1080, height: 1920, durationSeconds: 20, sizeBytes: 5_000,
}));
const extractFrameAt = vi.fn(async () => true);
const ffprobe = vi.fn(async () => ({ width: 1920, height: 1080, durationSeconds: 20 }));
const createAnalysisProxy = vi.fn(async () => {});
vi.mock('../src/services/media/ffmpeg.js', () => ({
  renderVerticalDerivative, extractFrameAt, ffprobe, createAnalysisProxy,
}));

vi.mock('../src/db/repositories/clips.js', () => ({
  getClip: vi.fn(async () => ({ id: 'clip-1', derivativeStorageKey: null, posterStorageKey: null })),
}));
vi.mock('../src/db/repositories/usage.js', () => ({ recordModelUsage: vi.fn(async () => undefined) }));
vi.mock('../src/queues/index.js', () => ({ enqueueObjectRelease: vi.fn(async () => undefined) }));

const askVideoModel = vi.fn(async () => ({
  content: JSON.stringify({ composition_mode: 'smart_crop', focal_x: 0.5, focal_y: 0.4, crop_safe: true }),
  provider: 'openrouter', model: 'qwen/qwen3.6-flash',
}));
/** Stands in for real base64: reports what the REAL encoder would have produced. */
const videoPartFromFile = vi.fn(async (filePath: string) => ({
  part: { type: 'video_url', video_url: { url: 'data:video/mp4;base64,test' } },
  // The delivery file is 20MB; the 360p proxy the search lane uses is ~400KB.
  bytes: filePath.includes('composition-') ? 400_000 : 20_000_000,
}));
vi.mock('../src/services/search/openrouterVideo.js', () => ({ askVideoModel, videoPartFromFile }));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { renderDeliveredMedia } = await import('../src/services/media/rerender.js');

const WORK_DIR = '/tmp/render-work';
/** What the render job names the delivery clip: <workDir>/<clipId>.mp4 */
const DELIVERY_PATH = `${WORK_DIR}/clip-1.mp4`;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

/** A moment being rendered for the first time: nothing has been cut for it before. */
const firstRender = {
  id: 'clip-1',
  videoId: 'video-1',
  clipMatchId: 'match-1',
  storageKey: null,
  derivativeStorageKey: null,
  posterStorageKey: null,
  compositionMode: null,
  focalX: null,
  focalY: null,
  preRendered: false,
  presentation: null,
  retentionClass: 'owned',
} as any;

async function renderOnce(clip = firstRender) {
  return renderDeliveredMedia({
    clip,
    videoId: 'video-1',
    clipRequestId: 'request-1',
    canonicalPath: DELIVERY_PATH,
    canonicalKey: 'clips/video-1/clip-1.mp4',
    workDir: WORK_DIR,
    hasAudio: true,
    cut: { durationSeconds: 20, width: 1920, height: 1080 },
    render: undefined,
    log,
  });
}

beforeEach(() => { vi.clearAllMocks(); removedFiles.length = 0; });

describe('what the framing call is allowed to send', () => {
  it('sends a downscaled proxy, never the delivery clip', async () => {
    await renderOnce();

    expect(createAnalysisProxy).toHaveBeenCalledTimes(1);
    const [source, proxyPath] = createAnalysisProxy.mock.calls[0] as unknown as [string, string];
    expect(source).toBe(DELIVERY_PATH);
    expect(proxyPath).toContain(WORK_DIR);

    // The rule, stated directly: the encoder saw the proxy and not the file
    // the creator downloads.
    expect(videoPartFromFile).toHaveBeenCalledWith(proxyPath);
    expect(videoPartFromFile).not.toHaveBeenCalledWith(DELIVERY_PATH);
  });

  it('keeps the payload under what a provider will accept', async () => {
    await renderOnce();

    const sent = askVideoModel.mock.calls[0]?.[0] as unknown as { videoBytes: number };
    // The 413 came back at ~11.7MB of payload. 10MB is the limit this must
    // stay clear of, with base64 counted in.
    expect(sent.videoBytes * 1.34).toBeLessThan(10_000_000);
    expect(sent.videoBytes).toBeLessThan(20_000_000);
  });

  it('asks the model on a first render, and the decision reaches the row', async () => {
    const delivered = await renderOnce();

    expect(askVideoModel).toHaveBeenCalledTimes(1);
    expect(delivered.media.kind).toBe('vertical');
    if (delivered.media.kind !== 'vertical') throw new Error('unreachable');
    // The crop is the model's and not the fallback the 413s were producing.
    expect(delivered.media.media.compositionMode).toBe('smart_crop');
    expect(delivered.media.media.focalX).toBe(0.5);
    expect(delivered.framing.provider).toBe('openrouter');
  });

  it('does not ask again on a re-render — the first render\'s decision is reused', async () => {
    const delivered = await renderOnce({
      ...firstRender,
      storageKey: 'clips/video-1/clip-1.mp4',
      compositionMode: 'smart_crop',
      focalX: 0.7,
      focalY: 0.3,
    });

    expect(askVideoModel).not.toHaveBeenCalled();
    expect(createAnalysisProxy).not.toHaveBeenCalled();
    if (delivered.media.kind !== 'vertical') throw new Error('unreachable');
    expect(delivered.media.media.focalX).toBe(0.7);
  });
});

describe('the proxy never outlives the call that needed it', () => {
  it('deletes it after a successful framing call', async () => {
    await renderOnce();

    const [, proxyPath] = createAnalysisProxy.mock.calls[0] as unknown as [string, string];
    expect(removedFiles).toContain(proxyPath);
  });

  it('deletes it when the encode fails', async () => {
    videoPartFromFile.mockRejectedValueOnce(new Error('could not read the proxy'));

    // The framing failure is caught by the pipeline (safe composition), so
    // nothing else would ever come back for this file.
    await renderOnce();

    const [, proxyPath] = createAnalysisProxy.mock.calls[0] as unknown as [string, string];
    expect(removedFiles).toContain(proxyPath);
  });

  it('deletes the half-written file when ffmpeg fails', async () => {
    createAnalysisProxy.mockRejectedValueOnce(new Error('ffmpeg died mid-write'));

    await renderOnce();

    // Named before ffmpeg ran, so whatever it managed to write is still
    // removed by name.
    const [, proxyPath] = createAnalysisProxy.mock.calls[0] as unknown as [string, string];
    expect(removedFiles).toContain(proxyPath);
  });
});
