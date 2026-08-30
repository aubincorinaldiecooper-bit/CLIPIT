import { env } from '../config/env.js';
import { queryOne, queryRows } from '../db/pool.js';

/**
 * The evaluation layer: what the numbers ARE, computed from rows.
 *
 * Every figure here is a count or a sum over things that happened — feedback
 * someone gave, boundaries someone moved, dollars a provider reported, GPU
 * milliseconds a deployment measured. Nothing is inferred from configuration,
 * and nothing is filled in where the rows are silent: a section with no data
 * says so, with its denominator, rather than showing a rate over nothing.
 *
 * Definitions worth pinning, because they are easy to quietly inflate:
 *
 * - "Observed miss rate" is NOT recall. It counts searches where someone
 *   explicitly said the moment they wanted was missing ('missed_moment'
 *   rejections), over searches that got any explicit moment feedback at all.
 *   True recall needs a labelled evaluation set; until one exists the word
 *   "recall" does not appear in this file.
 * - Timestamp ground truth is a deliberate act: an edited clip's final
 *   boundaries. A clip nobody touched is not evidence the prediction was
 *   perfect — it is reported in its own bucket, never averaged into error.
 * - Estimated cost is never presented as billed cost. Modal's JS SDK exposes
 *   no supported billing API, so the Modal side is measured GPU time × a
 *   configured rate, labelled estimated, and null when no rate is set.
 */

// ---------------------------------------------------------------------------
// Pure math — exported for tests, no database anywhere below this line until
// the queries section.
// ---------------------------------------------------------------------------

export interface BoundaryErrorInput {
  predictedStartSeconds: number;
  predictedEndSeconds: number;
  finalStartSeconds: number;
  finalEndSeconds: number;
}

export interface BoundaryError {
  /** final − predicted. Negative start: moved earlier. Positive end: extended. */
  startErrorSeconds: number;
  endErrorSeconds: number;
  absoluteStartErrorSeconds: number;
  absoluteEndErrorSeconds: number;
  /** (|start error| + |end error|) / 2 for this one clip. */
  boundaryMaeSeconds: number;
}

export function boundaryErrors(input: BoundaryErrorInput): BoundaryError {
  const startErrorSeconds = round3(input.finalStartSeconds - input.predictedStartSeconds);
  const endErrorSeconds = round3(input.finalEndSeconds - input.predictedEndSeconds);
  const absoluteStartErrorSeconds = Math.abs(startErrorSeconds);
  const absoluteEndErrorSeconds = Math.abs(endErrorSeconds);
  return {
    startErrorSeconds,
    endErrorSeconds,
    absoluteStartErrorSeconds,
    absoluteEndErrorSeconds,
    boundaryMaeSeconds: round3((absoluteStartErrorSeconds + absoluteEndErrorSeconds) / 2),
  };
}

export interface BoundaryErrorSummary {
  /** How many edited clips these numbers are computed over. */
  editedClips: number;
  startMaeSeconds: number | null;
  endMaeSeconds: number | null;
  /** Mean of per-clip boundary MAE. */
  boundaryMaeSeconds: number | null;
  /** Median of per-clip boundary MAE — a few terrible timestamps distort a mean. */
  medianBoundaryErrorSeconds: number | null;
  /** 90th percentile of per-clip boundary MAE — the bad-tail behaviour. */
  p90BoundaryErrorSeconds: number | null;
  /** Share of edited clips with BOTH boundaries within ±N seconds of final. */
  withinSeconds: { '1': number | null; '2': number | null; '3': number | null; '5': number | null };
  /** Signed averages: "usually starts 2.4s too late" lives here. */
  averageStartShiftSeconds: number | null;
  averageEndShiftSeconds: number | null;
}

export function summariseBoundaryErrors(errors: BoundaryError[]): BoundaryErrorSummary {
  if (errors.length === 0) {
    return {
      editedClips: 0,
      startMaeSeconds: null,
      endMaeSeconds: null,
      boundaryMaeSeconds: null,
      medianBoundaryErrorSeconds: null,
      p90BoundaryErrorSeconds: null,
      withinSeconds: { '1': null, '2': null, '3': null, '5': null },
      averageStartShiftSeconds: null,
      averageEndShiftSeconds: null,
    };
  }

  const count = errors.length;
  const maes = errors.map((error) => error.boundaryMaeSeconds).sort((a, b) => a - b);
  const within = (limit: number) =>
    round4(
      errors.filter(
        (error) => error.absoluteStartErrorSeconds <= limit && error.absoluteEndErrorSeconds <= limit,
      ).length / count,
    );

  return {
    editedClips: count,
    startMaeSeconds: round3(mean(errors.map((error) => error.absoluteStartErrorSeconds))),
    endMaeSeconds: round3(mean(errors.map((error) => error.absoluteEndErrorSeconds))),
    boundaryMaeSeconds: round3(mean(maes)),
    medianBoundaryErrorSeconds: round3(percentile(maes, 50)),
    p90BoundaryErrorSeconds: round3(percentile(maes, 90)),
    withinSeconds: { '1': within(1), '2': within(2), '3': within(3), '5': within(5) },
    averageStartShiftSeconds: round3(mean(errors.map((error) => error.startErrorSeconds))),
    averageEndShiftSeconds: round3(mean(errors.map((error) => error.endErrorSeconds))),
  };
}

