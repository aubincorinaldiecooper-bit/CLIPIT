import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../src/lib/exec.js';
import {
  createAnalysisProxy,
  cutClip,
  extractAudioSegments,
  extractFrameAt,
  ffprobe,
  splitIntoChunks,
} from '../src/services/media/ffmpeg.js';
import { mapLocalRangeToGlobal } from '../src/services/timestamps.js';
import { prepareCaptionFilters } from '../src/services/media/captions.js';

/**
 * Exercises the real ffmpeg pipeline. Skipped when ffmpeg is not installed, so
 * `npm test` still runs on a bare machine; it always runs inside the Docker
 * image, where ffmpeg is guaranteed.
 */

const ffmpegAvailable = await run('ffmpeg', ['-version'], { timeoutMs: 15_000 }).then(
  () => true,
  () => false,
);

const dir = path.join('/tmp', `clipit-media-test-${process.pid}`);
const source = path.join(dir, 'source.mp4');
const SOURCE_SECONDS = 12;
const CHUNK_SECONDS = 3;

describe.skipIf(!ffmpegAvailable)('ffmpeg media pipeline', () => {
  beforeAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=15:duration=${SOURCE_SECONDS}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:duration=${SOURCE_SECONDS}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest', source,
    ]);
  }, 120_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('probes duration, dimensions and codecs', async () => {
    const probe = await ffprobe(source);

    expect(probe.durationSeconds).toBeCloseTo(SOURCE_SECONDS, 0);
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(240);
    expect(probe.videoCodec).toBe('h264');
    expect(probe.hasAudio).toBe(true);
  }, 60_000);

  it('splits the proxy into chunks of the requested length', async () => {
    // Regression guard: the segment muxer can only cut on a keyframe, and the
    // default GOP at the proxy framerate is longer than a whole chunk. Without
    // forced keyframes this returns ONE segment holding the entire video, which
    // would send a multi-hour VOD to the model in a single request.
    const proxy = path.join(dir, 'proxy.mp4');
    await createAnalysisProxy(source, proxy, CHUNK_SECONDS);

    const chunkDir = path.join(dir, 'chunks');
    await mkdir(chunkDir, { recursive: true });
    const segments = await splitIntoChunks(proxy, chunkDir, CHUNK_SECONDS);

    expect(segments.length).toBeGreaterThanOrEqual(Math.floor(SOURCE_SECONDS / CHUNK_SECONDS));

    for (const segment of segments) {
      expect(segment.durationSeconds).toBeLessThanOrEqual(CHUNK_SECONDS * 1.5);
    }

    // Contiguous, gap-free, and covering the source.
    for (const [index, segment] of segments.entries()) {
      const previous = segments[index - 1];
      if (previous) expect(segment.globalStartSeconds).toBeCloseTo(previous.globalEndSeconds, 3);
    }
    expect(segments[0]?.globalStartSeconds).toBe(0);
    expect(segments.at(-1)?.globalEndSeconds).toBeGreaterThanOrEqual(SOURCE_SECONDS - 1);
  }, 180_000);


  /**
   * A still stands in for a moment before its clip is cut, and both the search
   * and the backfill store the key only when a frame was really written. A
   * seek past the end exits 0 without producing a file, so a bare exit code
   * would attach a key to an object that does not exist — the picture would
   * 404 in the browser instead of simply being absent.
   */
  it('reports a still only when it actually wrote one', async () => {
    const stillDir = path.join(dir, 'stills');
    await mkdir(stillDir, { recursive: true });

    const inside = path.join(stillDir, 'inside.jpg');
    expect(await extractFrameAt(source, 4, inside)).toBe(true);
    expect((await stat(inside)).size).toBeGreaterThan(0);

    const past = path.join(stillDir, 'past.jpg');
    expect(await extractFrameAt(source, SOURCE_SECONDS + 30, past)).toBe(false);
  }, 120_000);

  it('reports audio piece offsets on the nominal grid', async () => {
    const audioDir = path.join(dir, 'audio');
    await mkdir(audioDir, { recursive: true });

    const pieces = await extractAudioSegments(source, audioDir, 5);

    expect(pieces.length).toBeGreaterThanOrEqual(2);
    // Offsets must not accumulate the encoder's per-piece padding.
    for (const [index, piece] of pieces.entries()) {
      expect(piece.globalStartSeconds).toBeCloseTo(index * 5, 3);
    }
  }, 120_000);

  it('cuts a mapped match out of the original as MP4/H.264/AAC', async () => {
    const chunk = { globalStartSeconds: 6, globalEndSeconds: 9 };
    const mapped = mapLocalRangeToGlobal(chunk, { startSeconds: 0.5, endSeconds: 2.5 })!;

    expect(mapped.globalStartSeconds).toBe(6.5);
    expect(mapped.globalEndSeconds).toBe(8.5);

    const output = path.join(dir, 'clip.mp4');
    const result = await cutClip({
      inputPath: source,
      outputPath: output,
      startSeconds: mapped.globalStartSeconds,
      endSeconds: mapped.globalEndSeconds,
      hasAudio: true,
    });

    const probe = await ffprobe(output);

    expect(probe.videoCodec).toBe('h264');
    expect(probe.audioCodec).toBe('aac');
    expect(probe.formatName).toContain('mp4');
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.durationSeconds).toBeCloseTo(2, 0);
  }, 180_000);
  it('burns captions into a cut without breaking the encode', async () => {
    const probe = await ffprobe(source);
    const filters = await prepareCaptionFilters(
      [
        // %{gmtime} is the reason expansion is off: with drawtext's default
        // expansion it would burn the server's clock into a user's video.
        { text: "It's 100%{gmtime} live: rain & confetti", font: 'bold', sizePct: 8, color: '#fcd34d', yPct: 85, xPct: 50, outline: true },
        { text: 'colons: quotes\' and, commas — plus a line long enough that it must wrap onto a second line to stay inside the frame', font: 'mono', sizePct: 5, color: '#ffffff', yPct: 10, xPct: 50, outline: false },
      ],
      dir,
      { videoWidth: probe.width ?? 320, videoHeight: probe.height ?? 240 },
    );
    // The long mono caption wraps: more filters than captions.
    expect(filters.length).toBeGreaterThan(2);
    expect(filters.every((filter) => filter.includes('expansion=none'))).toBe(true);

    const output = path.join(dir, 'captioned.mp4');
    const result = await cutClip({
      inputPath: source,
      outputPath: output,
      startSeconds: 1,
      endSeconds: 4,
      hasAudio: true,
      videoFilters: filters,
    });

    // The encode survived text that exists to trip drawtext escaping, and
    // produced a playable H.264 file of the requested length.
    expect(result.durationSeconds).toBeCloseTo(3, 0);
    const out = await ffprobe(output);
    expect(out.videoCodec).toBe('h264');
    expect((await stat(output)).size).toBeGreaterThan(1000);
  }, 120_000);

  /**
   * Dragging a caption sideways has to move the pixels, not just the spec.
   * This burns the same word at two positions onto a black frame and reads
   * the rendered frame back: where the lit pixels actually are is the only
   * proof that "what you see is what gets burned in" survived the filter.
   */
  it('burns a caption where it was dragged, not always in the middle', async () => {
    const canvas = path.join(dir, 'black.mp4');
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=black:size=320x240:rate=10:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', canvas,
    ]);

    /** Burn "HERE" at xPct and report the average x of every lit pixel. */
    const litCentreX = async (xPct: number) => {
      const filters = await prepareCaptionFilters(
        [{ text: 'HERE', font: 'bold', sizePct: 10, color: '#ffffff', yPct: 50, xPct, outline: false }],
        dir,
        { videoWidth: 320, videoHeight: 240 },
      );
      const burned = path.join(dir, `placed-${xPct}.mp4`);
      await cutClip({
        inputPath: canvas,
        outputPath: burned,
        startSeconds: 0,
        endSeconds: 1,
        hasAudio: false,
        videoFilters: filters,
      });

      const gray = path.join(dir, `placed-${xPct}.gray`);
      await run('ffmpeg', [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', burned, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', gray,
      ]);
      const pixels = await readFile(gray);
      let sum = 0;
      let lit = 0;
      for (let index = 0; index < pixels.length; index += 1) {
        if (pixels[index]! > 128) {
          sum += index % 320;
          lit += 1;
        }
      }
      return { centreX: lit > 0 ? sum / lit : null, lit };
    };

    const left = await litCentreX(20);
    const right = await litCentreX(80);

    // Text was drawn at all — an empty frame would pass a "not centred" test
    // trivially, and that is exactly the false clean bill this repo forbids.
    expect(left.lit).toBeGreaterThan(50);
    expect(right.lit).toBeGreaterThan(50);
    expect(left.centreX!).toBeLessThan(320 * 0.35);
    expect(right.centreX!).toBeGreaterThan(320 * 0.65);
  }, 180_000);

});
