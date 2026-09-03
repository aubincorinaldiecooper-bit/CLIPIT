/**
 * The timeline windows the Media Index is built from.
 *
 * A video is stored once, as one continuous analysis proxy. What makes it
 * searchable is not a set of files but a set of COORDINATES: overlapping
 * stretches of the source timeline, each one carrying an embedding. Nothing
 * here touches ffmpeg or storage — a window is arithmetic over seconds, and
 * keeping it that way is what lets the grid be re-planned, re-measured and
 * argued about without re-encoding anything.
 *
 * Two rules hold everywhere below.
 *
 * A window is identified by the SECONDS IT COVERS, never by its position in
 * an array and never by a row id. Array position has already cost this
 * codebase real bugs, and chunk row ids are regenerated wholesale every time
 * a video is re-processed. Start and end seconds on the source timeline are
 * the only coordinates that survive a re-index, a re-encode, or a change to
 * this very file.
 *
 * And the grid is DETERMINISTIC. The same duration and the same settings
 * produce the same windows in the same order, so re-running an index is an
 * upsert rather than a second copy of the same video.
 */

export interface IndexWindow {
  /** Seconds from the start of the SOURCE video, not of any temporary file. */
  startSeconds: number;
  endSeconds: number;
}

export interface WindowPlan {
  /** How long each window is, before clamping at the end of the video. */
  windowSeconds: number;
  /** How far apart consecutive windows start. Less than the length = overlap. */
  strideSeconds: number;
  /**
   * The shortest tail worth its own window. Without this, a video whose
   * duration is a whisker past a stride boundary earns a final window of a
   * fraction of a second: a real row, a real embedding, and far too little
   * footage to mean anything.
   */
  minWindowSeconds: number;
}

export const DEFAULT_WINDOW_PLAN: WindowPlan = {
  windowSeconds: 10,
  strideSeconds: 5,
  minWindowSeconds: 3,
};

/**
 * Slack for the last bits of a float. Small enough that it can never admit a
 * window anybody would call short, large enough to absorb the error in adding
 * a stride to itself a few hundred times.
 */
const EPSILON = 1e-9;

/** Three decimals everywhere, so a window key is stable across re-planning. */
function round(seconds: number): number {
  return Number(seconds.toFixed(3));
}

/**
 * The window's name, and its identity in the database.
 *
 * Milliseconds rather than seconds so the text can never carry a rounding
 * difference that makes the same window look like two. Deliberately readable:
 * this string appears in logs and in coverage reports, and "000420000-000430000"
 * is something a person can find in a video.
 */
export function windowKey(window: IndexWindow): string {
  const ms = (seconds: number) => String(Math.round(seconds * 1000)).padStart(9, '0');
  return `${ms(window.startSeconds)}-${ms(window.endSeconds)}`;
}

/**
 * A plan that cannot keep the coverage promise is refused, not worked around.
 *
 * The three settings are independent knobs and two combinations inside their
 * own valid ranges quietly break the guarantee this module is built on. Both
 * were reachable from configuration alone:
 *
 *  - a stride LONGER than a window leaves a hole between every pair of
 *    windows. At window 10 / stride 30 over two minutes, 60 of 120 seconds
 *    are never indexed;
 *  - a minimum LONGER than a window disqualifies every window, so the whole
 *    video collapses to the single one the tail rule adds at the end. At
 *    window 10 / minimum 20, a two-minute video is indexed from 110 seconds
 *    onward and nothing else.
 *
 * `uncoveredSeconds` would have named those holes, so the index would not have
 * lied about itself. But a planner whose documented job is to cover the
 * timeline should fail loudly on a plan that cannot, rather than quietly
 * producing one and leaving the honesty to something downstream. Startup
 * validation refuses the same combinations, so this is the second line rather
 * than the first.
 */
export function assertPlannable(plan: WindowPlan): void {
  const { windowSeconds, strideSeconds, minWindowSeconds } = plan;
  if (!(windowSeconds > 0) || !(strideSeconds > 0)) {
    throw new Error('planWindows needs a positive window length and stride');
  }
  if (strideSeconds > windowSeconds) {
    throw new Error(
      `A stride of ${strideSeconds}s with a ${windowSeconds}s window leaves ` +
        `${strideSeconds - windowSeconds}s unindexed between every pair of windows. ` +
        'The stride must be at most the window length.',
    );
  }
  if (minWindowSeconds > windowSeconds) {
    throw new Error(
      `A minimum of ${minWindowSeconds}s disqualifies every ${windowSeconds}s window. ` +
        'The minimum must be at most the window length.',
    );
  }
}