/**
 * How far one Re-clip moved the boundaries it was asked to reconsider.
 *
 * Named boundary SHIFT everywhere, deliberately: this is the model moving
 * its own answer, which is a correction signal and nothing more. It is not
 * timestamp error, not MAE, not accuracy — those words are reserved for a
 * future benchmark with human-labelled ground truth.
 */
export interface BoundaryShift {
  startShiftSeconds: number;
  endShiftSeconds: number;
  absoluteStartShiftSeconds: number;
  absoluteEndShiftSeconds: number;
  /** (|start shift| + |end shift|) / 2 — one number per Re-clip. */
  averageBoundaryShiftSeconds: number;
}

export function boundaryShift(
  previous: { startSeconds: number; endSeconds: number },
  next: { startSeconds: number; endSeconds: number },
): BoundaryShift {
  const startShift = round3(next.startSeconds - previous.startSeconds);
  const endShift = round3(next.endSeconds - previous.endSeconds);
  return {
    startShiftSeconds: startShift,
    endShiftSeconds: endShift,
    absoluteStartShiftSeconds: Math.abs(startShift),
    absoluteEndShiftSeconds: Math.abs(endShift),
    averageBoundaryShiftSeconds: round3((Math.abs(startShift) + Math.abs(endShift)) / 2),
  };
}

export interface BoundaryShiftSummary {
  reclipsMeasured: number;
  averageAbsoluteStartShiftSeconds: number | null;
  averageAbsoluteEndShiftSeconds: number | null;
  /** Signed averages: a consistent sign is a finding ("starts move earlier"). */
  averageSignedStartShiftSeconds: number | null;
  averageSignedEndShiftSeconds: number | null;
  medianBoundaryShiftSeconds: number | null;
  p90BoundaryShiftSeconds: number | null;
  /** Share of Re-clips whose average shift stayed under each threshold. */
  withinSeconds: { '1': number | null; '2': number | null; '3': number | null; '5': number | null };
}

export function summariseBoundaryShifts(shifts: BoundaryShift[]): BoundaryShiftSummary {
  if (shifts.length === 0) {
    return {
      reclipsMeasured: 0,
      averageAbsoluteStartShiftSeconds: null,
      averageAbsoluteEndShiftSeconds: null,
      averageSignedStartShiftSeconds: null,
      averageSignedEndShiftSeconds: null,
      medianBoundaryShiftSeconds: null,
      p90BoundaryShiftSeconds: null,
      withinSeconds: { '1': null, '2': null, '3': null, '5': null },
    };
  }
  const averages = shifts.map((shift) => shift.averageBoundaryShiftSeconds).sort((a, b) => a - b);
  const within = (limit: number) => round4(shifts.filter((shift) => shift.averageBoundaryShiftSeconds < limit).length / shifts.length);
  return {
    reclipsMeasured: shifts.length,
    averageAbsoluteStartShiftSeconds: round3(mean(shifts.map((shift) => shift.absoluteStartShiftSeconds))),
    averageAbsoluteEndShiftSeconds: round3(mean(shifts.map((shift) => shift.absoluteEndShiftSeconds))),
    averageSignedStartShiftSeconds: round3(mean(shifts.map((shift) => shift.startShiftSeconds))),
    averageSignedEndShiftSeconds: round3(mean(shifts.map((shift) => shift.endShiftSeconds))),
    medianBoundaryShiftSeconds: round3(percentile(averages, 50)),
    p90BoundaryShiftSeconds: round3(percentile(averages, 90)),
    withinSeconds: { '1': within(1), '2': within(2), '3': within(3), '5': within(5) },
  };
}

/**
 * Dollars per hour of source video. Null when there was no measured source
 * time — a rate over zero footage is not a small number, it is no number.
 */
export function costPerSourceHour(costUsd: number, sourceSeconds: number): number | null {
  if (!Number.isFinite(costUsd) || !Number.isFinite(sourceSeconds) || sourceSeconds <= 0) return null;
  return round4(costUsd / (sourceSeconds / 3600));
}

/** Linear-interpolated percentile over a pre-sorted ascending list. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low]!;
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (rank - low);
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round3(value: number): number {
  return Number(value.toFixed(3));
}

function round4(value: number): number {
  return Number(value.toFixed(4));
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type DurationBucket = 'under_5m' | '5m_to_20m' | '20m_to_60m' | 'over_60m';

export interface EvaluationFilters {
  /**
   * Restrict usage-based numbers to one lane of work: 'initial' is
   * first-pass analysis (indexing + search), 'reclip' is re-evaluation.
   * Quality and boundary sections ignore it — a moment's feedback belongs
   * to the moment, not to a stage.
   */
  stage?: 'initial' | 'reclip';
  /** Inclusive lower bound on when the thing was created. */
  from?: Date;
  /** Exclusive upper bound. */
  to?: Date;
  provider?: string;
  model?: string;
  promptVersion?: string;
  durationBucket?: DurationBucket;
}

