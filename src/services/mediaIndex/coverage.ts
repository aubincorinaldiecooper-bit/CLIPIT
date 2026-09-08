import type { IndexWindow } from './windows.js';

/**
 * How much of a video the index can honestly claim to have read.
 *
 * The rule this whole file exists for: "nothing matches there" and "nothing
 * has read there" are different answers and must never be returned as the
 * same one. A search of minute fourteen against an index that stopped at
 * eleven has not looked, and has to say so.
 *
 * So coverage is the CONTIGUOUS PREFIX — the second up to which every planned
 * window was stored — and not the furthest window that happened to succeed.
 * A provider that refuses window seven and returns eight through twenty
 * leaves a hole at seven, and footage past a hole is not covered footage. The
 * later windows are still stored and still searchable; they are simply not
 * allowed to make the index claim an unbroken read it did not do.
 */
export function coveredThroughSeconds(planned: readonly IndexWindow[], storedKeys: ReadonlySet<string>, key: (window: IndexWindow) => string): number {
  let covered = 0;
  for (const window of planned) {
    if (!storedKeys.has(key(window))) break;
    covered = window.endSeconds;
  }
  return covered;
}

/**
 * The stretches a search must not treat as examined.
 *
 * Everything after the contiguous prefix, described as ranges rather than a
 * single number, because a hole in the middle is what a person needs told:
 * "we read up to 11:00, and did not read 11:20–11:30" is an answer they can
 * act on. A bare covered-through figure hides which parts came back.
 */
export function unreadRanges(planned: readonly IndexWindow[], storedKeys: ReadonlySet<string>, key: (window: IndexWindow) => string): IndexWindow[] {
  const gaps: IndexWindow[] = [];
  for (const window of planned) {
    if (storedKeys.has(key(window))) continue;
    const previous = gaps[gaps.length - 1];
    // Windows overlap by design, so consecutive misses are one stretch of
    // footage nobody looked at, not several.
    if (previous && window.startSeconds <= previous.endSeconds) {
      previous.endSeconds = Math.max(previous.endSeconds, window.endSeconds);
      continue;
    }
    gaps.push({ startSeconds: window.startSeconds, endSeconds: window.endSeconds });
  }
  return gaps;
}
