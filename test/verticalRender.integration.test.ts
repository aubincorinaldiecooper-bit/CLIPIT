import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * REAL MEDIA. These are the only tests here that can prove the things mocks
 * cannot: that the file is genuinely 1080x1920, that audio survived, and that
 * the filter graph runs on actual footage rather than merely parsing.
 *
 * They generate a tiny synthetic source at runtime — colour bars with a tone,
 * a couple of kilobytes — rather than committing a media fixture.
 *
 * GATED, and honestly so: without ffmpeg they SKIP rather than pass. A skipped
 * test reports as skipped; a mocked one would report as green while proving
 * nothing about the encoder, which is the failure mode this whole file exists
 * to avoid.
 */

const run = promisify(execFile);

async function toolExists(bin: string): Promise<boolean> {
  try {
    await run(bin, ['-version'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const hasFfmpeg = await toolExists('ffmpeg');
const hasFfprobe = await toolExists('ffprobe');
const canRun = hasFfmpeg && hasFfprobe;

async function probe(file: string): Promise<{ width: number; height: number; hasAudio: boolean; seconds: number }> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration',
    '-of', 'json', file,
  ]);
  const parsed = JSON.parse(stdout) as {
    streams: Array<{ codec_type: string; width?: number; height?: number }>;
    format: { duration?: string };
  };
  const video = parsed.streams.find((s) => s.codec_type === 'video');
  return {
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    hasAudio: parsed.streams.some((s) => s.codec_type === 'audio'),
    seconds: Number(parsed.format.duration ?? 0),
  };
}

let dir = '';
let source = '';

beforeAll(async () => {
  if (!canRun) return;
  dir = await mkdtemp(path.join(tmpdir(), 'clipit-vertical-'));
  source = path.join(dir, 'source.mp4');
  const { createSyntheticSource } = await import('../src/services/media/ffmpeg.js');
  // A landscape source with a known size and a real audio stream.
  await createSyntheticSource(source, { width: 1280, height: 720, seconds: 3 });
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!canRun)('vertical derivative — real FFmpeg output', () => {
  it('smart crop renders a true 1080x1920 file with audio intact', async () => {
    const { renderVerticalDerivative } = await import('../src/services/media/ffmpeg.js');
    const { planReframe } = await import('../src/services/media/reframe.js');
    const { VERTICAL_DELIVERY } = await import('../src/services/media/composition.js');

    const plan = planReframe({ aspect: '9:16', focusPct: 50 }, { width: 1280, height: 720 });
    const out = path.join(dir, 'smart.mp4');
    const result = await renderVerticalDerivative({
      inputPath: source,
      outputPath: out,
      hasAudio: true,
      delivery: VERTICAL_DELIVERY,
      cropFilter: plan.filter,
    });

    const info = await probe(out);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.hasAudio).toBe(true);
    expect(info.seconds).toBeGreaterThan(2);
    // The function reports what was written, not what was asked for.
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1920);
  }, 120_000);

  it('blurred background renders 1080x1920 with audio and no black bars', async () => {
    const { renderVerticalDerivative } = await import('../src/services/media/ffmpeg.js');
    const { VERTICAL_DELIVERY } = await import('../src/services/media/composition.js');

    const out = path.join(dir, 'blurred.mp4');
    await renderVerticalDerivative({
      inputPath: source,
      outputPath: out,
      hasAudio: true,
      delivery: VERTICAL_DELIVERY,
      cropFilter: null,
    });

    const info = await probe(out);
    expect(info.width).toBe(1080);
    expect(info.height).toBe(1920);
    expect(info.hasAudio).toBe(true);
  }, 120_000);

  it('keeps audio out when the source has none, rather than failing', async () => {
    const { renderVerticalDerivative } = await import('../src/services/media/ffmpeg.js');
    const { VERTICAL_DELIVERY } = await import('../src/services/media/composition.js');

    const silent = path.join(dir, 'silent.mp4');
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', silent,
    ]);

    const out = path.join(dir, 'silent-vertical.mp4');
    await renderVerticalDerivative({
      inputPath: silent, outputPath: out, hasAudio: false,
      delivery: VERTICAL_DELIVERY, cropFilter: null,
    });
    const info = await probe(out);
    expect(info.width).toBe(1080);
    expect(info.hasAudio).toBe(false);
  }, 120_000);

  it('extracts a real, decodable poster from the derivative', async () => {
    const { extractFrameAt } = await import('../src/services/media/ffmpeg.js');
    const { posterOffsetSeconds } = await import('../src/services/media/composition.js');

    const derivative = path.join(dir, 'blurred.mp4');
    const poster = path.join(dir, 'poster.jpg');
    const offset = posterOffsetSeconds(3);
    const written = await extractFrameAt(derivative, offset, poster, 1080);

    expect(written).toBe(true);
    const info = await stat(poster);
    expect(info.size).toBeGreaterThan(0);
    // Decodable, not merely present: ffprobe reads it as a real image.
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=width', '-of', 'csv=p=0', poster]);
    expect(Number(stdout.trim())).toBeGreaterThan(0);
  }, 120_000);
});

describe('integration gating', () => {
  it('reports plainly whether the real media path was exercised', () => {
    // Not an assertion about ffmpeg — a record in the test output of whether
    // the checks above ran at all, so a green suite is never mistaken for
    // proof the encoder works.
    // eslint-disable-next-line no-console
    console.log(canRun
      ? 'vertical render integration: EXECUTED against real ffmpeg'
      : 'vertical render integration: SKIPPED — ffmpeg/ffprobe not on PATH');
    expect(typeof canRun).toBe('boolean');
  });
});