/**
 * Lays the whole timeline out in windows.
 *
 * Two promises, and the second one was got wrong the first time.
 *
 * No window ever claims seconds the video does not have. A window running
 * past the end would let a match be reported at a timestamp nothing can be
 * cut from.
 *
 * And the windows COVER THE WHOLE VIDEO. A tail too short to deserve a
 * window of its own does not simply get dropped — the last window is pulled
 * back to start a full window's length from the end, so it reaches the final
 * second at full size. Dropping it is safe only when the windows overlap and
 * the one before already covers the tail, which is why the bug hid: at the
 * default ten-second window every five seconds it is invisible, and at the
 * sweep's ten-second window every ten seconds a 31-second video lost its last
 * second entirely. `uncoveredSeconds` would have named that stretch, so it was
 * never going to be a silent hole — but a needless hole is still a stretch of
 * somebody's video that nothing can retrieve.
 *
 * Overlap remains the reason the grid works at all: a ten-second window every
 * five seconds means every instant sits in the middle of some window rather
 * than only at the edge of one.
 */
export function planWindows(durationSeconds: number, plan: WindowPlan = DEFAULT_WINDOW_PLAN): IndexWindow[] {
  const { windowSeconds, strideSeconds, minWindowSeconds } = plan;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  assertPlannable(plan);

  // A video shorter than one window is one window: the whole thing.
  if (durationSeconds <= windowSeconds) {
    return [{ startSeconds: 0, endSeconds: round(durationSeconds) }];
  }

  const windows: IndexWindow[] = [];
  for (let start = 0; start < durationSeconds; start += strideSeconds) {
    const rawEnd = Math.min(start + windowSeconds, durationSeconds);
    const startSeconds = round(start);
    const endSeconds = round(rawEnd);

    // A sliver at the end is not worth its own embedding — a real row, a real
    // GPU call, and a fraction of a second of footage. It is skipped here and
    // the seconds it would have held are picked up below.
    //
    // Measured on the UNROUNDED interval, which is not fussiness. Rounding
    // start and end separately and subtracting can land a hair under the
    // width they were built to have: at a 1s window every 0.501s, with only
    // full windows eligible, six windows whose stored width reads exactly
    // 1.000 were discarded and half a second of the video went unindexed.
    // A window is or is not long enough by the arithmetic that made it; the
    // rounding is for the coordinates that get stored, and only that.
    if (rawEnd - start >= minWindowSeconds - EPSILON) {
      windows.push({ startSeconds, endSeconds });
    }

    // Everything after this would start past the end of the video.
    if (endSeconds >= durationSeconds) break;
  }

  // Whatever the stride did, the grid reaches the end of the video. Pulled
  // back a full window's length rather than left short, so the final window
  // is the same size as every other one and the last seconds are covered at
  // the same quality as the first.
  const last = windows.at(-1);
  if (!last || last.endSeconds < durationSeconds - 1e-6) {
    const startSeconds = round(Math.max(0, durationSeconds - windowSeconds));
    const endSeconds = round(durationSeconds);
    // A grid that lands exactly here already has this window; extend it in
    // place rather than storing the same seconds twice.
    if (last && last.startSeconds === startSeconds) windows[windows.length - 1] = { startSeconds, endSeconds };
    else windows.push({ startSeconds, endSeconds });
  }

  return windows;
}

/**
 * Which windows can be embedded from footage that ends at `throughSeconds`.
 *
 * This is the progressive question, asked while the encode is still running.
 * A window is ready only when EVERY second of it exists — a window half
 * written is a window the model would see half of, and an embedding of half a
 * moment is worse than no embedding, because nothing downstream could tell.
 *
 * `fromSeconds` is the other edge, and it is what makes windows able to span
 * a temporary section boundary: as long as the rolling buffer still holds the
 * earlier section, a window straddling the join is coverable and does not have
 * to wait for the finished proxy.
 */
export function windowsWithin(
  windows: readonly IndexWindow[],
  fromSeconds: number,
  throughSeconds: number,
): IndexWindow[] {
  return windows.filter(
    (window) => window.startSeconds >= fromSeconds - 1e-6 && window.endSeconds <= throughSeconds + 1e-6,
  );
}

/**
 * The seconds of a video that no window covers.
 *
 * Coverage is the honesty channel of the Media Index, and it replaces the
 * chunk-failure list the old search reported. A stretch with no embedding is
 * a stretch nothing can be retrieved from, and it must be nameable — "we did
 * not look there" and "there is nothing there" are different answers and the
 * system has never been allowed to return them as the same one.
 *
 * Windows arrive in any order and overlap by design, so they are merged
 * before the gaps are read off. `toleranceSeconds` swallows the rounding
 * between two windows that were meant to be adjacent.
 */
export function uncoveredSeconds(
  windows: readonly IndexWindow[],
  durationSeconds: number,
  toleranceSeconds = 0.25,
): IndexWindow[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];

  const ordered = [...windows]
    .filter((window) => window.endSeconds > window.startSeconds)
    .sort((a, b) => a.startSeconds - b.startSeconds);

  const gaps: IndexWindow[] = [];
  let cursor = 0;

  for (const window of ordered) {
    if (window.startSeconds - cursor > toleranceSeconds) {
      gaps.push({ startSeconds: round(cursor), endSeconds: round(window.startSeconds) });
    }
    cursor = Math.max(cursor, window.endSeconds);
    if (cursor >= durationSeconds) break;
  }

  if (durationSeconds - cursor > toleranceSeconds) {
    gaps.push({ startSeconds: round(cursor), endSeconds: round(durationSeconds) });
  }

  return gaps;
}