/** The CASE expression that buckets a video's duration, shared by every query. */
const DURATION_BUCKET_SQL = `CASE
  WHEN v.duration_seconds IS NULL THEN NULL
  WHEN v.duration_seconds < 300 THEN 'under_5m'
  WHEN v.duration_seconds < 1200 THEN '5m_to_20m'
  WHEN v.duration_seconds < 3600 THEN '20m_to_60m'
  ELSE 'over_60m'
END`;

/**
 * WHERE fragments for one query. `timeColumn` names the created-at column of
 * the primary table; match attribution columns live on the alias `m`, the
 * video on `v`. Queries that lack one of those aliases simply do not pass
 * the corresponding filter through to this builder.
 */
function buildWhere(
  filters: EvaluationFilters,
  options: { timeColumn: string; matchAlias?: string; videoAlias?: string },
): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const push = (clause: string, value: unknown) => {
    params.push(value);
    clauses.push(clause.replace('?', `$${params.length}`));
  };

  if (filters.from) push(`${options.timeColumn} >= ?`, filters.from);
  if (filters.to) push(`${options.timeColumn} < ?`, filters.to);
  if (options.matchAlias) {
    if (filters.provider) push(`${options.matchAlias}.provider = ?`, filters.provider);
    if (filters.model) push(`${options.matchAlias}.model = ?`, filters.model);
    if (filters.promptVersion) push(`${options.matchAlias}.prompt_version = ?`, filters.promptVersion);
  }
  if (options.videoAlias && filters.durationBucket) {
    push(`${DURATION_BUCKET_SQL.replaceAll('v.', `${options.videoAlias}.`)} = ?`, filters.durationBucket);
  }

  return { where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '', params };
}

// ---------------------------------------------------------------------------
// Quality — are the moments we surface useful?
// ---------------------------------------------------------------------------

export interface QualitySection {
  momentsReturned: number;
  momentsWithFeedback: number;
  thumbsUp: number;
  thumbsDown: number;
  /** thumbsUp / momentsWithFeedback. Null until anyone has said anything. */
  thumbsUpRate: number | null;
  thumbsDownRate: number | null;
  /** Rejection reasons, counted. Only rejections carry one. */
  reasons: Record<string, number>;
  /** Moments whose root clip actually rendered, over all returned moments. */
  clipsKept: number;
  acceptanceRate: number | null;
  /** Rows written before attribution existed — countable, not segmentable. */
  momentsWithoutAttribution: number;
}

async function qualitySection(filters: EvaluationFilters): Promise<QualitySection> {
  const { where, params } = buildWhere(filters, { timeColumn: 'm.created_at', matchAlias: 'm', videoAlias: 'v' });

  const totals = await queryOne<{
    moments: string;
    with_feedback: string;
    thumbs_up: string;
    thumbs_down: string;
    kept: string;
    unattributed: string;
  }>(
    `SELECT count(*)::bigint AS moments,
            count(*) FILTER (WHERE m.feedback IS NOT NULL)::bigint AS with_feedback,
            count(*) FILTER (WHERE m.feedback = 'approved')::bigint AS thumbs_up,
            count(*) FILTER (WHERE m.feedback = 'rejected')::bigint AS thumbs_down,
            count(*) FILTER (WHERE c.id IS NOT NULL AND c.status = 'ready')::bigint AS kept,
            count(*) FILTER (WHERE m.provider IS NULL)::bigint AS unattributed
       FROM clip_matches m
       JOIN clip_requests r ON r.id = m.clip_request_id
       JOIN videos v ON v.id = r.video_id
       LEFT JOIN clips c ON c.clip_match_id = m.id AND c.derived_from_clip_id IS NULL
       ${where}`,
    params,
  );

  const reasonRows = await queryRows<{ reason: string; count: string }>(
    `SELECT m.feedback_reason AS reason, count(*)::bigint AS count
       FROM clip_matches m
       JOIN clip_requests r ON r.id = m.clip_request_id
       JOIN videos v ON v.id = r.video_id
       ${where ? `${where} AND` : 'WHERE'} m.feedback_reason IS NOT NULL
      GROUP BY m.feedback_reason`,
    params,
  );

  const moments = toNumber(totals?.moments);
  const withFeedback = toNumber(totals?.with_feedback);
  const thumbsUp = toNumber(totals?.thumbs_up);
  const thumbsDown = toNumber(totals?.thumbs_down);
  const kept = toNumber(totals?.kept);

  return {
    momentsReturned: moments,
    momentsWithFeedback: withFeedback,
    thumbsUp,
    thumbsDown,
    thumbsUpRate: withFeedback > 0 ? round4(thumbsUp / withFeedback) : null,
    thumbsDownRate: withFeedback > 0 ? round4(thumbsDown / withFeedback) : null,
    reasons: Object.fromEntries(reasonRows.map((row) => [row.reason, toNumber(row.count)])),
    clipsKept: kept,
    acceptanceRate: moments > 0 ? round4(kept / moments) : null,
    momentsWithoutAttribution: toNumber(totals?.unattributed),
  };
}

// ---------------------------------------------------------------------------
// Searches — corrections and observed misses
// ---------------------------------------------------------------------------

