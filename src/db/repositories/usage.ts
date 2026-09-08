import { queryOne, queryRows } from '../pool.js';
import { logger } from '../../lib/logger.js';

/** What caused a model call. */
// 'reclip' is its own stage on purpose: re-evaluation spend must never
// blend into first-pass analysis, or the re-clip cost share — a business
// number — stops existing. 'composition' is separate for the same reason:
// what it costs to decide how a moment should be FRAMED is a different
// question from what it costs to FIND it, and the answer only exists if the
// rows keep them apart.
export type UsageStage =
  | 'transcription'
  | 'indexing'
  | 'search'
  | 'reclip'
  | 'composition'
  // The Media Index's two halves, costed apart: making the vectors, and
  // ranking the shortlist they produce. Rolled together they would hide
  // which half the money goes to.
  | 'embedding'
  | 'rerank';

export interface ModelTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Dollars for this call, when the provider reports it (OpenRouter does). */
  costUsd?: number | null;
  /** Wall-clock time for the request, when the caller measured it. */
  latencyMs?: number | null;
  /** The provider's own measurements, verbatim (Modal: download_ms / inference_ms / total_ms). */
  metrics?: Record<string, unknown> | null;
  /** When the request left, so completion (created_at) and departure are both on record. */
  startedAt?: Date | null;
  /** Hash of the prompt the call was asked under — see prompt.ts promptVersion(). */
  promptVersion?: string | null;
}

export interface RecordUsageInput extends ModelTokenUsage {
  videoId?: string | null;
  clipRequestId?: string | null;
  provider: string;
  model: string;
  stage: UsageStage;
}

/**
 * Appends one usage row.
 *
 * Never throws: usage is observability, and losing a row is always preferable
 * to failing the work that produced it.
 */
export async function recordModelUsage(input: RecordUsageInput): Promise<void> {
  try {
    await queryOne(
      `INSERT INTO model_usage
         (video_id, clip_request_id, provider, model, stage,
          prompt_tokens, completion_tokens, total_tokens, cost_usd, latency_ms,
          metrics, started_at, prompt_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        input.videoId ?? null,
        input.clipRequestId ?? null,
        input.provider,
        input.model,
        input.stage,
        input.promptTokens,
        input.completionTokens,
        input.totalTokens,
        input.costUsd ?? null,
        input.latencyMs ?? null,
        input.metrics ? JSON.stringify(input.metrics) : null,
        input.startedAt ?? null,
        input.promptVersion ?? null,
      ],
    );
  } catch (error) {
    logger.warn('failed to record model usage', { stage: input.stage, err: error });
  }
}

export interface UsageTotals {
  stage: UsageStage;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Null when no call in this stage reported a cost. */
  costUsd: number | null;
}

interface TotalsRow {
  stage: UsageStage;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cost_usd: string | null;
}

const totalsSelect = `
  SELECT stage,
         COUNT(*)::int              AS calls,
         SUM(prompt_tokens)::int     AS prompt_tokens,
         SUM(completion_tokens)::int AS completion_tokens,
         SUM(total_tokens)::int      AS total_tokens,
         SUM(cost_usd)               AS cost_usd
    FROM model_usage`;

function mapTotals(rows: TotalsRow[]): UsageTotals[] {
  return rows.map((row) => ({
    stage: row.stage,
    calls: row.calls,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
    // NUMERIC arrives as a string from pg; keep full precision until the end.
    costUsd: row.cost_usd === null ? null : Number(row.cost_usd),
  }));
}

/**
 * Stages paid once, to make a video searchable at all.
 *
 * Search rows also carry a video_id — that is what lets the whole lifetime
 * cost of a video be totalled — so anything scoped to "what did ingesting
 * this cost" must say so explicitly. Otherwise the figure climbs every time
 * someone searches, and cost-per-video silently becomes a function of how
 * popular the video is.
 */
// What it costs to make one video searchable. 'embedding' belongs here:
// making the vectors IS part of reading the video, and leaving it out
// would report a per-video ingestion cost that quietly excludes a stage
// we pay for — the same shape of error migration 027 was written about.
// 'rerank' is deliberately absent: it runs per question, not per video.
const INGESTION_STAGES: UsageStage[] = ['transcription', 'indexing', 'embedding'];

/** Cost of making one video searchable. Excludes searches run against it. */
export async function usageForVideo(videoId: string): Promise<UsageTotals[]> {
  const rows = await queryRows<TotalsRow>(
    `${totalsSelect} WHERE video_id = $1 AND stage = ANY($2::text[]) GROUP BY stage`,
    [videoId, INGESTION_STAGES],
  );
  return mapTotals(rows);
}

/** Everything one video has ever cost: ingestion plus every search against it. */
export async function usageForVideoLifetime(videoId: string): Promise<UsageTotals[]> {
  const rows = await queryRows<TotalsRow>(`${totalsSelect} WHERE video_id = $1 GROUP BY stage`, [videoId]);
  return mapTotals(rows);
}

/** Cost-per-search, by stage. */
export async function usageForClipRequest(clipRequestId: string): Promise<UsageTotals[]> {
  const rows = await queryRows<TotalsRow>(`${totalsSelect} WHERE clip_request_id = $1 GROUP BY stage`, [
    clipRequestId,
  ]);
  return mapTotals(rows);
}
