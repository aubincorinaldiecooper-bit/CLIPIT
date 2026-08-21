/**
 * Single source of truth for turning model-reported timestamps into source
 * timestamps.
 *
 * The model only ever sees one analysis chunk at a time and reports seconds
 * relative to the start of that chunk. Every conversion in the system goes
 * through `mapLocalRangeToGlobal`:
 *
 *   global_start = chunk_global_start + local_start
 *   global_end   = chunk_global_start + local_end
 *
 * Everything else here (clamping, minimum/maximum durations, padding, merging)
 * exists because model output is untrusted: it can be reversed, negative,
 * past the end of the chunk, zero-length, or absurdly long.
 */

export interface ChunkWindow {
  globalStartSeconds: number;
  globalEndSeconds: number;
}

export interface TimeRange {
  startSeconds: number;
  endSeconds: number;
}

export interface MappedRange {
  localStartSeconds: number;
  localEndSeconds: number;
  globalStartSeconds: number;
  globalEndSeconds: number;
}

export interface MapOptions {
  /** Shortest acceptable range; shorter ranges are expanded around their midpoint. */
  minDurationSeconds?: number;
  /** Longest acceptable range; longer ranges are truncated from the start. */
  maxDurationSeconds?: number;
}

const EPSILON = 1e-6;

function round(value: number): number {
  // Milliseconds are as precise as the schema (NUMERIC(12,3)) and ffmpeg need.
  return Math.round(value * 1000) / 1000;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function chunkDuration(chunk: ChunkWindow): number {
  return chunk.globalEndSeconds - chunk.globalStartSeconds;
}

/**
 * Converts a chunk-local range into a source-global range.
 * Returns `null` when the input cannot be salvaged into a usable range.
 */
export function mapLocalRangeToGlobal(
  chunk: ChunkWindow,
  local: TimeRange,
  options: MapOptions = {},
): MappedRange | null {
  if (!isFiniteNumber(chunk.globalStartSeconds) || !isFiniteNumber(chunk.globalEndSeconds)) return null;
  if (!isFiniteNumber(local.startSeconds) || !isFiniteNumber(local.endSeconds)) return null;

  const duration = chunkDuration(chunk);
  if (duration <= 0) return null;

  // Models occasionally emit the range backwards.
  let start = Math.min(local.startSeconds, local.endSeconds);
  let end = Math.max(local.startSeconds, local.endSeconds);

  // A range entirely outside the chunk is a hallucination, not a clamp target.
  if (end <= 0 || start >= duration) return null;

  start = Math.min(Math.max(start, 0), duration);
  end = Math.min(Math.max(end, 0), duration);

  const minDuration = Math.min(options.minDurationSeconds ?? 0, duration);
  const maxDuration = options.maxDurationSeconds ?? Number.POSITIVE_INFINITY;

  if (end - start < minDuration) {
    // Grow around the midpoint, then slide back inside the chunk if we overflow.
    const midpoint = (start + end) / 2;
    start = midpoint - minDuration / 2;
    end = midpoint + minDuration / 2;
    if (start < 0) {
      end -= start;
      start = 0;
    }
    if (end > duration) {
      start -= end - duration;
      end = duration;
    }
    start = Math.max(start, 0);
  }

  if (end - start > maxDuration) end = start + maxDuration;

  if (end - start <= EPSILON) return null;

  return {
    localStartSeconds: round(start),
    localEndSeconds: round(end),
    globalStartSeconds: round(chunk.globalStartSeconds + start),
    globalEndSeconds: round(chunk.globalStartSeconds + end),
  };
}

/**
 * Maps a range that is already in global (source) time — used by the transcript
 * search path, where segment timestamps are global — back onto its chunk so the
 * local columns stay meaningful.
 */
export function mapGlobalRangeToChunk(
  chunk: ChunkWindow,
  global: TimeRange,
  options: MapOptions = {},
): MappedRange | null {
  return mapLocalRangeToGlobal(
    chunk,
    {
      startSeconds: global.startSeconds - chunk.globalStartSeconds,
      endSeconds: global.endSeconds - chunk.globalStartSeconds,
    },
    options,
  );
}

export interface PaddingOptions {
  paddingSeconds: number;
  videoDurationSeconds: number;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
}

/**
 * Widens a match into the range actually cut by ffmpeg: a little handle on each
 * side, bounded by the source duration.
 */
export function applyClipPadding(range: TimeRange, options: PaddingOptions): TimeRange {
  const limit = isFiniteNumber(options.videoDurationSeconds) && options.videoDurationSeconds > 0
    ? options.videoDurationSeconds
    : Number.POSITIVE_INFINITY;

  let start = Math.max(0, range.startSeconds - options.paddingSeconds);
  let end = Math.min(limit, range.endSeconds + options.paddingSeconds);

  const minDuration = options.minDurationSeconds ?? 0;
  if (end - start < minDuration) {
    end = Math.min(limit, start + minDuration);
    start = Math.max(0, end - minDuration);
  }

  if (options.maxDurationSeconds !== undefined && end - start > options.maxDurationSeconds) {
    end = start + options.maxDurationSeconds;
  }

  return { startSeconds: round(start), endSeconds: round(end) };
}

export interface MergeableRange extends TimeRange {
  confidence?: number;
}

/**
 * Collapses ranges that describe the same moment. Two ranges merge when they
 * overlap by more than `toleranceSeconds` (negative tolerance means they may be
 * that far apart and still merge). Used to reconcile the visual and transcript
 * passes, and to join a moment that straddles a chunk boundary.
 */
export function mergeOverlappingRanges<T extends MergeableRange>(
  ranges: T[],
  toleranceSeconds = 0,
  pick: (a: T, b: T) => T = (a, b) => ((b.confidence ?? 0) > (a.confidence ?? 0) ? b : a),
): T[] {
  if (ranges.length <= 1) return [...ranges];

  const sorted = [...ranges].sort((a, b) => a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds);
  const merged: T[] = [];

  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.startSeconds <= previous.endSeconds + toleranceSeconds) {
      const winner = pick(previous, range);
      merged[merged.length - 1] = {
        ...winner,
        startSeconds: round(Math.min(previous.startSeconds, range.startSeconds)),
        endSeconds: round(Math.max(previous.endSeconds, range.endSeconds)),
      };
      continue;
    }
    merged.push({ ...range, startSeconds: round(range.startSeconds), endSeconds: round(range.endSeconds) });
  }

  return merged;
}

