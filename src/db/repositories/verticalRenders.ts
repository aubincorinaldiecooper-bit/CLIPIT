import { queryRows } from '../pool.js';
import type { FailureStage } from '../../services/media/verticalVisibility.js';

/**
 * The operational record behind a rule that hides things.
 *
 * Creators only see finished vertical moments. That makes a silently failing
 * pipeline indistinguishable, from the outside, from a video that simply had
 * fewer good moments in it — so every attempt is written here, successes
 * included, and nothing is ever deleted because a creator cannot see it.
 */

export interface RecordAttemptInput {
  videoId: string | null;
  clipRequestId: string | null;
  matchId: string | null;
  clipId: string | null;
  workspaceId: string | null;
  sessionId: string | null;
  requestedPlatform: string | null;
  presentationTarget: string;
  sourceWidth: number | null;
  sourceHeight: number | null;
  sourceAspect: string | null;
  targetAspect: string | null;
  targetWidth: number | null;
  targetHeight: number | null;
  compositionMode: string | null;
  provider: string | null;
  model: string | null;
  outcome: 'succeeded' | 'failed';
  failureStage: FailureStage | null;
  failureCode: string | null;
  /** Sanitised by the caller. Never a signed URL, token or credential. */
  failureMessage: string | null;
  attemptNumber: number;
  totalAttempts: number | null;
  compositionDecisionMs: number | null;
  derivativeRenderMs: number | null;
  posterGenerationMs: number | null;
}

/**
 * Write one attempt. Swallows its own errors like recordModelUsage does —
 * telemetry must never be the reason a render fails — but logs loudly,
 * because the migration-003 lesson was that a silently rejected insert can
 * hide a whole feature's data for weeks.
 */
