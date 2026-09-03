import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * One decode of the source, three things out of it: the analysis proxy, the
 * same pictures cut into chunks, and the proxy a person watches.
 *
 * What these tests protect is not the speed — it is that nothing about the
 * result changed. The chunk grid still lands where the analysis expects it,
 * a turned video still comes out the right way up, the watchable copy still
 * has its sound and the analysis copy still has none. A faster pipeline that
 * moves a timestamp by a second is worse than a slow one, because every
 * moment it finds afterwards points at the wrong place in the footage.
 *
 * The chunk length is pinned short so a test video can span several chunks
 * without taking a minute to make.
 */
vi.hoisted(() => {
  process.env.ANALYSIS_CHUNK_SECONDS = '30';
});

const { run } = await import('../src/lib/exec.js');
const {
  createAnalysisProxy,
  createPlaybackProxy,
  createProxiesAndChunks,
  ffprobe,
  splitIntoChunks,
} = await import('../src/services/media/ffmpeg.js');
const { env } = await import('../src/config/env.js');

const ffmpegAvailable = await run('ffmpeg', ['-version'], { timeoutMs: 15_000 }).then(
  () => true,
  () => false,
);

const dir = path.join('/tmp', `clipit-single-decode-${process.pid}`);
const DURATION = 70;

async function makeSource(file: string, audio: boolean): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=640x360:rate=5:duration=${DURATION}`,
    ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${DURATION}`] : []),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '10',
    ...(audio ? ['-c:a', 'aac', '-shortest'] : ['-an']),
    file,
  ], { timeoutMs: 180_000 });
}

const outputs = (name: string) => ({
  proxyPath: path.join(dir, `${name}-proxy.mp4`),
  playbackPath: path.join(dir, `${name}-playback.mp4`),
  chunkDir: path.join(dir, `${name}-chunks`),
});

async function single(name: string, sourcePath: string) {
  const o = outputs(name);
  await mkdir(o.chunkDir, { recursive: true });
  const result = await createProxiesAndChunks({ sourcePath, ...o });
  return { ...o, result };
}