export interface SearchSection {
  searchesCompleted: number;
  searchesWithResults: number;
  /** Searches a later "are you sure / look again" pointed back at. */
  searchesCorrected: number;
  correctionRate: number | null;
  /** Completed with at least one moment and never corrected, over completed. */
  noCorrectionSuccessRate: number | null;
  /**
   * Searches where a rejection said 'missed_moment', over searches with any
   * explicit moment feedback. An observed rate from behaviour — NOT recall.
   */
  searchesWithExplicitFeedback: number;
  searchesMarkedMissed: number;
  observedMissRate: number | null;
}

async function searchSection(filters: EvaluationFilters): Promise<SearchSection> {
  // Provider/model filters reach searches through their matches: a search
  // "belongs" to the lane that produced its results. Searches that returned
  // nothing carry no attribution and are excluded ONLY when such a filter is
  // set — with no filter they count, empty-handed searches being exactly the
  // ones correction behaviour is about.
  const lane: string[] = [];
  const params: unknown[] = [];
  const push = (clause: string, value: unknown) => {
    params.push(value);
    lane.push(clause.replace('?', `$${params.length}`));
  };
  if (filters.from) push('r.created_at >= ?', filters.from);
  if (filters.to) push('r.created_at < ?', filters.to);
  if (filters.durationBucket) push(`${DURATION_BUCKET_SQL} = ?`, filters.durationBucket);
  if (filters.provider) {
    push(`EXISTS (SELECT 1 FROM clip_matches lm WHERE lm.clip_request_id = r.id AND lm.provider = ?)`, filters.provider);
  }
  if (filters.model) {
    push(`EXISTS (SELECT 1 FROM clip_matches lm WHERE lm.clip_request_id = r.id AND lm.model = ?)`, filters.model);
  }
  if (filters.promptVersion) {
    push(
      `EXISTS (SELECT 1 FROM clip_matches lm WHERE lm.clip_request_id = r.id AND lm.prompt_version = ?)`,
      filters.promptVersion,
    );
  }
  const where = lane.length > 0 ? `AND ${lane.join(' AND ')}` : '';

  const totals = await queryOne<{
    completed: string;
    with_results: string;
    corrected: string;
    with_feedback: string;
    marked_missed: string;
  }>(
    `SELECT count(*)::bigint AS completed,
            count(*) FILTER (
              WHERE EXISTS (SELECT 1 FROM clip_matches fm WHERE fm.clip_request_id = r.id)
            )::bigint AS with_results,
            count(*) FILTER (
              WHERE EXISTS (SELECT 1 FROM clip_requests c2 WHERE c2.corrected_request_id = r.id)
            )::bigint AS corrected,
            count(*) FILTER (
              WHERE EXISTS (SELECT 1 FROM clip_matches fm WHERE fm.clip_request_id = r.id AND fm.feedback IS NOT NULL)
            )::bigint AS with_feedback,
            count(*) FILTER (
              WHERE EXISTS (
                SELECT 1 FROM clip_matches fm
                 WHERE fm.clip_request_id = r.id AND fm.feedback_reason = 'missed_moment'
              )
            )::bigint AS marked_missed
       FROM clip_requests r
       JOIN videos v ON v.id = r.video_id
      WHERE r.status = 'completed' ${where}`,
    params,
  );

  const completed = toNumber(totals?.completed);
  const withResults = toNumber(totals?.with_results);
  const corrected = toNumber(totals?.corrected);
  const withFeedback = toNumber(totals?.with_feedback);
  const markedMissed = toNumber(totals?.marked_missed);

  // "Succeeded without correction" needs both facts about the same search:
  // it found something AND nobody sent it back.
  const uncorrectedWithResults = await queryOne<{ count: string }>(
    `SELECT count(*)::bigint AS count
       FROM clip_requests r
       JOIN videos v ON v.id = r.video_id
      WHERE r.status = 'completed' ${where}
        AND EXISTS (SELECT 1 FROM clip_matches fm WHERE fm.clip_request_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM clip_requests c2 WHERE c2.corrected_request_id = r.id)`,
    params,
  );

  return {
    searchesCompleted: completed,
    searchesWithResults: withResults,
    searchesCorrected: corrected,
    correctionRate: completed > 0 ? round4(corrected / completed) : null,
    noCorrectionSuccessRate: completed > 0 ? round4(toNumber(uncorrectedWithResults?.count) / completed) : null,
    searchesWithExplicitFeedback: withFeedback,
    searchesMarkedMissed: markedMissed,
    observedMissRate: withFeedback > 0 ? round4(markedMissed / withFeedback) : null,
  };
}

// ---------------------------------------------------------------------------
// Timestamps — the most important section
// ---------------------------------------------------------------------------