/** Plans the chunk grid for a source of `durationSeconds`. */
export function planChunkWindows(durationSeconds: number, chunkSeconds: number): ChunkWindow[] {
  if (!isFiniteNumber(durationSeconds) || durationSeconds <= 0) return [];
  if (!isFiniteNumber(chunkSeconds) || chunkSeconds <= 0) return [];

  const windows: ChunkWindow[] = [];
  for (let start = 0; start < durationSeconds - EPSILON; start += chunkSeconds) {
    windows.push({
      globalStartSeconds: round(start),
      globalEndSeconds: round(Math.min(start + chunkSeconds, durationSeconds)),
    });
  }
  return windows;
}


export function formatTimecode(totalSeconds: number): string {
  const clamped = Math.max(0, isFiniteNumber(totalSeconds) ? totalSeconds : 0);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const seconds = Math.floor(clamped % 60);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * The stretches of [0, totalSeconds) that no range covers.
 *
 * Written for the notes: a scene list can be perfectly valid and still leave
 * ninety seconds of a chunk undescribed, and nothing downstream could tell
 * that hole apart from a stretch where nothing relevant happened. Naming the
 * uncovered seconds is what turns "the notes do not mention it" into a
 * statement about the notes rather than about the video.
 *
 * `toleranceSeconds` absorbs the rounding between adjacent ranges; a gap
 * shorter than it is not worth reporting to anyone.
 */
export function findUncoveredRanges(
  covered: TimeRange[],
  totalSeconds: number,
  toleranceSeconds = 1,
): TimeRange[] {
  if (totalSeconds <= 0) return [];
  if (covered.length === 0) return [{ startSeconds: 0, endSeconds: round(totalSeconds) }];

  const merged = mergeOverlappingRanges(
    covered.map((range) => ({
      startSeconds: Math.max(0, range.startSeconds),
      endSeconds: Math.min(totalSeconds, range.endSeconds),
    })),
    toleranceSeconds,
  );

  const gaps: TimeRange[] = [];
  let cursor = 0;

  for (const range of merged) {
    if (range.startSeconds - cursor > toleranceSeconds) {
      gaps.push({ startSeconds: round(cursor), endSeconds: round(range.startSeconds) });
    }
    cursor = Math.max(cursor, range.endSeconds);
  }

  if (totalSeconds - cursor > toleranceSeconds) {
    gaps.push({ startSeconds: round(cursor), endSeconds: round(totalSeconds) });
  }

  return gaps;
}
