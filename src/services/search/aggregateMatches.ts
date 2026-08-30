import type { MatchSource } from '../../domain/types.js';

/**
 * Aggregation-stage merging of clip matches.
 *
 * Chunks are searched independently, so the same moment can be reported more
 * than once: twice within one chunk, or as two pieces on either side of a chunk
 * boundary. Matches stay anchored to the chunk they were found in — that
 * provenance is not discarded — but before the search is reported as complete,
 * matches describing the same moment are collapsed into one.
 *
 * Two matches are merged when they are either:
 *   - immediately adjacent — separated by no more than `gapSeconds`, which is
 *     what a moment split across a chunk boundary looks like; or
 *   - substantially overlapping — their overlap covers at least
 *     `minOverlapRatio` of the shorter match, which is what a duplicate
 *     detection within one chunk looks like.
 *
 * Two long matches that merely graze each other are left alone: they are
 * distinct moments that happen to touch.
 */

export interface MergeableMatch {
  /** The chunk this match was found in. */
  chunkId: string;
  globalStartSeconds: number;
  globalEndSeconds: number;
  description: string;
  confidence: number;
  source: MatchSource;
  quote: string | null;
}

export interface AggregateOptions {
  /** Largest gap between two matches that still counts as one moment. */
  gapSeconds: number;
  /** Share of the shorter match that must be covered to count as a duplicate. */
  minOverlapRatio: number;
  /** Merging never produces a match longer than this. */
  maxDurationSeconds: number;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function duration(match: MergeableMatch): number {
  return match.globalEndSeconds - match.globalStartSeconds;
}

/** `earlier` must start no later than `later`. */
export function shouldMerge(
  earlier: MergeableMatch,
  later: MergeableMatch,
  options: AggregateOptions,
): boolean {
  const union = Math.max(earlier.globalEndSeconds, later.globalEndSeconds) - earlier.globalStartSeconds;
  if (union > options.maxDurationSeconds) return false;

  const gap = later.globalStartSeconds - earlier.globalEndSeconds;
  // Adjacency is evidence of one event only when two independent chunk
  // searches met at their boundary. Within one chunk, two nearby hits are two
  // hits: merging them also keeps everything between them, which is exactly
  // the unrelated footage a clip must not acquire. This additionally stops a
  // run of close results from chaining into one very long clip.
  if (gap >= 0) return earlier.chunkId !== later.chunkId && gap <= options.gapSeconds;

  const overlap = Math.min(earlier.globalEndSeconds, later.globalEndSeconds) - later.globalStartSeconds;
  const shorter = Math.min(duration(earlier), duration(later));
  if (shorter <= 0) return true;

  return overlap / shorter >= options.minOverlapRatio;
}

function combine(earlier: MergeableMatch, later: MergeableMatch): MergeableMatch {
  // The more confident match supplies the human-readable fields; the earlier
  // one supplies the anchor chunk, so the merged range never starts before the
  // chunk it is attributed to.
  const best = later.confidence > earlier.confidence ? later : earlier;

  return {
    chunkId: earlier.chunkId,
    globalStartSeconds: round(Math.min(earlier.globalStartSeconds, later.globalStartSeconds)),
    globalEndSeconds: round(Math.max(earlier.globalEndSeconds, later.globalEndSeconds)),
    description: best.description,
    confidence: Math.max(earlier.confidence, later.confidence),
    // A moment confirmed by both frames and speech is genuinely multimodal.
    source: earlier.source === later.source ? earlier.source : 'multimodal',
    quote: best.quote ?? earlier.quote ?? later.quote,
  };
}

/**
 * Collapses matches describing the same moment. Input may be in any order;
 * output is sorted by start time.
 */
export function aggregateMatches(matches: MergeableMatch[], options: AggregateOptions): MergeableMatch[] {
  if (matches.length <= 1) return [...matches];

  const sorted = [...matches].sort(
    (a, b) => a.globalStartSeconds - b.globalStartSeconds || a.globalEndSeconds - b.globalEndSeconds,
  );

  const merged: MergeableMatch[] = [];

  for (const match of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && shouldMerge(previous, match, options)) {
      merged[merged.length - 1] = combine(previous, match);
      continue;
    }
    merged.push({ ...match });
  }

  return merged;
}
