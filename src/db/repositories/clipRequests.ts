import { queryOne, queryRows } from '../pool.js';
import type {
  ChunkDegradation,
  ChunkError,
  ClipMatch,
  ClipRequest,
  ClipRequestStatus,
  MatchSource,
  ResolvedSearchMode,
  SearchMode,
} from '../../domain/types.js';

interface ClipRequestRow {
  id: string;
  video_id: string;
  session_id: string | null;
  user_id: string | null;
  instruction: string;
  mode: SearchMode;
  resolved_mode: ResolvedSearchMode | null;
  status: ClipRequestStatus;
  error_message: string | null;
  chunks_total: number;
  chunks_completed: number;
  chunks_failed: number;
  chunk_errors: ChunkError[];
  chunk_degradations: ChunkDegradation[] | null;
  created_at: Date;
  updated_at: Date;
}

function mapRequest(row: ClipRequestRow): ClipRequest {
  return {
    id: row.id,
    videoId: row.video_id,
    sessionId: row.session_id,
    userId: row.user_id,
    instruction: row.instruction,
    mode: row.mode,
    resolvedMode: row.resolved_mode,
    status: row.status,
    errorMessage: row.error_message,
    chunksTotal: row.chunks_total,
    chunksCompleted: row.chunks_completed,
    chunksFailed: row.chunks_failed,
    chunkDegradations: row.chunk_degradations ?? [],
    chunkErrors: row.chunk_errors ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createClipRequest(input: {
  videoId: string;
  sessionId: string | null;
  userId?: string | null;
  instruction: string;
  mode: SearchMode;
}): Promise<ClipRequest> {
  const row = await queryOne<ClipRequestRow>(
    `INSERT INTO clip_requests (video_id, session_id, user_id, instruction, mode)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.videoId, input.sessionId, input.userId ?? null, input.instruction, input.mode],
  );
  return mapRequest(row!);
}

export async function getClipRequest(requestId: string): Promise<ClipRequest | null> {
  const row = await queryOne<ClipRequestRow>('SELECT * FROM clip_requests WHERE id = $1', [requestId]);
  return row ? mapRequest(row) : null;
}

export async function startClipRequest(
  requestId: string,
  input: { chunksTotal: number; resolvedMode: ResolvedSearchMode },
): Promise<void> {
  await queryOne(
    `UPDATE clip_requests
        SET status = 'searching',
            resolved_mode = $2,
            chunks_total = $3,
            chunks_completed = 0,
            chunks_failed = 0,
            chunk_errors = '[]'::jsonb,
            error_message = NULL,
            updated_at = now()
      WHERE id = $1`,
    [requestId, input.resolvedMode, input.chunksTotal],
  );
}

export async function recordChunkCompleted(requestId: string): Promise<void> {
  await queryOne(
    `UPDATE clip_requests SET chunks_completed = chunks_completed + 1, updated_at = now() WHERE id = $1`,
    [requestId],
  );
}

/** A failed chunk is recorded and skipped — it never fails the whole search. */
export async function recordChunkFailure(requestId: string, error: ChunkError): Promise<void> {
  await queryOne(
    `UPDATE clip_requests
        SET chunks_failed = chunks_failed + 1,
            chunk_errors = chunk_errors || $2::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [requestId, JSON.stringify([error])],
  );
}

/**
 * Records that a chunk was searched, but with less evidence than intended.
 *
 * Deliberately does not touch chunks_failed: the chunk completed and its
 * matches are real. What is lost is the ability to check a spoken condition
 * inside that window, which the response reports as a caveat rather than a
 * gap.
 */
export async function recordChunkDegraded(requestId: string, degradation: ChunkDegradation): Promise<void> {
  await queryOne(
    `UPDATE clip_requests
        SET chunk_degradations = chunk_degradations || $2::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [requestId, JSON.stringify([degradation])],
  );
}

export async function finishClipRequest(
  requestId: string,
  status: ClipRequestStatus,
  errorMessage: string | null = null,
): Promise<void> {
  await queryOne(
    `UPDATE clip_requests SET status = $2, error_message = $3, updated_at = now() WHERE id = $1`,
    [requestId, status, errorMessage],
  );
}

interface ClipMatchRow {
  id: string;
  clip_request_id: string;
  chunk_id: string;
  local_start_seconds: number;
  local_end_seconds: number;
  global_start_seconds: number;
  global_end_seconds: number;
  description: string;
  confidence: number;
  source: MatchSource;
  quote: string | null;
  created_at: Date;
}

function mapMatch(row: ClipMatchRow): ClipMatch {
  return {
    id: row.id,
    clipRequestId: row.clip_request_id,
    chunkId: row.chunk_id,
    localStartSeconds: row.local_start_seconds,
    localEndSeconds: row.local_end_seconds,
    globalStartSeconds: row.global_start_seconds,
    globalEndSeconds: row.global_end_seconds,
    description: row.description,
    confidence: row.confidence,
    source: row.source,
    quote: row.quote,
    createdAt: row.created_at,
  };
}

export interface NewClipMatch {
  chunkId: string;
  localStartSeconds: number;
  localEndSeconds: number;
  globalStartSeconds: number;
  globalEndSeconds: number;
  description: string;
  confidence: number;
  source: MatchSource;
  quote?: string | null;
}

export async function insertMatches(requestId: string, matches: NewClipMatch[]): Promise<ClipMatch[]> {
  if (matches.length === 0) return [];

  const values: string[] = [];
  const params: unknown[] = [requestId];

  for (const match of matches) {
    const base = params.length;
    params.push(
      match.chunkId,
      match.localStartSeconds,
      match.localEndSeconds,
      match.globalStartSeconds,
      match.globalEndSeconds,
      match.description,
      match.confidence,
      match.source,
      match.quote ?? null,
    );
    values.push(
      `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`,
    );
  }

  const rows = await queryRows<ClipMatchRow>(
    `INSERT INTO clip_matches (
       clip_request_id, chunk_id, local_start_seconds, local_end_seconds,
       global_start_seconds, global_end_seconds, description, confidence, source, quote
     ) VALUES ${values.join(', ')}
     RETURNING *`,
    params,
  );
  return rows.map(mapMatch);
}

export async function listMatches(requestId: string): Promise<ClipMatch[]> {
  const rows = await queryRows<ClipMatchRow>(
    'SELECT * FROM clip_matches WHERE clip_request_id = $1 ORDER BY global_start_seconds ASC',
    [requestId],
  );
  return rows.map(mapMatch);
}

export async function listMatchesByIds(requestId: string, matchIds: string[]): Promise<ClipMatch[]> {
  if (matchIds.length === 0) return [];
  const rows = await queryRows<ClipMatchRow>(
    `SELECT * FROM clip_matches
      WHERE clip_request_id = $1 AND id = ANY($2::uuid[])
      ORDER BY global_start_seconds ASC`,
    [requestId, matchIds],
  );
  return rows.map(mapMatch);
}

export async function deleteMatches(requestId: string): Promise<void> {
  await queryOne('DELETE FROM clip_matches WHERE clip_request_id = $1', [requestId]);
}
