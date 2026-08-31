import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every object this pipeline uploads must end up either referenced by its clip
 * row, or deleted before the failure is reported. Nothing in between.
 *
 * The in-between state is not hypothetical and it is not self-healing. The
 * derivative uploads, the poster then fails, and a multi-megabyte object sits
 * in storage with its key recorded nowhere. The retention sweep cannot reach
 * it — that sweep works from keys ON clip rows, and this key never got to one.
 * An object nothing references is an object nothing will ever collect, and it
 * is billed monthly, forever.
 *
 * These three tests are the three ways to reach that state.
 */

const uploaded: string[] = [];
const removed: string[] = [];
let removeThrows = false;

const uploadFile = vi.fn(async (key: string) => { uploaded.push(key); });
const remove = vi.fn(async (key: string) => {
  if (removeThrows) throw new Error('bucket refused the delete');
  removed.push(key);
});

vi.mock('../src/services/storage/s3.js', () => ({
  getStorage: () => ({ uploadFile, remove }),
}));

// The encoder is not what these tests are about; each one fails a specific
// step and asserts what happened to the bytes already in storage.
const renderVerticalDerivative = vi.fn(async () => ({ width: 1080, height: 1920, durationSeconds: 20, sizeBytes: 5_000 }));
const extractFrameAt = vi.fn(async () => true);
const ffprobe = vi.fn(async () => ({ width: 1920, height: 1080, durationSeconds: 20 }));

vi.mock('../src/services/media/ffmpeg.js', () => ({
  renderVerticalDerivative,
  extractFrameAt,
  ffprobe,
}));

const errorLog = vi.fn();
vi.mock('../src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: errorLog, debug: vi.fn(), child: () => ({ info: vi.fn(), warn: vi.fn(), error: errorLog }) },
}));

const { runVerticalPipeline, VerticalPipelineFailure, discardUploadedObjects } =
  await import('../src/services/media/verticalPipeline.js');

const input = {
  videoId: 'video-1',
  clipId: 'clip-1',
  canonicalPath: '/tmp/clip-1.mp4',
  workDir: '/tmp',
  hasAudio: true,
  // Answers with a safe crop so the pipeline takes its normal path.
  askComposition: async () => ({
    content: JSON.stringify({ mode: 'smart_crop', focal_x: 0.5, focal_y: 0.5, crop_safe: true }),
    provider: 'modal',
    model: 'openbmb/MiniCPM-V-4.6',
  }),
};

beforeEach(() => {
  uploaded.length = 0;
  removed.length = 0;
  removeThrows = false;
  vi.clearAllMocks();
  renderVerticalDerivative.mockResolvedValue({ width: 1080, height: 1920, durationSeconds: 20, sizeBytes: 5_000 });
  extractFrameAt.mockResolvedValue(true);
  ffprobe.mockResolvedValue({ width: 1920, height: 1080, durationSeconds: 20 });
});

describe('a derivative already in storage when a later step fails', () => {
  it('takes the derivative back out when poster GENERATION throws', async () => {
    extractFrameAt.mockRejectedValueOnce(new Error('ffmpeg died'));

    await expect(runVerticalPipeline(input)).rejects.toThrow(VerticalPipelineFailure);

    expect(uploaded).toHaveLength(1);
    // The exact object that was uploaded is the exact object deleted.
    expect(removed).toEqual(uploaded);
  });

  /**
   * The quieter version: ffmpeg exits 0 but writes no file, because the seek
   * landed past the last decodable frame. Nothing threw, and the derivative
   * would still be stranded.
   */
  it('takes the derivative back out when the poster extracts to nothing', async () => {
    extractFrameAt.mockResolvedValueOnce(false);

    await expect(runVerticalPipeline(input)).rejects.toThrow(/extracted to nothing/);
    expect(removed).toEqual(uploaded);
  });

  /**
   * A rejected upload does not prove the object is absent.
   *
   * The PUT can reach the bucket and store the object while the response is
   * lost coming back — a timeout, a reset connection. Cleaning up only what
   * we saw succeed would leave exactly the unreferenced file this block
   * exists to prevent, and it would happen precisely when the network is
   * already misbehaving. So once an upload has been ATTEMPTED its key is
   * cleaned up regardless; deleting a key that was never written is harmless.
   */
  it('removes the poster key too when its upload failed but may have landed', async () => {
    // First upload (derivative) succeeds; the second (poster) rejects.
    uploadFile.mockImplementationOnce(async (key: string) => { uploaded.push(key); });
    uploadFile.mockImplementationOnce(async () => { throw new Error('connection reset'); });

    await expect(runVerticalPipeline(input)).rejects.toThrow(/could not be stored/);

    // Only the derivative is known to have landed...
    expect(uploaded).toHaveLength(1);
    // ...but BOTH keys are cleaned up, because the poster's fate is unknown.
    expect(removed).toHaveLength(2);
    expect(removed[0]).toContain('vertical');
    expect(removed[1]).toContain('poster');
  });

  /**
   * Cleanup is best-effort — it must never mask the original failure — but it
   * is never silent. If the delete fails there really is an orphan, and this
   * log line is the only thing that will ever name it.
   */
  it('reports an orphan loudly when the cleanup delete itself fails', async () => {
    extractFrameAt.mockRejectedValueOnce(new Error('ffmpeg died'));
    removeThrows = true;

    // The ORIGINAL failure still surfaces — cleanup does not replace it.
    await expect(runVerticalPipeline(input)).rejects.toThrow(VerticalPipelineFailure);

    expect(errorLog).toHaveBeenCalled();
    const [message, context] = errorLog.mock.calls.at(-1)!;
    expect(String(message)).toMatch(/orphan/i);
    expect(context).toMatchObject({ videoId: 'video-1', clipId: 'clip-1' });
    // The key is named, because it is now the only way to find the object.
    expect(String((context as { storageKey: string }).storageKey)).toContain('clip-1');
  });
});

describe('the third path: both objects stored, the row that names them fails', () => {
  /**
   * The least obvious leak, and the one the pipeline itself cannot see. The
   * media is finished and correct; persistence fails; the orchestrator is the
   * only place that knows both keys and that nothing recorded them.
   */
  it('discards both objects when persistence fails after upload', async () => {
    await discardUploadedObjects(
      ['vertical/clip-1.mp4', 'posters/clip-1.jpg'],
      { videoId: 'video-1', clipId: 'clip-1', reason: 'persist_failed' },
    );
    expect(removed).toEqual(['vertical/clip-1.mp4', 'posters/clip-1.jpg']);
  });

  it('skips absent keys rather than deleting nothing loudly', async () => {
    await discardUploadedObjects([null, undefined, ''], { videoId: 'v', clipId: 'c', reason: 'none' });
    expect(remove).not.toHaveBeenCalled();
  });
});
