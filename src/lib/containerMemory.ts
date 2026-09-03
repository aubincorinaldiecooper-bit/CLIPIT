import { readFile, writeFile } from 'node:fs/promises';
import { V1_ROOT, V2_ROOT } from './containerMemory.paths.js';

/**
 * What the container's own memory figure is made of.
 *
 * The number a hosting dashboard shows is the cgroup's, and the kernel counts
 * page cache in it alongside real allocations: "All mapped anon pages (RSS)
 * and cache pages (Page Cache) are accounted." So a job that reads a 4 GB
 * source file charges gigabytes to the container without any process having
 * allocated them — reclaimable bytes that look identical to a leak on a
 * graph.
 *
 * Splitting the figure is the only way to tell the two apart, and until this
 * existed nothing in the worker reported its own memory at all. `anon` is
 * what our processes actually hold; `file` is cache the kernel will drop
 * under pressure.
 */
export interface ContainerMemory {
  /** cgroup v2, v1, or null when neither is readable (not containerised). */
  source: 'v2' | 'v1' | null;
  currentBytes: number | null;
  /** High-water mark since boot or since the last reset. v2 only. */
  peakBytes: number | null;
  /** Memory our processes hold: heap, buffers, child processes. */
  anonBytes: number | null;
  /** Filesystem cache. Reclaimable, and not a leak. */
  fileBytes: number | null;
}

async function readNumber(path: string): Promise<number | null> {
  try {
    const value = Number((await readFile(path, 'utf8')).trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function readStat(path: string, keys: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  try {
    for (const line of (await readFile(path, 'utf8')).split('\n')) {
      const [key, raw] = line.split(/\s+/);
      if (key && keys.includes(key)) {
        const value = Number(raw);
        if (Number.isFinite(value)) out[key] = value;
      }
    }
  } catch {
    // Not containerised, or a kernel that does not expose it. Absence is
    // reported as null rather than guessed at.
  }
  return out;
}

export async function readContainerMemory(): Promise<ContainerMemory> {
  const v2Current = await readNumber(`${V2_ROOT}/memory.current`);
  if (v2Current !== null) {
    const stat = await readStat(`${V2_ROOT}/memory.stat`, ['anon', 'file']);
    return {
      source: 'v2',
      currentBytes: v2Current,
      peakBytes: await readNumber(`${V2_ROOT}/memory.peak`),
      anonBytes: stat.anon ?? null,
      fileBytes: stat.file ?? null,
    };
  }

  const v1Current = await readNumber(`${V1_ROOT}/memory.usage_in_bytes`);
  if (v1Current !== null) {
    const stat = await readStat(`${V1_ROOT}/memory.stat`, ['rss', 'cache']);
    return {
      source: 'v1',
      currentBytes: v1Current,
      peakBytes: await readNumber(`${V1_ROOT}/memory.max_usage_in_bytes`),
      anonBytes: stat.rss ?? null,
      fileBytes: stat.cache ?? null,
    };
  }

  return { source: null, currentBytes: null, peakBytes: null, anonBytes: null, fileBytes: null };
}

/**
 * Zeroes the high-water mark so the next reading covers one job rather than
 * the container's whole life. Only cgroup v2 supports this; v1's peak is
 * cumulative and the caller has to difference it itself.
 */
export async function resetContainerMemoryPeak(): Promise<boolean> {
  try {
    await writeFile(`${V2_ROOT}/memory.peak`, '0');
    return true;
  } catch {
    return false;
  }
}

/** Megabytes, rounded — the unit these numbers are read in. */
export function mib(bytes: number | null): number | null {
  return bytes === null ? null : Math.round(bytes / (1024 * 1024));
}
