import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * A container's memory figure is not one number. It counts the pages a
 * process actually holds AND the file cache the kernel is keeping around
 * because it has spare room — and the kernel drops the second kind the
 * instant anything needs the space.
 *
 * That distinction is the whole point of this file. A graph showing 6 GB of
 * 8 GB "used" reads as nearly out of memory; if most of it is cache, nothing
 * is wrong at all. Splitting the two is what turns that graph into an answer.
 */

const roots = path.join('/tmp', `clipit-cgroup-${process.pid}`);

afterEach(async () => {
  await rm(roots, { recursive: true, force: true });
  vi.resetModules();
});

async function withCgroup(files: Record<string, string>, v1: boolean) {
  const base = path.join(roots, v1 ? 'memory' : '.');
  await mkdir(base, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(base, name), body);
  }
  vi.resetModules();
  vi.doMock('../src/lib/containerMemory.paths.js', () => ({
    V2_ROOT: v1 ? path.join(roots, 'absent') : roots,
    V1_ROOT: path.join(roots, 'memory'),
  }));
  return import('../src/lib/containerMemory.js');
}

describe('reading a container\'s memory', () => {
  it('separates what the process holds from cache the kernel can drop (cgroup v2)', async () => {
    const { readContainerMemory, mib } = await withCgroup({
      'memory.current': '6800000000\n',
      'memory.peak': '6810000000\n',
      'memory.stat': 'anon 402653184\nfile 6377243136\nkernel_stack 131072\nslab 12345\n',
    }, false);

    const m = await readContainerMemory();
    expect(m.source).toBe('v2');
    expect(mib(m.currentBytes)).toBe(6485);
    expect(mib(m.peakBytes)).toBe(6495);
    // The honest reading of that 6.8 GB: 384 MiB is ours, the rest is cache.
    expect(mib(m.anonBytes)).toBe(384);
    expect(mib(m.fileBytes)).toBe(6082);
  });

  it('reads the older layout the same way', async () => {
    const { readContainerMemory, mib } = await withCgroup({
      'memory.usage_in_bytes': '1073741824\n',
      'memory.max_usage_in_bytes': '2147483648\n',
      'memory.stat': 'cache 805306368\nrss 268435456\nrss_huge 0\n',
    }, true);

    const m = await readContainerMemory();
    expect(m.source).toBe('v1');
    expect(mib(m.currentBytes)).toBe(1024);
    expect(mib(m.peakBytes)).toBe(2048);
    expect(mib(m.anonBytes)).toBe(256);
    expect(mib(m.fileBytes)).toBe(768);
  });

  it('says it does not know rather than guessing a number', async () => {
    const { readContainerMemory, mib } = await withCgroup({}, false);
    const m = await readContainerMemory();
    // Nothing to read. An absent measurement is reported as absent — never
    // as zero, which would read on a graph as "measured, and it was fine".
    expect(m.source).toBeNull();
    expect(m.currentBytes).toBeNull();
    expect(m.anonBytes).toBeNull();
    expect(mib(null)).toBeNull();
  });

  it('survives a stat file that is missing the lines it wants', async () => {
    const { readContainerMemory } = await withCgroup({
      'memory.current': '500000\n',
      'memory.stat': 'slab 999\n',
    }, false);
    const m = await readContainerMemory();
    expect(m.currentBytes).toBe(500000);
    expect(m.anonBytes).toBeNull();
    expect(m.fileBytes).toBeNull();
  });
});
