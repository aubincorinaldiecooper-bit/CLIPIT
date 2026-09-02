import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/lib/exec.js';

/**
 * The finishing step for a moment whose deliverable is the canonical cut:
 * a poster from inside the cut, stored under the clip's poster key. Runs the
 * real ffmpeg on a synthetic clip; storage is a recording stub.
 */

const uploaded: Array<{ key: string; path: string; contentType: string }> = [];
const removed: string[] = [];
const uploadFile = vi.fn(async (key: string, filePath: string, contentType: string) => {
  uploaded.push({ key, path: filePath, contentType });
});
const remove = vi.fn(async (key: string) => { removed.push(key); });

vi.mock('../src/services/storage/s3.js', () => ({
  getStorage: () => ({ uploadFile, remove }),
}));

vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

const { runOriginalPipeline, VerticalPipelineFailure } =
  await import('../src/services/media/verticalPipeline.js');
const { ffprobe } = await import('../src/services/media/ffmpeg.js');

const ffmpegAvailable = await run('ffmpeg', ['-version'], { timeoutMs: 15_000 }).then(
  () => true,
  () => false,
);

const dir = path.join('/tmp', `clipit-original-pipeline-${process.pid}`);
const canonical = path.join(dir, 'canonical.mp4');
const CLIP_SECONDS = 4;

const input = () => ({
  videoId: 'video-1',
  clipId: 'clip-1',
  canonicalPath: canonical,
  workDir: dir,
  durationSeconds: CLIP_SECONDS,
  width: 640,
  height: 360,
});

describe.skipIf(!ffmpegAvailable)('finishing an original-framing moment', () => {
  beforeAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=15:duration=${CLIP_SECONDS}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      canonical,
    ], { timeoutMs: 60_000 });
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    uploaded.length = 0;
    removed.length = 0;
    vi.clearAllMocks();
    uploadFile.mockImplementation(async (key: string, filePath: string, contentType: string) => {
      uploaded.push({ key, path: filePath, contentType });
    });
  });

  it('takes the poster from inside the cut, at the cut\'s own size, under the clip\'s poster key', async () => {
    const result = await runOriginalPipeline(input());

    expect(result.posterStorageKey).toBe('posters/video-1/clip-1.jpg');
    expect(result.posterTimestampSeconds).toBeGreaterThan(0);
    expect(result.posterTimestampSeconds).toBeLessThan(CLIP_SECONDS);
    expect(result.sourceAspectRatio).toBe('16:9');
    expect(result.sourceWidth).toBe(640);

    expect(uploaded.map((entry) => entry.key)).toEqual(['posters/video-1/clip-1.jpg']);
    expect(uploaded[0]!.contentType).toBe('image/jpeg');
    expect((await stat(uploaded[0]!.path)).size).toBeGreaterThan(0);
    // Not scaled down: the card's picture is the cut's own size.
    const probe = await ffprobe(uploaded[0]!.path);
    expect(probe.width).toBe(640);
    expect(probe.height).toBe(360);
    expect(removed).toEqual([]);
  });

  it('names storage as the stage when the poster cannot be stored, and takes back what it made', async () => {
    uploadFile.mockRejectedValueOnce(new Error('bucket refused'));

    await expect(runOriginalPipeline(input())).rejects.toMatchObject({
      stage: 'storage_upload',
      code: 'poster_upload_failed',
    });
    // Nothing owned it before this attempt, so the object is removed.
    expect(removed).toEqual(['posters/video-1/clip-1.jpg']);
  });

  it('leaves a poster an earlier run already owns alone when its re-upload fails', async () => {
    uploadFile.mockRejectedValueOnce(new Error('bucket refused'));

    await expect(runOriginalPipeline({
      ...input(),
      snapshotPosterKey: 'posters/video-1/clip-1.jpg',
      currentPosterKey: async () => 'posters/video-1/clip-1.jpg',
    })).rejects.toMatchObject({ code: 'poster_upload_failed' });
    expect(removed).toEqual([]);
  });

  it('writes a re-render\'s poster beside the first one, never over it', async () => {
    const result = await runOriginalPipeline({ ...input(), render: 'r7' });
    expect(result.posterStorageKey).toBe('posters/video-1/clip-1-r7.jpg');
    expect(uploaded.map((entry) => entry.key)).toEqual(['posters/video-1/clip-1-r7.jpg']);
  });

  it('refuses a cut with no usable size before touching ffmpeg or storage', async () => {
    await expect(runOriginalPipeline({ ...input(), width: 0, height: 0 })).rejects.toBeInstanceOf(VerticalPipelineFailure);
    expect(uploaded).toEqual([]);
  });
});
