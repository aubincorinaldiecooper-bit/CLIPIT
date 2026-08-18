import { queryOne, queryRows } from '../pool.js';
import { logger } from '../../lib/logger.js';

/** What caused a model call. */
export type UsageStage = 'transcription' | 'indexing' | 'search' | 'verification';

export interface ModelTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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
         (video_id, clip_request_id, provider, model, stage, prompt_tokens, completion_tokens, total_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        input.videoId ?? null,
        input.clipRequestId ?? null,
        input.provider,
        input.model,
        input.stage,
        input.promptTokens,
        input.completionTokens,
        input.totalTokens,
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
}

interface TotalsRow {
  stage: UsageStage;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

const totalsSelect = `
  SELECT stage,
         COUNT(*)::int              AS calls,
         SUM(prompt_tokens)::int     AS prompt_tokens,
         SUM(completion_tokens)::int AS completion_tokens,
         SUM(total_tokens)::int      AS total_tokens
    FROM model_usage`;

function mapTotals(rows: TotalsRow[]): UsageTotals[] {
  return rows.map((row) => ({
    stage: row.stage,
    calls: row.calls,
    promptTokens: row.prompt_tokens,
    completionTokens: row.completion_tokens,
    totalTokens: row.total_tokens,
  }));
}

/** Cost-per-video: indexing and transcription, by stage. */
export async function usageForVideo(videoId: string): Promise<UsageTotals[]> {
  const rows = await queryRows<TotalsRow>(`${totalsSelect} WHERE video_id = $1 GROUP BY stage`, [videoId]);
  return mapTotals(rows);
}

/** Cost-per-search: search and verification, by stage. */
export async function usageForClipRequest(clipRequestId: string): Promise<UsageTotals[]> {
  const rows = await queryRows<TotalsRow>(`${totalsSelect} WHERE clip_request_id = $1 GROUP BY stage`, [
    clipRequestId,
  ]);
  return mapTotals(rows);
}