export interface BoundarySection {
  /**
   * The denominator everything below shares: moments a person actually
   * reviewed — explicit thumbs feedback, or at least one Re-clip (asking for
   * a retry IS a review of the first result). Unreviewed moments are counted
   * separately and never treated as successes or failures.
   */
  eligibleReviewedMoments: number;
  momentsNeverReviewed: number;
  /**
   * "How often does Clipit get the moment right on the first try?"
   * Approved with ZERO Re-clips, over eligible reviewed moments.
   */
  firstPassSuccesses: number;
  firstPassSuccessRate: number | null;
  /** Reviewed moments that asked for at least one Re-clip, over eligible. */
  momentsReclipped: number;
  reclipRate: number | null;
  /**
   * Did Re-clip help? Among re-clipped moments whose person gave a verdict
   * AFTER the last Re-clip finished: how many approved. A replacement nobody
   * judged is not counted as accepted — generating one is not acceptance.
   */
  reviewedReclips: number;
  acceptedReclips: number;
  reclipAcceptanceRate: number | null;
  /**
   * Moments whose rejection said "Timing is off" ('bad_boundaries'), over
   * moments with explicit feedback. The live proxy for boundary quality.
   */
  momentsWithExplicitFeedback: number;
  timingDownvotes: number;
  timingDownvoteRate: number | null;
  /** How far Re-clips moved boundaries. A correction signal — never accuracy. */
  shifts: BoundaryShiftSummary;
}

async function boundarySection(filters: EvaluationFilters): Promise<BoundarySection> {
  const { where, params } = buildWhere(filters, { timeColumn: 'm.created_at', matchAlias: 'm', videoAlias: 'v' });

  const totals = await queryOne<{
    eligible: string;
    never_reviewed: string;
    first_pass: string;
    reclipped: string;
    reviewed_reclips: string;
    accepted_reclips: string;
    with_feedback: string;
    timing_downvotes: string;
  }>(
    `WITH moments AS (
       SELECT m.id,
              m.feedback,
              m.feedback_reason,
              m.feedback_at,
              (SELECT count(*) FROM moment_versions mv
                WHERE mv.match_id = m.id AND mv.trigger = 'reclip')::int AS reclips,
              (SELECT max(mv.created_at) FROM moment_versions mv
                WHERE mv.match_id = m.id AND mv.trigger = 'reclip') AS last_reclip_at
         FROM clip_matches m
         JOIN clip_requests r ON r.id = m.clip_request_id
         JOIN videos v ON v.id = r.video_id
         ${where}
     )
     SELECT count(*) FILTER (WHERE feedback IS NOT NULL OR reclips > 0)::bigint AS eligible,
            count(*) FILTER (WHERE feedback IS NULL AND reclips = 0)::bigint AS never_reviewed,
            count(*) FILTER (WHERE feedback = 'approved' AND reclips = 0)::bigint AS first_pass,
            count(*) FILTER (WHERE reclips > 0)::bigint AS reclipped,
            count(*) FILTER (WHERE reclips > 0 AND feedback IS NOT NULL
                               AND feedback_at >= last_reclip_at)::bigint AS reviewed_reclips,
            count(*) FILTER (WHERE reclips > 0 AND feedback = 'approved'
                               AND feedback_at >= last_reclip_at)::bigint AS accepted_reclips,
            count(*) FILTER (WHERE feedback IS NOT NULL)::bigint AS with_feedback,
            count(*) FILTER (WHERE feedback_reason = 'bad_boundaries')::bigint AS timing_downvotes
       FROM moments`,
    params,
  );

  // Consecutive version pairs: every 'reclip' row against the version before
  // it, so a second Re-clip measures movement from the first, not from the
  // original twice.
  const shiftRows = await queryRows<{
    prev_start: string;
    prev_end: string;
    next_start: string;
    next_end: string;
  }>(
    `SELECT lag(mv.start_seconds) OVER w AS prev_start,
            lag(mv.end_seconds) OVER w AS prev_end,
            mv.start_seconds AS next_start,
            mv.end_seconds AS next_end,
            mv.trigger
       FROM moment_versions mv
       JOIN clip_matches m ON m.id = mv.match_id
       JOIN clip_requests r ON r.id = m.clip_request_id
       JOIN videos v ON v.id = r.video_id
       ${where}
     WINDOW w AS (PARTITION BY mv.match_id ORDER BY mv.version)`,
    params,
  ).then((rows) =>
    rows.filter(
      (row) => (row as unknown as { trigger: string }).trigger === 'reclip' && row.prev_start !== null,
    ),
  );

  const shifts = shiftRows.map((row) =>
    boundaryShift(
      { startSeconds: toNumber(row.prev_start), endSeconds: toNumber(row.prev_end) },
      { startSeconds: toNumber(row.next_start), endSeconds: toNumber(row.next_end) },
    ),
  );

  const eligible = toNumber(totals?.eligible);
  const firstPass = toNumber(totals?.first_pass);
  const reclipped = toNumber(totals?.reclipped);
  const reviewedReclips = toNumber(totals?.reviewed_reclips);
  const acceptedReclips = toNumber(totals?.accepted_reclips);
  const withFeedback = toNumber(totals?.with_feedback);
  const timingDownvotes = toNumber(totals?.timing_downvotes);

  return {
    eligibleReviewedMoments: eligible,
    momentsNeverReviewed: toNumber(totals?.never_reviewed),
    firstPassSuccesses: firstPass,
    firstPassSuccessRate: eligible > 0 ? round4(firstPass / eligible) : null,
    momentsReclipped: reclipped,
    reclipRate: eligible > 0 ? round4(reclipped / eligible) : null,
    reviewedReclips,
    acceptedReclips,
    reclipAcceptanceRate: reviewedReclips > 0 ? round4(acceptedReclips / reviewedReclips) : null,
    momentsWithExplicitFeedback: withFeedback,
    timingDownvotes,
    timingDownvoteRate: withFeedback > 0 ? round4(timingDownvotes / withFeedback) : null,
    shifts: summariseBoundaryShifts(shifts),
  };
}

