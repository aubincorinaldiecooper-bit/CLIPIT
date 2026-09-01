import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { run } from '../src/lib/exec.js';
import {
  createAnalysisProxy,
  clipResolutionCap,
  cutClip,
  extractAudioSegments,
  extractFrameAt,
  ffprobe,
  renderVerticalDerivative,
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
  /**
   * A synthetic source taller than the cap, in both orientations. 1440 on the
   * short side is enough to prove the rule without encoding anything near 4K
   * in a unit test.
   */
  async function makeOversized(name: string, size: string): Promise<string> {
    const file = path.join(dir, name);
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=10:duration=2`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', file,
    ], { timeoutMs: 120_000 });
    return file;
  }

  it('caps a landscape source at 1080 lines, and reports the size it delivered', async () => {
    const big = await makeOversized('big-landscape.mp4', '1920x1440');
    const output = path.join(dir, 'capped-landscape.mp4');
    const result = await cutClip({ inputPath: big, outputPath: output, startSeconds: 0, endSeconds: 1, hasAudio: false });

    const probe = await ffprobe(output);
    expect(probe.height).toBe(1080);
    expect(probe.width).toBe(1440);
    // What the caller is told matches the file, not the source.
    expect(result.width).toBe(1440);
    expect(result.height).toBe(1080);
  }, 180_000);

  it("reports the delivered size when the cap shrinks a caller's crop", async () => {
    // A variant plans a crop and would otherwise record the crop's size.
    // Here the crop's shorter side (1200) is over the cap, so the file is
    // smaller than the plan — and the result must say so.
    const big = await makeOversized('big-cropped.mp4', '1920x1440');
    const output = path.join(dir, 'capped-crop.mp4');
    const result = await cutClip({
      inputPath: big, outputPath: output, startSeconds: 0, endSeconds: 1, hasAudio: false,
      videoFilters: ['crop=1600:1200:0:0'],
    });

    const probe = await ffprobe(output);
    expect([probe.width, probe.height]).toEqual([1440, 1080]);
    expect([result.width, result.height]).toEqual([1440, 1080]);
  }, 180_000);

  it('rounds an odd cap down so the encoder still accepts the frame', async () => {
    // An odd short side is not "a slightly smaller clip": H.264 4:2:0 refuses
    // it outright, so every oversized cut would fail and deliver nothing.
    expect(clipResolutionCap(1079)).toContain('1078');
    expect(clipResolutionCap(1079)).not.toContain('1079');

    const big = await makeOversized('big-odd.mp4', '1920x1440');
    const output = path.join(dir, 'odd-cap.mp4');
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', big,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-vf', clipResolutionCap(1079), output,
    ], { timeoutMs: 120_000 });

    const probe = await ffprobe(output);
    expect(probe.height).toBe(1078);
  }, 180_000);

  it('caps a portrait source on its shorter side, not its height', async () => {
    const big = await makeOversized('big-portrait.mp4', '1440x1920');
    const output = path.join(dir, 'capped-portrait.mp4');
    await cutClip({ inputPath: big, outputPath: output, startSeconds: 0, endSeconds: 1, hasAudio: false });

    const probe = await ffprobe(output);
    expect(probe.width).toBe(1080);
    expect(probe.height).toBe(1440);
  }, 180_000);

  it('evens out an odd source that is already inside the cap', async () => {
    // Phone and screen recordings arrive at odd sizes. 4:4:4 lets the test
    // encode one; the cut is 4:2:0, which cannot carry an odd side.
    const odd = path.join(dir, 'odd-source.mp4');
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=1279x719:rate=10:duration=2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv444p', odd,
    ], { timeoutMs: 120_000 });

    const output = path.join(dir, 'odd-cut.mp4');
    await cutClip({ inputPath: odd, outputPath: output, startSeconds: 0, endSeconds: 1, hasAudio: false });

    const probe = await ffprobe(output);
    expect(probe.height).toBe(718);
    expect(probe.width! % 2).toBe(0);
    expect(probe.width).toBeLessThanOrEqual(1279);
  }, 180_000);

  it('never upscales a source already inside the cap', async () => {
    // The shared 320x240 source: the cut must come out exactly 320x240.
    const output = path.join(dir, 'untouched.mp4');
    await cutClip({ inputPath: source, outputPath: output, startSeconds: 1, endSeconds: 2, hasAudio: true });

    const probe = await ffprobe(output);
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(240);
  }, 180_000);

  it('draws captions before scaling, so they are sized to the original frame', async () => {
    const big = await makeOversized('big-captioned.mp4', '1920x1440');
    const filters = await prepareCaptionFilters(
      [{ text: 'sized against 1440 lines', font: 'bold', sizePct: 8, color: '#ffffff', yPct: 85, xPct: 50, outline: true }],
      dir,
      { videoWidth: 1920, videoHeight: 1440 },
    );
    const output = path.join(dir, 'capped-captioned.mp4');
    await cutClip({ inputPath: big, outputPath: output, startSeconds: 0, endSeconds: 1, hasAudio: false, videoFilters: filters });

    // Still capped with the caption in the chain, and the encode survived
    // drawtext followed by scale.
    const probe = await ffprobe(output);
    expect(probe.height).toBe(1080);
    expect(probe.width).toBe(1440);
    expect(probe.videoCodec).toBe('h264');
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
   * A platform shape is a real crop of the real frame, with the captions
   * drawn on the CROPPED frame. This cuts a 9:16 out of the synthetic 4:3
   * source and checks the file that comes out is the shape a platform would
   * accept — and that a caption still lands inside it.
   */
  it('cuts a vertical variant whose frame is actually vertical', async () => {
    const { planReframe } = await import('../src/services/media/reframe.js');
    const probe = await ffprobe(source);
    const plan = planReframe(
      { aspect: '9:16', focusPct: 50 },
      { width: probe.width ?? 320, height: probe.height ?? 240 },
    );
    expect(plan.filter).not.toBeNull();

    const filters = [plan.filter!];
    filters.push(
      ...(await prepareCaptionFilters(
        [{ text: 'VERTICAL', font: 'bold', sizePct: 8, color: '#ffffff', yPct: 85, xPct: 50, widthPct: 92, outline: true }],
        dir,
        { videoWidth: plan.outputWidth, videoHeight: plan.outputHeight },
      )),
    );

    const output = path.join(dir, 'vertical.mp4');
    await cutClip({
      inputPath: source,
      outputPath: output,
      startSeconds: 1,
      endSeconds: 3,
      hasAudio: true,
      videoFilters: filters,
    });

    const out = await ffprobe(output);
    // 240 tall, 9:16 → 134 wide, floored to the even 134.
    expect(out.width).toBe(plan.outputWidth);
    expect(out.height).toBe(plan.outputHeight);
    expect((out.width ?? 0) / (out.height ?? 1)).toBeLessThan(1);
  }, 180_000);

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

  /**
   * Phones and drones sometimes ship with extra video or audio tracks (cover
   * art, alternate angles, commentary). If FFmpeg is left on auto-selection,
   * the proxy, clip, or vertical render can pick a different stream than the
   * one ffprobe reports as primary. This test asserts every output carries
   * only the first video and first audio streams, matching the dimensions the
   * rest of the pipeline expects.
   */
  it('uses only the first video and audio streams when the source contains extras', async () => {
    const multiSource = path.join(dir, 'multi-source.mp4');
    const multiSeconds = 6;

    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=320x240:rate=15:duration=${multiSeconds}`,
      '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=15:duration=${multiSeconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=44100:duration=${multiSeconds}`,
      '-f', 'lavfi', '-i', `sine=frequency=880:sample_rate=22050:duration=${multiSeconds}`,
      '-map', '0:v', '-map', '1:v', '-map', '2:a', '-map', '3:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '64k', '-shortest', multiSource,
    ]);

    const sourceProbe = await ffprobe(multiSource);
    expect(sourceProbe.width).toBe(320);
    expect(sourceProbe.height).toBe(240);
    expect(sourceProbe.hasAudio).toBe(true);

    const { stdout: sourceStreams } = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', multiSource,
    ]);
    const parsed = JSON.parse(sourceStreams) as { streams: { codec_type: string }[] };
    expect(parsed.streams.filter((s) => s.codec_type === 'video').length).toBe(2);
    expect(parsed.streams.filter((s) => s.codec_type === 'audio').length).toBe(2);

    // Proxy should downscale the first video (320x240) to the configured proxy
    // height and drop all audio. PROXY_HEIGHT=360, so width becomes 480.
    const proxy = path.join(dir, 'multi-proxy.mp4');
    await createAnalysisProxy(multiSource, proxy, CHUNK_SECONDS);
    const proxyProbe = await ffprobe(proxy);
    expect(proxyProbe.width).toBe(480);
    expect(proxyProbe.height).toBe(360);
    expect(proxyProbe.hasAudio).toBe(false);

    // cutClip should encode the first video and first audio.
    const clip = path.join(dir, 'multi-clip.mp4');
    await cutClip({
      inputPath: multiSource,
      outputPath: clip,
      startSeconds: 1,
      endSeconds: 3,
      hasAudio: true,
    });
    const clipProbe = await ffprobe(clip);
    expect(clipProbe.width).toBe(320);
    expect(clipProbe.height).toBe(240);
    expect(clipProbe.audioCodec).toBe('aac');

    const { stdout: clipRate } = await run('ffprobe', [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=sample_rate',
      '-of', 'csv=p=0', clip,
    ]);
    expect(clipRate.trim()).toBe('44100');

    // renderVerticalDerivative smart crop should use the first stream too.
    const { planReframe } = await import('../src/services/media/reframe.js');
    const { VERTICAL_DELIVERY } = await import('../src/services/media/composition.js');
    const plan = planReframe({ aspect: '9:16', focusPct: 50 }, { width: 320, height: 240 });
    expect(plan.filter).not.toBeNull();

    const smart = path.join(dir, 'multi-vertical-smart.mp4');
    await renderVerticalDerivative({
      inputPath: multiSource,
      outputPath: smart,
      hasAudio: true,
      delivery: VERTICAL_DELIVERY,
      cropFilter: plan.filter,
    });
    const smartProbe = await ffprobe(smart);
    expect(smartProbe.width).toBe(1080);
    expect(smartProbe.height).toBe(1920);
    expect(smartProbe.audioCodec).toBe('aac');

    const { stdout: smartRate } = await run('ffprobe', [
      '-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=sample_rate',
      '-of', 'csv=p=0', smart,
    ]);
    expect(smartRate.trim()).toBe('44100');

    // Blurred background path should also produce a single vertical video
    // from the first source stream.
    const blurred = path.join(dir, 'multi-vertical-blurred.mp4');
    await renderVerticalDerivative({
      inputPath: multiSource,
      outputPath: blurred,
      hasAudio: true,
      delivery: VERTICAL_DELIVERY,
      cropFilter: null,
    });
    const blurredProbe = await ffprobe(blurred);
    expect(blurredProbe.width).toBe(1080);
    expect(blurredProbe.height).toBe(1920);
    expect(blurredProbe.audioCodec).toBe('aac');
  }, 300_000);

});