describe.skipIf(!ffmpegAvailable)('one decode, three outputs', () => {
  const landscape = path.join(dir, 'src-landscape.mp4');
  const rotated = path.join(dir, 'src-rotated.mp4');
  const silent = path.join(dir, 'src-silent.mp4');

  beforeAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await makeSource(landscape, true);
    await makeSource(silent, false);
    // A file a player is told to turn a quarter turn. The rotation lives in
    // the display matrix, which is where real cameras put it; the older
    // `rotate` tag is ignored by current ffmpeg and writes nothing.
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-display_rotation', '90', '-i', landscape, '-c', 'copy', rotated,
    ], { timeoutMs: 60_000 });
  }, 300_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('the turned test file really is turned, or the rotation test below proves nothing', async () => {
    const probe = await ffprobe(rotated);
    expect(probe.rotation).toBe(90);
    // Reported the way a player would show it: the long side is now vertical.
    expect(probe.width).toBe(360);
    expect(probe.height).toBe(640);
  });

  it('produces every output the separate passes produced, from one input', async () => {
    const { result, proxyPath, playbackPath } = await single('all', landscape);

    expect(result.playbackPath).toBe(playbackPath);
    expect(result.segments.length).toBe(3);

    const proxy = await ffprobe(proxyPath);
    expect(proxy.height).toBe(env.PROXY_HEIGHT);
    // Nothing but pictures reaches the model's copy.
    expect(proxy.hasAudio).toBe(false);
    expect(proxy.durationSeconds).toBeGreaterThan(DURATION - 2);

    const playback = await ffprobe(playbackPath);
    expect(playback.hasAudio).toBe(true);
    expect(playback.width).toBe(640);
    expect(playback.height).toBe(360);
  }, 300_000);

  it('cuts the chunk grid exactly where the separate passes cut it', async () => {
    const one = await single('grid-single', landscape);
    const two = outputs('grid-separate');
    await mkdir(two.chunkDir, { recursive: true });
    await createAnalysisProxy(landscape, two.proxyPath);
    const separate = await splitIntoChunks(two.proxyPath, two.chunkDir, env.ANALYSIS_CHUNK_SECONDS);

    const sourceSeconds = (await ffprobe(landscape)).durationSeconds;
    expect(one.result.segments.length).toBe(separate.length);
    one.result.segments.forEach((seg, i) => {
      const was = separate[i]!;
      expect(seg.index).toBe(was.index);
      // The number every found moment is reported against.
      expect(seg.globalStartSeconds).toBeCloseTo(was.globalStartSeconds, 1);
      // Ends match once clamped to the real end of the video, which is what
      // the handler stores. The old route's proxy ran a second past the
      // source — `-r 2` pads the tail with duplicate frames where the `fps`
      // filter stops at the last real one — and that second was clamped away
      // before it reached the database. Same rows either way.
      expect(Math.min(seg.globalEndSeconds, sourceSeconds))
        .toBeCloseTo(Math.min(was.globalEndSeconds, sourceSeconds), 1);
    });
    // The new route no longer invents that trailing second in the first place.
    expect(one.result.segments.at(-1)!.globalEndSeconds).toBeLessThanOrEqual(sourceSeconds + 0.05);
    // Chunks tile the video end to end, with no gap and no overlap.
    one.result.segments.reduce((cursor, seg) => {
      expect(seg.globalStartSeconds).toBeCloseTo(cursor, 2);
      return seg.globalEndSeconds;
    }, 0);
  }, 300_000);

  it('keeps a turned video the right way up, the same way the old pass did', async () => {
    const one = await single('rot-single', rotated);

    const separatePlayback = path.join(dir, 'rot-separate-playback.mp4');
    await createPlaybackProxy(rotated, separatePlayback);
    const separateProxy = path.join(dir, 'rot-separate-proxy.mp4');
    await createAnalysisProxy(rotated, separateProxy);

    const now = await ffprobe(one.playbackPath);
    const was = await ffprobe(separatePlayback);
    // Whatever the old pass decided a turned file should look like, this does.
    expect(now.width).toBe(was.width);
    expect(now.height).toBe(was.height);
    // And it is genuinely upright, not a landscape frame carrying a flag.
    expect(now.height!).toBeGreaterThan(now.width!);

    const proxyNow = await ffprobe(one.proxyPath);
    const proxyWas = await ffprobe(separateProxy);
    expect(proxyNow.width).toBe(proxyWas.width);
    expect(proxyNow.height).toBe(proxyWas.height);
    expect(proxyNow.height).toBe(env.PROXY_HEIGHT);
  }, 300_000);

  it('still makes a watchable copy when the source has no sound', async () => {
    const one = await single('silent', silent);
    expect(one.result.segments.length).toBe(3);
    expect((await ffprobe(one.playbackPath)).hasAudio).toBe(false);
  }, 300_000);

  it('writes the chunks as it goes, not all at the end', async () => {
    const o = outputs('progress');
    await mkdir(o.chunkDir, { recursive: true });
    const appeared: number[] = [];
    const started = Date.now();
    const poll = setInterval(() => {
      readdir(o.chunkDir)
        .then((files) => {
          const n = files.filter((f) => /^chunk_\d+\.mp4$/.test(f)).length;
          while (appeared.length < n) appeared.push(Date.now() - started);
        })
        .catch(() => undefined);
    }, 20);
    try {
      await createProxiesAndChunks({ sourcePath: landscape, ...o });
    } finally {
      clearInterval(poll);
    }
    const total = Date.now() - started;
    // The second chunk file opening is the first one finishing, and it
    // happened before the run was over. Under the old route no chunk existed
    // until the whole proxy had been written and then read back a second time.
    expect(appeared.length).toBeGreaterThan(1);
    expect(appeared[1]!).toBeLessThan(total);
  }, 300_000);
});
