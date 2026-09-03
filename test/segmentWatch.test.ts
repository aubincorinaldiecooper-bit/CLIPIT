import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/lib/exec.js';
import { watchClosedSegments } from '../src/services/media/ffmpeg.js';

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

  it('never announces a chunk that would be dropped or would fail the run', async () => {
    await chunk(0, 2);
    // Far longer than the target: the muxer had nowhere to cut, and
    // measureSegments fails the whole job over it.
    await chunk(1, CHUNK_SECONDS * 2);
    await chunk(2, 2);
    // A file that is not video at all — nothing to measure, nothing to hand on.
    await writeFile(path.join(dir, 'chunk_0003.mp4'), 'not a video');
    await chunk(4, 2);

    const seen: number[] = [];
    const watcher = watchClosedSegments(dir, CHUNK_SECONDS, (i) => { seen.push(i); });
    await watcher.flush();
    // 1 is oversized, 3 is unreadable. Both are silent.
    expect(seen).toEqual([0, 2, 4]);
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