/**
 * True timestamp accuracy needs a human-labelled evaluation set: a video, an
 * expected moment, and boundaries a person approved as correct. None exists
 * yet, and nothing in production substitutes for it — Re-clip shifts are the
 * model reconsidering itself. Until labelled data exists this section says
 * exactly that, instead of a misleading zero.
 */
export interface LabelledAccuracySection {
  available: false;
  note: string;
}

function labelledAccuracySection(): LabelledAccuracySection {
  return {
    available: false,
    note: 'Insufficient labelled data. Timestamp MAE, ±Ns accuracy, precision and recall require a human-labelled benchmark; Re-clip boundary shifts are not ground truth.',
  };
}

// ---------------------------------------------------------------------------
// Performance & economics — what the work cost
// ---------------------------------------------------------------------------

export interface UsageSegment {
  provider: string;
  model: string;
  stage: string;
  calls: number;
  callsMissingCost: number;
  totalCostUsd: number | null;
  totalLatencyMs: number;
  /** Modal only: the deployment's own inference/download measurements, summed. */
  totalInferenceMs: number | null;
  totalDownloadMs: number | null;
  /** GPU time the estimate is priced over: metrics.total_ms, else latency. */
  totalGpuMsForEstimate: number | null;
  estimatedCostUsd: number | null;
}

export interface EconomicsSection {
  /** Hours of source video whose read finished in range — the denominator. */
  sourceVideoHoursAnalyzed: number;
  videosAnalyzed: number;
  totalAnalysisWallMs: number;
  /** Reported dollars (OpenRouter returns real cost per call). */
  actualReportedCostUsd: number;
  /** Measured Modal GPU-time × the configured rate. Never billed truth. */
  estimatedModalCostUsd: number | null;
  modalRateUsdPerGpuHour: number | null;
  /**
   * (actual + estimated attributable model cost) / source hours. "Marginal"
   * because it prices completed calls only: failed calls before a usage row,
   * cold-start scheduling and warm idle are invisible to these rows.
   */
  marginalCostPerSourceHourUsd: number | null;
  /**
   * Always null today, on purpose: an effective all-in number needs actual
   * Modal spend for the window, and no supported API provides it. Divide the
   * dashboard's billed total by sourceVideoHoursAnalyzed for the real thing.
   */
  effectiveCostPerSourceHourUsd: null;
  /** Modal inference seconds per source hour, where the deployment reported it. */
  inferenceSecondsPerSourceHour: number | null;
  /**
   * First-pass analysis vs Re-clip, kept apart so re-evaluation spend is a
   * visible line item. 'initial' is indexing + search; speech-to-text is in
   * segments but is not moment analysis. Costs combine reported provider
   * dollars with the Modal estimate where a rate is configured.
   */
  initialAnalysisCalls: number;
  reclipCalls: number;
  initialInferenceMs: number | null;
  reclipInferenceMs: number | null;
  initialCostUsd: number | null;
  reclipCostUsd: number | null;
  /** Re-clip cost over all analysis cost (initial + reclip). */
  reclipCostShare: number | null;
  /** Wall-clock read time per source hour: how far from real-time the read runs. */
  analysisMsPerSourceHour: number | null;
  segments: UsageSegment[];
}