export async function recordVerticalRenderAttempt(input: RecordAttemptInput): Promise<void> {
  await queryRows(
    `INSERT INTO vertical_render_attempts
       (video_id, clip_request_id, match_id, clip_id, workspace_id, session_id,
        requested_platform, presentation_target,
        source_width, source_height, source_aspect,
        target_aspect, target_width, target_height, composition_mode,
        provider, model, outcome, failure_stage, failure_code, failure_message,
        attempt_number, total_attempts,
        composition_decision_ms, derivative_render_ms, poster_generation_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
    [
      input.videoId, input.clipRequestId, input.matchId, input.clipId,
      input.workspaceId, input.sessionId,
      input.requestedPlatform, input.presentationTarget,
      input.sourceWidth, input.sourceHeight, input.sourceAspect,
      input.targetAspect, input.targetWidth, input.targetHeight, input.compositionMode,
      input.provider, input.model, input.outcome,
      input.failureStage, input.failureCode,
      input.failureMessage ? input.failureMessage.slice(0, 500) : null,
      input.attemptNumber, input.totalAttempts,
      input.compositionDecisionMs, input.derivativeRenderMs, input.posterGenerationMs,
    ],
  );
}

/**
 * Mark an earlier failure as recovered, so "retry recovery rate" is a query
 * rather than a guess. Called when a later attempt on the same candidate
 * succeeds.
 */
export async function markAttemptsRecovered(matchId: string): Promise<void> {
  await queryRows(
    `UPDATE vertical_render_attempts
        SET recovered_at = now()
      WHERE match_id = $1 AND outcome = 'failed' AND recovered_at IS NULL`,
    [matchId],
  );
}

export interface VerticalRenderMetrics {
  attempts: number;
  succeeded: number;
  failed: number;
  /** Candidates whose FIRST attempt succeeded, over candidates attempted. */
  firstAttemptSuccessRate: number | null;
  /** Failed attempts later recovered by a retry, over failed attempts. */
  retryRecoveryRate: number | null;
  successRate: number | null;
  byStage: Array<{ stage: string; failures: number }>;
  byPlatform: Array<{ platform: string | null; attempts: number; failed: number }>;
  byCompositionMode: Array<{ mode: string | null; attempts: number; failed: number }>;
  byModel: Array<{ provider: string | null; model: string | null; attempts: number; failed: number }>;
  latency: { p50RenderMs: number | null; p95RenderMs: number | null; avgRenderMs: number | null };
  /**
   * The quality number: candidates found and then withheld because the media
   * pipeline never finished them. Distinct from "the video had fewer moments".
   */
  suppressedCandidates: number;
}

const rate = (numerator: number, denominator: number): number | null =>
  denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;

/** Everything an operator needs to see whether the hidden half is healthy. */
export async function verticalRenderMetrics(sinceDays = 7): Promise<VerticalRenderMetrics> {
  const [totals] = await queryRows<{
    attempts: string; succeeded: string; failed: string;
    first_attempt_success: string; candidates: string;
    failed_attempts: string; recovered: string;
    p50: number | null; p95: number | null; avg: number | null;
  }>(
    `SELECT COUNT(*)                                                        AS attempts,
            COUNT(*) FILTER (WHERE outcome = 'succeeded')                   AS succeeded,
            COUNT(*) FILTER (WHERE outcome = 'failed')                      AS failed,
            COUNT(*) FILTER (WHERE outcome = 'succeeded' AND attempt_number = 1) AS first_attempt_success,
            COUNT(DISTINCT match_id)                                        AS candidates,
            COUNT(*) FILTER (WHERE outcome = 'failed')                      AS failed_attempts,
            COUNT(*) FILTER (WHERE outcome = 'failed' AND recovered_at IS NOT NULL) AS recovered,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY derivative_render_ms) AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY derivative_render_ms) AS p95,
            AVG(derivative_render_ms)                                       AS avg
       FROM vertical_render_attempts
      WHERE created_at > now() - make_interval(days => $1)`,
    [sinceDays],
  );

  const byStage = await queryRows<{ stage: string; failures: string }>(
    `SELECT failure_stage AS stage, COUNT(*) AS failures
       FROM vertical_render_attempts
      WHERE outcome = 'failed' AND failure_stage IS NOT NULL
        AND created_at > now() - make_interval(days => $1)
      GROUP BY failure_stage ORDER BY COUNT(*) DESC`,
    [sinceDays],
  );

  const byPlatform = await queryRows<{ platform: string | null; attempts: string; failed: string }>(
    `SELECT requested_platform AS platform, COUNT(*) AS attempts,
            COUNT(*) FILTER (WHERE outcome = 'failed') AS failed
       FROM vertical_render_attempts
      WHERE created_at > now() - make_interval(days => $1)
      GROUP BY requested_platform ORDER BY COUNT(*) DESC`,
    [sinceDays],
  );

  const byCompositionMode = await queryRows<{ mode: string | null; attempts: string; failed: string }>(
    `SELECT composition_mode AS mode, COUNT(*) AS attempts,
            COUNT(*) FILTER (WHERE outcome = 'failed') AS failed
       FROM vertical_render_attempts
      WHERE created_at > now() - make_interval(days => $1)
      GROUP BY composition_mode ORDER BY COUNT(*) DESC`,
    [sinceDays],
  );

  const byModel = await queryRows<{ provider: string | null; model: string | null; attempts: string; failed: string }>(
    `SELECT provider, model, COUNT(*) AS attempts,
            COUNT(*) FILTER (WHERE outcome = 'failed') AS failed
       FROM vertical_render_attempts
      WHERE created_at > now() - make_interval(days => $1)
      GROUP BY provider, model ORDER BY COUNT(*) DESC`,
    [sinceDays],
  );

  // A candidate is suppressed when every attempt on it failed and none was
  // ever recovered — found, then never finished, and therefore never shown.
  const [suppressed] = await queryRows<{ count: string }>(
    `SELECT COUNT(*) AS count FROM (
       SELECT match_id
         FROM vertical_render_attempts
        WHERE match_id IS NOT NULL
          AND created_at > now() - make_interval(days => $1)
        GROUP BY match_id
       HAVING COUNT(*) FILTER (WHERE outcome = 'succeeded') = 0
     ) AS never_finished`,
    [sinceDays],
  );

  const attempts = Number(totals?.attempts ?? 0);
  const succeeded = Number(totals?.succeeded ?? 0);
  const failed = Number(totals?.failed ?? 0);
  const candidates = Number(totals?.candidates ?? 0);
  const failedAttempts = Number(totals?.failed_attempts ?? 0);

  return {
    attempts,
    succeeded,
    failed,
    successRate: rate(succeeded, attempts),
    firstAttemptSuccessRate: rate(Number(totals?.first_attempt_success ?? 0), candidates),
    retryRecoveryRate: rate(Number(totals?.recovered ?? 0), failedAttempts),
    byStage: byStage.map((row) => ({ stage: row.stage, failures: Number(row.failures) })),
    byPlatform: byPlatform.map((row) => ({
      platform: row.platform, attempts: Number(row.attempts), failed: Number(row.failed),
    })),
    byCompositionMode: byCompositionMode.map((row) => ({
      mode: row.mode, attempts: Number(row.attempts), failed: Number(row.failed),
    })),
    byModel: byModel.map((row) => ({
      provider: row.provider, model: row.model, attempts: Number(row.attempts), failed: Number(row.failed),
    })),
    latency: {
      p50RenderMs: totals?.p50 ?? null,
      p95RenderMs: totals?.p95 ?? null,
      avgRenderMs: totals?.avg != null ? Math.round(Number(totals.avg)) : null,
    },
    suppressedCandidates: Number(suppressed?.count ?? 0),
  };
}
