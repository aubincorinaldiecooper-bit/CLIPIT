import { queryOne, queryRows } from '../pool.js';

/**
 * What the system actually did, measured.
 *
 * Written because a claim and a measurement got confused: reading a video was
 * raised from four concurrent calls to eight, the setting said eight, and it
 * ran at four the whole time because every call passed through a gate sized
 * by a different setting. Nothing in the system could have contradicted the
 * claim, so nothing did.
 *
 * Everything here comes from rows written as the work happened. No
 * configuration is reported: what a thing is set to is not evidence that it
 * did it.
 */

export interface AnswerPerformance {
  /** 'notes' — recalled from what was written at upload. 'footage' — re-read. */
  answeredFrom: string;
  answers: number;
  medianSeconds: number | null;
  p95Seconds: number | null;
  medianCostUsd: number | null;
  totalCostUsd: number | null;
}

export interface ReadPerformance {
  reads: number;
  medianSeconds: number | null;
  p95Seconds: number | null;
  medianCostUsd: number | null;
  totalCostUsd: number | null;
  /** Seconds of video read per second of waiting. Higher is faster. */
  medianSecondsOfVideoPerSecond: number | null;
}

export interface PerformanceSummary {
  hours: number;
  answers: AnswerPerformance[];
  reads: ReadPerformance;
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(4)) : null;
}

export async function summarisePerformance(hours: number): Promise<PerformanceSummary> {
  const interval = `${Math.max(1, Math.floor(hours))} hours`;

  /**
   * How long a person waited, and what their question cost.
   *
   * The wait is from asking to being answered, which is the number they
   * actually experienced — not the time one model call took, which is a
   * component of it and has been mistaken for it before.
   */
  const answers = await queryRows<{
    answered_from: string;
    answers: number;
    median_seconds: string | null;
    p95_seconds: string | null;
    median_cost: string | null;
    total_cost: string | null;
  }>(
    `WITH per_request AS (
       SELECT r.id,
              r.answered_from,
              EXTRACT(EPOCH FROM (r.updated_at - r.created_at)) AS seconds,
              COALESCE(SUM(u.cost_usd), 0) AS cost
         FROM clip_requests r
         LEFT JOIN model_usage u ON u.clip_request_id = r.id
        WHERE r.status = 'completed'
          AND r.answered_from IS NOT NULL
          AND r.created_at >= now() - $1::interval
        GROUP BY r.id, r.answered_from, r.created_at, r.updated_at
     )
     SELECT answered_from,
            count(*)::int AS answers,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) AS median_seconds,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY seconds) AS p95_seconds,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY cost) AS median_cost,
            SUM(cost) AS total_cost
       FROM per_request
      GROUP BY answered_from
      ORDER BY answered_from`,
    [interval],
  );

  /**
   * Reading a video at upload. `index_ms` is recorded by the read itself, so
   * this is the real wall clock rather than the span between model calls,
   * which understates it by about one call.
   */
  const reads = await queryOne<{
    reads: number;
    median_seconds: string | null;
    p95_seconds: string | null;
    median_cost: string | null;
    total_cost: string | null;
    median_ratio: string | null;
  }>(
    `WITH per_video AS (
       SELECT v.id,
              v.index_ms / 1000.0 AS seconds,
              v.duration_seconds,
              COALESCE(SUM(u.cost_usd), 0) AS cost
         FROM videos v
         LEFT JOIN model_usage u ON u.video_id = v.id AND u.stage = 'indexing'
        WHERE v.index_ms IS NOT NULL
          AND v.updated_at >= now() - $1::interval
        GROUP BY v.id, v.index_ms, v.duration_seconds
     )
     SELECT count(*)::int AS reads,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY seconds) AS median_seconds,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY seconds) AS p95_seconds,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY cost) AS median_cost,
            SUM(cost) AS total_cost,
            percentile_cont(0.5) WITHIN GROUP (
              ORDER BY CASE WHEN seconds > 0 THEN duration_seconds / seconds END
            ) AS median_ratio
       FROM per_video`,
    [interval],
  );

  return {
    hours,
    answers: answers.map((row) => ({
      answeredFrom: row.answered_from,
      answers: row.answers,
      medianSeconds: toNumber(row.median_seconds),
      p95Seconds: toNumber(row.p95_seconds),
      medianCostUsd: toNumber(row.median_cost),
      totalCostUsd: toNumber(row.total_cost),
    })),
    reads: {
      reads: reads?.reads ?? 0,
      medianSeconds: toNumber(reads?.median_seconds),
      p95Seconds: toNumber(reads?.p95_seconds),
      medianCostUsd: toNumber(reads?.median_cost),
      totalCostUsd: toNumber(reads?.total_cost),
      medianSecondsOfVideoPerSecond: toNumber(reads?.median_ratio),
    },
  };
}