async function economicsSection(filters: EvaluationFilters): Promise<EconomicsSection> {
  // The denominator: videos whose read completed in range. Buckets and time
  // bounds apply; provider/model filters apply to the usage rows below.
  const videoLane: string[] = [];
  const videoParams: unknown[] = [];
  const pushVideo = (clause: string, value: unknown) => {
    videoParams.push(clause.includes('?') ? value : value);
    videoLane.push(clause.replace('?', `$${videoParams.length}`));
  };
  if (filters.from) pushVideo('v.created_at >= ?', filters.from);
  if (filters.to) pushVideo('v.created_at < ?', filters.to);
  if (filters.durationBucket) pushVideo(`${DURATION_BUCKET_SQL} = ?`, filters.durationBucket);
  // A lane filter must narrow the DENOMINATOR too: cost from one provider
  // divided by hours every provider analyzed understates that provider's
  // rate exactly when a comparison is being made. A video belongs to a lane
  // when that lane's calls read it.
  if (filters.provider) {
    pushVideo(
      `EXISTS (SELECT 1 FROM model_usage lu WHERE lu.video_id = v.id AND lu.stage = 'indexing' AND lu.provider = ?)`,
      filters.provider,
    );
  }
  if (filters.model) {
    pushVideo(
      `EXISTS (SELECT 1 FROM model_usage lu WHERE lu.video_id = v.id AND lu.stage = 'indexing' AND lu.model = ?)`,
      filters.model,
    );
  }
  if (filters.promptVersion) {
    pushVideo(
      `EXISTS (SELECT 1 FROM model_usage lu WHERE lu.video_id = v.id AND lu.stage = 'indexing' AND lu.prompt_version = ?)`,
      filters.promptVersion,
    );
  }

  const videoTotals = await queryOne<{ videos: string; seconds: string; wall_ms: string }>(
    `SELECT count(*)::bigint AS videos,
            COALESCE(sum(v.duration_seconds), 0) AS seconds,
            COALESCE(sum(v.index_ms), 0)::bigint AS wall_ms
       FROM videos v
      WHERE v.index_status = 'ready' ${videoLane.length > 0 ? `AND ${videoLane.join(' AND ')}` : ''}`,
    videoParams,
  );

  const usageLane: string[] = [];
  const usageParams: unknown[] = [];
  const pushUsage = (clause: string, value: unknown) => {
    usageParams.push(value);
    usageLane.push(clause.replace('?', `$${usageParams.length}`));
  };
  if (filters.from) pushUsage('u.created_at >= ?', filters.from);
  if (filters.to) pushUsage('u.created_at < ?', filters.to);
  if (filters.provider) pushUsage('u.provider = ?', filters.provider);
  if (filters.model) pushUsage('u.model = ?', filters.model);
  if (filters.promptVersion) pushUsage('u.prompt_version = ?', filters.promptVersion);
  if (filters.stage === 'reclip') pushUsage("u.stage = ?", 'reclip');
  if (filters.stage === 'initial') {
    usageParams.push('indexing', 'search');
    usageLane.push(`u.stage IN ($${usageParams.length - 1}, $${usageParams.length})`);
  }
  if (filters.durationBucket) {
    pushUsage(
      `u.video_id IN (SELECT v.id FROM videos v WHERE ${DURATION_BUCKET_SQL} = ?)`,
      filters.durationBucket,
    );
  }

  const segmentRows = await queryRows<{
    provider: string;
    model: string;
    stage: string;
    calls: string;
    missing_cost: string;
    cost_usd: string | null;
    latency_ms: string;
    inference_ms: string | null;
    download_ms: string | null;
    gpu_ms: string | null;
  }>(
    `SELECT u.provider,
            u.model,
            u.stage,
            count(*)::bigint AS calls,
            count(*) FILTER (WHERE u.cost_usd IS NULL)::bigint AS missing_cost,
            sum(u.cost_usd) AS cost_usd,
            COALESCE(sum(u.latency_ms), 0)::bigint AS latency_ms,
            sum((u.metrics->>'inference_ms')::numeric) AS inference_ms,
            sum((u.metrics->>'download_ms')::numeric) AS download_ms,
            sum(COALESCE((u.metrics->>'total_ms')::numeric, u.latency_ms)) FILTER (WHERE u.provider = 'modal') AS gpu_ms
       FROM model_usage u
       ${usageLane.length > 0 ? `WHERE ${usageLane.join(' AND ')}` : ''}
      GROUP BY u.provider, u.model, u.stage
      ORDER BY u.provider, u.model, u.stage`,
    usageParams,
  );

  const rate = env.MODAL_L4_USD_PER_GPU_HOUR;
  const segments: UsageSegment[] = segmentRows.map((row) => {
    const gpuMs = row.gpu_ms === null ? null : toNumber(row.gpu_ms);
    const estimated = row.provider === 'modal' && rate !== null && gpuMs !== null
      ? round4((gpuMs / 3_600_000) * rate)
      : null;
    return {
      provider: row.provider,
      model: row.model,
      stage: row.stage,
      calls: toNumber(row.calls),
      callsMissingCost: toNumber(row.missing_cost),
      totalCostUsd: row.cost_usd === null ? null : round4(toNumber(row.cost_usd)),
      totalLatencyMs: toNumber(row.latency_ms),
      totalInferenceMs: row.inference_ms === null ? null : Math.round(toNumber(row.inference_ms)),
      totalDownloadMs: row.download_ms === null ? null : Math.round(toNumber(row.download_ms)),
      totalGpuMsForEstimate: gpuMs === null ? null : Math.round(gpuMs),
      estimatedCostUsd: estimated,
    };
  });

  const sourceSeconds = toNumber(videoTotals?.seconds);
  const sourceHours = sourceSeconds / 3600;
  const actualCost = segments.reduce((sum, segment) => sum + (segment.totalCostUsd ?? 0), 0);
  const modalGpuMs = segments
    .filter((segment) => segment.provider === 'modal')
    .reduce((sum, segment) => sum + (segment.totalGpuMsForEstimate ?? 0), 0);
  const modalInferenceMs = segments
    .filter((segment) => segment.provider === 'modal' && segment.totalInferenceMs !== null)
    .reduce((sum, segment) => sum + (segment.totalInferenceMs ?? 0), 0);
  const estimatedModal = rate !== null ? round4((modalGpuMs / 3_600_000) * rate) : null;
  const wallMs = toNumber(videoTotals?.wall_ms);

  // The initial-vs-reclip split. A segment's spend is its reported dollars
  // plus its Modal estimate; when neither exists the split stays null rather
  // than reading as free.
  const segmentSpend = (segment: UsageSegment): number | null => {
    if (segment.totalCostUsd === null && segment.estimatedCostUsd === null) return null;
    return (segment.totalCostUsd ?? 0) + (segment.estimatedCostUsd ?? 0);
  };
  const initialSegments = segments.filter((segment) => segment.stage === 'indexing' || segment.stage === 'search');
  const reclipSegments = segments.filter((segment) => segment.stage === 'reclip');
  const sumOrNull = (values: Array<number | null>): number | null => {
    const present = values.filter((value): value is number => value !== null);
    return present.length > 0 ? round4(present.reduce((sum, value) => sum + value, 0)) : null;
  };
  const initialCalls = initialSegments.reduce((sum, segment) => sum + segment.calls, 0);
  const reclipCalls = reclipSegments.reduce((sum, segment) => sum + segment.calls, 0);
  const initialInferenceMs = sumOrNull(initialSegments.map((segment) => segment.totalInferenceMs));
  const reclipInferenceMs = sumOrNull(reclipSegments.map((segment) => segment.totalInferenceMs));
  const initialCost = sumOrNull(initialSegments.map(segmentSpend));
  const reclipCost = sumOrNull(reclipSegments.map(segmentSpend));
  const analysisCost = (initialCost ?? 0) + (reclipCost ?? 0);
  const reclipCostShare =
    reclipCost !== null && analysisCost > 0 ? round4(reclipCost / analysisCost) : null;

  return {
    sourceVideoHoursAnalyzed: round4(sourceHours),
    videosAnalyzed: toNumber(videoTotals?.videos),
    totalAnalysisWallMs: wallMs,
    actualReportedCostUsd: round4(actualCost),
    estimatedModalCostUsd: estimatedModal,
    modalRateUsdPerGpuHour: rate,
    marginalCostPerSourceHourUsd:
      sourceSeconds > 0 ? costPerSourceHour(actualCost + (estimatedModal ?? 0), sourceSeconds) : null,
    effectiveCostPerSourceHourUsd: null,
    inferenceSecondsPerSourceHour:
      sourceHours > 0 && modalInferenceMs > 0 ? round4(modalInferenceMs / 1000 / sourceHours) : null,
    initialAnalysisCalls: initialCalls,
    reclipCalls,
    initialInferenceMs: initialInferenceMs === null ? null : Math.round(initialInferenceMs),
    reclipInferenceMs: reclipInferenceMs === null ? null : Math.round(reclipInferenceMs),
    initialCostUsd: initialCost,
    reclipCostUsd: reclipCost,
    reclipCostShare,
    analysisMsPerSourceHour: sourceHours > 0 && wallMs > 0 ? Math.round(wallMs / sourceHours) : null,
    segments,
  };
}

