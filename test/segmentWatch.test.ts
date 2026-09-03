import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/lib/exec.js';
import { measureSegments, watchClosedSegments } from '../src/services/media/ffmpeg.js';

/**
 * The watch that tells the rest of the system a piece of video is ready.
 *
 * Everything here is about one promise: an index handed to a caller names a
 * chunk that exists, is complete, and will still be there. Announcing a chunk
 * from a run that has just failed breaks that — the fallback deletes the
 * directory moments later, so the caller is told about a file that is about to
 * stop existing. Stopping the timer does not stop a check already underway,
 * which is exactly how that happens.
 */

const ffmpegAvailable = await run('ffmpeg', ['-version'], { timeoutMs: 15_000 }).then(
  () => true,
  () => false,
);

const dir = path.join('/tmp', `clipit-segment-watch-${process.pid}`);
const CHUNK_SECONDS = 4;

/** A real, probeable chunk — the watcher measures what it announces. */
async function chunk(index: number, seconds: number): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `testsrc=size=64x48:rate=5:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an',
    path.join(dir, `chunk_${String(index).padStart(4, '0')}.mp4`),
  ], { timeoutMs: 60_000 });
}

/** A chunk that probes cleanly and holds nothing: no frames, no duration. */
async function empty(index: number): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=5:duration=1',
    '-frames:v', '0', '-c:v', 'libx264', '-an',
    path.join(dir, `chunk_${String(index).padStart(4, '0')}.mp4`),
  ], { timeoutMs: 60_000 });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 400));

beforeEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!ffmpegAvailable)('watching chunks close', () => {
  it('announces every chunk but the one still being written', async () => {
    await chunk(0, 2);
    await chunk(1, 2);
    await chunk(2, 2);
    const seen: number[] = [];
    const watcher = watchClosedSegments(dir, CHUNK_SECONDS, (i) => { seen.push(i); });
    await settle();
    // The newest file is the one ffmpeg still has open.
    expect(seen).toEqual([0, 1]);

    await watcher.flush();
    expect(seen).toEqual([0, 1, 2]);
  }, 60_000);

  it('says nothing more once the run it was watching has failed', async () => {
    await chunk(0, 2);
    await chunk(1, 2);
    await chunk(2, 2);
    const seen: number[] = [];
    // Stopped before the first poll can run, mid-flight from the watcher's
    // point of view: nothing may be announced afterwards.
    const watcher = watchClosedSegments(dir, CHUNK_SECONDS, (i) => { seen.push(i); });
    watcher.stop();
    await settle();
    expect(seen).toEqual([]);

    // And a stopped watcher stays stopped, even as files keep appearing.
    await chunk(3, 2);
    await settle();
    expect(seen).toEqual([]);
  }, 60_000);

  it('stops announcing part-way through, rather than finishing the batch', async () => {
    for (let i = 0; i < 6; i += 1) await chunk(i, 1);
    const seen: number[] = [];
    const watcher = watchClosedSegments(dir, CHUNK_SECONDS, (i) => {
      seen.push(i);
      // The run fails while the watcher is working through the backlog.
      if (seen.length === 2) watcher.stop();
    });
    await settle();
    // Without the check after each probe it would announce all five closed
    // chunks regardless.
    expect(seen).toEqual([0, 1]);
  }, 60_000);

  it('keeps going past an empty chunk, which the final list simply drops', async () => {
    await chunk(0, 2);
    await empty(1);
    await chunk(2, 2);
    await chunk(3, 2);

    const seen: number[] = [];
    const watcher = watchClosedSegments(dir, CHUNK_SECONDS, (i) => { seen.push(i); });
    await watcher.flush();
    // measureSegments logs this one and carries on, so the watch does too —
    // and the two agree exactly, which is the whole promise of the callback.
    expect(seen).toEqual([0, 2, 3]);
    const kept = await measureSegments(dir, CHUNK_SECONDS);
    expect(kept.map((segment) => segment.index)).toEqual(seen);
  }, 60_000);

  it('goes quiet for good at a chunk that will fail the whole run', async () => {
    await chunk(0, 2);
    // Far longer than the target: the muxer had nowhere to cut, and
    // measureSegments throws over it rather than dropping it.
    await chunk(1, CHUNK_SECONDS * 2);
    await chunk(2, 2);
    await chunk(3, 2);

    const seen: number[] = [];
    const watcher = watchClosedSegments(dir, CHUNK_SECONDS, (i) => { seen.push(i); });
    await watcher.flush();
    // 2 and 3 look perfectly healthy and are still never announced: this run
    // is already over, and the fallback is about to delete all of them.
    expect(seen).toEqual([0]);
    // The reason it is over.
    await expect(measureSegments(dir, CHUNK_SECONDS)).rejects.toThrow(/no keyframe/);
  }, 60_000);

  it('goes quiet for good at a chunk it cannot read', async () => {
    await chunk(0, 2);
    // measureSegments probes without catching, so this ends the run.
    await writeFile(path.join(dir, 'chunk_0001.mp4'), 'not a video');
    await chunk(2, 2);
    await chunk(3, 2);

    const seen: number[] = [];
    const watcher = watchClosedSegments(dir, CHUNK_SECONDS, (i) => { seen.push(i); });
    await watcher.flush();
    expect(seen).toEqual([0]);
    // measureSegments probes without catching, so the run dies here too.
    await expect(measureSegments(dir, CHUNK_SECONDS)).rejects.toThrow();
  }, 60_000);

  it('recovers when a probe fails and the chunk turns out to be fine', async () => {
    await chunk(0, 2);
    await chunk(2, 2);
    await chunk(3, 2);
    // Built up front and swapped in by rename, which is atomic — so the watch
    // sees either the unreadable file or the good one, never a half-written
    // file that could pass by accident.
    const ready = path.join(dir, 'replacement.bin');
    await chunk(1, 2);
    await rename(path.join(dir, 'chunk_0001.mp4'), ready);
    await writeFile(path.join(dir, 'chunk_0001.mp4'), 'not readable yet');

    const seen: number[] = [];
    // Retries slowed right down so the swap below cannot land in the wrong
    // gap on a loaded machine. At the shipped 200ms this test passes and fails
    // by luck, which is worse than not having it.
    const watcher = watchClosedSegments(dir, CHUNK_SECONDS, (i) => { seen.push(i); },
      { retryMs: 1_500 });
    // The first probe fails; this lands well after it and well before the
    // second — which is what a probe that could not launch, or timed out under
    // load, looks like from here. measureSegments probes again after the
    // encode and would read the file fine, so going quiet for good would lose
    // progress on a video that is not broken.
    const swap = setTimeout(() => { void rename(ready, path.join(dir, 'chunk_0001.mp4')); }, 900);
    try {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      await watcher.flush();
    } finally {
      clearTimeout(swap);
    }

    expect(seen).toEqual([0, 1, 2, 3]);
    const kept = await measureSegments(dir, CHUNK_SECONDS);
    expect(kept.map((segment) => segment.index)).toEqual(seen);
  }, 60_000);

  it('waits for an async callback before it reports itself finished', async () => {
    await chunk(0, 2);
    await chunk(1, 2);
    const done: number[] = [];
    const watcher = watchClosedSegments(dir, CHUNK_SECONDS, async (i) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      done.push(i);
    });
    await watcher.flush();
    // Not "started" — finished. A caller that awaits this knows the work it
    // asked for is actually done.
    expect(done).toEqual([0, 1]);
  }, 60_000);
});

describe.skipIf(!ffmpegAvailable)('ordering past the four-digit name', () => {
  const dir2 = path.join('/tmp', `clipit-segment-order-${process.pid}`);

  beforeEach(async () => {
    await rm(dir2, { recursive: true, force: true });
    await mkdir(dir2, { recursive: true });
  });
  afterEach(async () => {
    await rm(dir2, { recursive: true, force: true });
  });

  /** Named exactly as ffmpeg names them: %04d is a minimum width, not a cap. */
  async function numbered(index: number, seconds: number): Promise<void> {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=64x48:rate=5:duration=${seconds}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an',
      path.join(dir2, `chunk_${String(index).padStart(4, '0')}.mp4`),
    ], { timeoutMs: 60_000 });
  }

  it('places the ten-thousandth chunk after the nine-thousandth, not beside the thousandth', async () => {
    // As text, chunk_10000 sorts between chunk_1000 and chunk_1001. A long
    // enough video reaches this inside the supported settings, and every
    // timestamp after that point would then be wrong — a found moment would
    // point at a different part of the footage than the one it came from.
    await numbered(1000, 1);
    await numbered(1001, 2);
    await numbered(9999, 3);
    await numbered(10000, 4);

    const segments = await measureSegments(dir2, 30);
    expect(segments.map((segment) => path.basename(segment.filePath))).toEqual([
      'chunk_1000.mp4', 'chunk_1001.mp4', 'chunk_9999.mp4', 'chunk_10000.mp4',
    ]);
    // Start seconds accumulate in that order, so they stay truthful.
    expect(segments.map((segment) => Math.round(segment.globalStartSeconds))).toEqual([0, 1, 3, 6]);
  }, 120_000);

  it('announces the same indices the final list uses, whatever the names look like', async () => {
    await numbered(1000, 1);
    await numbered(1001, 2);
    await numbered(9999, 3);
    await numbered(10000, 4);

    const seen: number[] = [];
    const watcher = watchClosedSegments(dir2, 30, (i) => { seen.push(i); });
    await watcher.flush();
    // The indices are positions, not the numbers in the filenames, and both
    // sides derive them the same way. This pins that agreement; the ordering
    // itself is what the test above catches.
    const kept = await measureSegments(dir2, 30);
    expect(seen).toEqual(kept.map((segment) => segment.index));
  }, 120_000);
});
