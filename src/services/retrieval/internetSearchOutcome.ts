import type {
  InternetSearchFailure,
  InternetSearchFailureKind,
  InternetSearchOutcome,
  InternetSearchProgress,
} from '../../queues/internetSearch.js';

/**
 * What a finished internet search is allowed to tell the person.
 *
 * On 17 September a search found twenty pages, took the top seven, and failed
 * every one of the twenty-eight watches against them because the deployed
 * watcher had no `watch_stream` to call. Not one frame was sent. The search
 * then reported itself completed with no moments, and the screen drew "no
 * results" — an absence nobody had verified, about videos nobody had opened.
 *
 * So the ending is decided here, from whether the videos were actually
 * watched, and never from how many moments came back. The two are separate
 * questions. A watch that succeeded and found nothing is an answer about the
 * video. A watch that failed and found nothing is an answer about us.
 *
 * This deliberately knows nothing about relevance. It does not read moments,
 * score them, or decide which are worth keeping — it counts videos that were
 * opened and videos that were not.
 */

/** What is known about coverage once the watchers have stopped. */
export interface InternetSearchCoverage {
  /** Video pages handed to the scouts. */
  candidatesFound: number;
  /** Of those, the ones at least one scout got any watch out of at all. */
  candidatesWatched: number;
  /**
   * Of those, the ones watched right through with nothing failing.
   *
   * Counted separately because coverage can be lost inside a single video as
   * well as across the set: four scouts take a quarter of a video each, and
   * three succeeding while the fourth fails leaves a quarter nobody opened.
   * That video was watched, but not watched through, and a search resting on
   * it has not earned the right to say the thing was not there.
   */
  candidatesFullyWatched: number;
  /** Moments approved across every video. Never decides the outcome alone. */
  momentsFound: number;
  /** Every failed inspection's reason, verbatim, in the order they happened. */
  failureReasons: readonly string[];
}

/** The ending, and the little of it that is safe to send to a browser. */
export interface InternetSearchEnding {
  phase: 'answered' | 'failed';
  outcome: InternetSearchOutcome;
  candidatesWatched: number;
  failure?: InternetSearchFailure;
}

/**
 * Least-ambiguous first: a reason that names a missing method or a rejected
 * credential says what is wrong, and a bare timeout is a symptom of anything.
 * The order is also the tie-break when a search fails several ways at once.
 */
const KINDS: ReadonlyArray<[InternetSearchFailureKind, RegExp]> = [
  ['video_model_unavailable', /not found on class|cannot find \S+\/\S+ in |is not configured|rejected Clipit's credentials|cannot read source kind/i],
  ['browser_unavailable', /browser refused to watch|never started playing|could not open the page|web[- ]access/i],
  ['video_model_failed', /Modal internal failure|failed remotely|Modal call failed|live watch failed|returned (?:an )?invalid|could not create live video queue|queue item limit/i],
  ['timed_out', /timed out|timeout|exceeded the \d+s client deadline|exceeded its Modal timeout/i],
];

/**
 * The coarse shape of one failure.
 *
 * Matching our own error text is imprecise by nature, so `unknown` is a real
 * answer and not a last resort to be avoided — a wrong label would be worse
 * than no label. Nothing is lost either way: the verbatim reasons go to the
 * log regardless of what this returns.
 */
export function classifyFailure(reason: string): InternetSearchFailureKind {
  for (const [kind, pattern] of KINDS) if (pattern.test(reason)) return kind;
  return 'unknown';
}

/** The kind that failed most often; ties go to the least ambiguous kind. */
function summarise(reasons: readonly string[]): InternetSearchFailure | undefined {
  if (reasons.length === 0) return undefined;
  const tally = new Map<InternetSearchFailureKind, number>();
  for (const reason of reasons) {
    const kind = classifyFailure(reason);
    tally.set(kind, (tally.get(kind) ?? 0) + 1);
  }
  const ranked = [...KINDS.map(([kind]) => kind), 'unknown' as const];
  let best: InternetSearchFailureKind = 'unknown';
  let bestCount = -1;
  for (const kind of ranked) {
    const count = tally.get(kind) ?? 0;
    if (count > bestCount) { best = kind; bestCount = count; }
  }
  return { kind: best, count: reasons.length };
}

/**
 * Decide how a search ended.
 *
 * Only two endings are allowed to mean "we looked and there is nothing":
 * `no_candidates`, where there was nothing to look at, and `no_matches`, where
 * every video found was watched right through and did not contain the thing.
 * Every other ending carries the fact that some of the looking did not happen,
 * because the screen must not draw it as an answer about the videos.
 */
export function decideEnding(coverage: InternetSearchCoverage): InternetSearchEnding {
  const found = Math.max(0, coverage.candidatesFound);
  const watched = Math.max(0, Math.min(found, coverage.candidatesWatched));
  const throughout = Math.max(0, Math.min(watched, coverage.candidatesFullyWatched));
  const failure = summarise(coverage.failureReasons);

  if (found === 0) return { phase: 'answered', outcome: 'no_candidates', candidatesWatched: 0 };
  if (watched === 0) return { phase: 'failed', outcome: 'watch_failed', candidatesWatched: 0, ...(failure ? { failure } : {}) };
  if (throughout < found) return { phase: 'answered', outcome: 'partly_watched', candidatesWatched: watched, ...(failure ? { failure } : {}) };
  if (coverage.momentsFound === 0) return { phase: 'answered', outcome: 'no_matches', candidatesWatched: watched, ...(failure ? { failure } : {}) };
  return { phase: 'answered', outcome: 'matched', candidatesWatched: watched, ...(failure ? { failure } : {}) };
}

/**
 * True when an empty result may be drawn as "nothing matched".
 *
 * The screen has its own copy of this rule; this is the one the server tests
 * hold, so the two cannot drift apart silently.
 */
export function meansNothingMatched(progress: Pick<InternetSearchProgress, 'outcome'>): boolean {
  return progress.outcome === 'no_candidates' || progress.outcome === 'no_matches';
}