// ---------------------------------------------------------------------------
// The whole report
// ---------------------------------------------------------------------------

export interface EvaluationReport {
  filters: {
    from: string | null;
    to: string | null;
    provider: string | null;
    model: string | null;
    promptVersion: string | null;
    durationBucket: DurationBucket | null;
  };
  quality: QualitySection;
  searches: SearchSection;
  boundaries: BoundarySection;
  labelledAccuracy: LabelledAccuracySection;
  economics: EconomicsSection;
  /** Standing caveats a reader must not discover the hard way. */
  notes: string[];
}

export async function evaluationReport(filters: EvaluationFilters): Promise<EvaluationReport> {
  const [quality, searches, boundaries, economics] = await Promise.all([
    qualitySection(filters),
    searchSection(filters),
    boundarySection(filters),
    economicsSection(filters),
  ]);

  const notes = [
    'Observed miss rate counts explicit missed_moment rejections over searches with any moment feedback. It is behavioural evidence, not labelled recall.',
    'Boundary shift measures how far Re-clip moved the boundaries it reconsidered. It is the model correcting itself — a correction signal, never timestamp error or accuracy.',
    "First-pass success counts moments approved with zero Re-clips, over moments a person reviewed (explicit feedback or at least one Re-clip). Unreviewed moments are excluded from the denominator, not assumed successful.",
    'Estimated Modal cost is measured GPU milliseconds × the configured rate. It excludes failed calls that never wrote a usage row, cold-start scheduling, and warm idle; the billed number on the Modal dashboard is the effective truth.',
    'Re-clip cost share compares the reclip stage against the analysis stages (indexing, search, reclip). Speech-to-text is reported in segments but is not moment analysis.',
  ];
  if (quality.momentsWithoutAttribution > 0) {
    notes.push(
      `${quality.momentsWithoutAttribution} moments predate provider attribution and appear in totals but not in provider/model segments.`,
    );
  }
  if (economics.modalRateUsdPerGpuHour === null) {
    notes.push('MODAL_L4_USD_PER_GPU_HOUR is not set, so Modal cost estimates are null rather than guessed.');
  }

  return {
    filters: {
      from: filters.from?.toISOString() ?? null,
      to: filters.to?.toISOString() ?? null,
      provider: filters.provider ?? null,
      model: filters.model ?? null,
      promptVersion: filters.promptVersion ?? null,
      durationBucket: filters.durationBucket ?? null,
    },
    quality,
    searches,
    boundaries,
    labelledAccuracy: labelledAccuracySection(),
    economics,
    notes,
  };
}
