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
 * Lays the whole timeline out in overlapping windows.
 *
 * The last window ENDS AT THE END OF THE VIDEO rather than running past it,
 * which matters more than it sounds: a window that claims seconds the video
 * does not have would let a match be reported at a timestamp nothing can be
 * cut from. Overlap is what stops a moment falling into a seam — a ten-second
 * window every five seconds means every instant of the video sits in the
 * middle of some window, not just at the edge of one.
 */
export function planWindows(durationSeconds: number, plan: WindowPlan = DEFAULT_WINDOW_PLAN): IndexWindow[] {
  const { windowSeconds, strideSeconds, minWindowSeconds } = plan;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return [];
  if (!(windowSeconds > 0) || !(strideSeconds > 0)) {
    throw new Error('planWindows needs a positive window length and stride');
  }

  // A video shorter than one window is one window: the whole thing.
  if (durationSeconds <= windowSeconds) {
    return [{ startSeconds: 0, endSeconds: round(durationSeconds) }];
  }

  const windows: IndexWindow[] = [];
  for (let start = 0; start < durationSeconds; start += strideSeconds) {
    const startSeconds = round(start);
    const endSeconds = round(Math.min(start + windowSeconds, durationSeconds));

    // The tail. Everything from here on would be shorter than a full window,
    // so this is the last one either way — the only question is whether it is
    // long enough to be worth an embedding of its own.
    if (endSeconds >= durationSeconds) {
      if (endSeconds - startSeconds >= minWindowSeconds || windows.length === 0) {
        windows.push({ startSeconds, endSeconds });
      }
      break;
    }

    windows.push({ startSeconds, endSeconds });
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
