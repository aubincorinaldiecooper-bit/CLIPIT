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
  // The seconds SOME stored window covers, merged into solid blocks.
  //
  // Not "the windows that are missing". The grid overlaps by design — ten
  // second windows every five — so a window that failed is mostly covered by
  // its neighbours, and reporting its whole span as unread invents a gap
  // where the footage was in fact examined. That sends somebody looking again
  // at seconds already searched, and makes every real gap less believable.
  const examined = planned
    .filter((window) => storedKeys.has(key(window)))
    .sort((a, b) => a.startSeconds - b.startSeconds);

  const blocks: IndexWindow[] = [];
  for (const window of examined) {
    const previous = blocks[blocks.length - 1];
    if (previous && window.startSeconds <= previous.endSeconds) {
      previous.endSeconds = Math.max(previous.endSeconds, window.endSeconds);
      continue;
    }
    blocks.push({ startSeconds: window.startSeconds, endSeconds: window.endSeconds });
  }

  // What is left is what nobody looked at: the complement of those blocks
  // within the span the grid was planned over.
  const spanStart = planned[0]?.startSeconds ?? 0;
  const spanEnd = planned.reduce((furthest, window) => Math.max(furthest, window.endSeconds), spanStart);

  const gaps: IndexWindow[] = [];
  let cursor = spanStart;
  for (const block of blocks) {
    if (block.startSeconds > cursor) gaps.push({ startSeconds: cursor, endSeconds: block.startSeconds });
    cursor = Math.max(cursor, block.endSeconds);
  }
  if (cursor < spanEnd) gaps.push({ startSeconds: cursor, endSeconds: spanEnd });

  return gaps;
}
