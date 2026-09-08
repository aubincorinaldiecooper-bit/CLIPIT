import { queryOne } from '../pool.js';

/**
 * Clipit's record of what Omni-SimpleMem holds for a video. The memory
 * itself lives on the sidecar's disk; this row says whether it exists, how
 * far into the video it reaches, and under which models it was made. See
 * migration 043.
 */

export type SimpleMemIndexStatus = 'queued' | 'running' | 'ready' | 'failed' | 'unavailable';

export interface SimpleMemIndexRow {
  videoId: string;
  status: SimpleMemIndexStatus;
  videoMauId: string | null;
  fps: number | null;
  framesExtracted: number | null;
  framesProcessed: number | null;
  framesSkipped: number | null;
  /** How far into the video SimpleMem looked; null until the read finishes. */
  coveredThroughSeconds: number | null;
  audioTranscribed: boolean | null;
  indexMs: number | null;
  error: string | null;
  config: Record<string, unknown> | null;
  updatedAt: Date;
}

interface Row {
  video_id: string;
  status: SimpleMemIndexStatus;
  video_mau_id: string | null;
  fps: string | number | null;
  frames_extracted: number | null;
  frames_processed: number | null;
  frames_skipped: number | null;
  covered_through_seconds: string | number | null;
  audio_transcribed: boolean | null;
  index_ms: number | null;
  error: string | null;
  config: Record<string, unknown> | null;
  updated_at: Date;
}

function num(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function map(row: Row): SimpleMemIndexRow {
  return {
    videoId: row.video_id,
    status: row.status,
    videoMauId: row.video_mau_id,
    fps: num(row.fps),
    framesExtracted: row.frames_extracted,
    framesProcessed: row.frames_processed,
    framesSkipped: row.frames_skipped,
    coveredThroughSeconds: num(row.covered_through_seconds),
    audioTranscribed: row.audio_transcribed,
    indexMs: row.index_ms,
    error: row.error,
    config: row.config,
    updatedAt: row.updated_at,
  };
}

export async function getSimpleMemIndex(videoId: string): Promise<SimpleMemIndexRow | null> {
  const row = await queryOne<Row>('SELECT * FROM simplemem_index WHERE video_id = $1', [videoId]);
  return row ? map(row) : null;
}

/** Creates or resets the row for a read that is about to start, or that could not. */
export async function setSimpleMemIndexStatus(
  videoId: string,
  status: SimpleMemIndexStatus,
  options: { error?: string | null } = {},
): Promise<void> {
  await queryOne(
    `INSERT INTO simplemem_index (video_id, status, error)
     VALUES ($1, $2, $3)
     ON CONFLICT (video_id) DO UPDATE
       SET status = EXCLUDED.status,
           error = EXCLUDED.error,
           updated_at = now()`,
    [videoId, status, options.error ?? null],
  );
}

/** What a finished read found, written with the status in one statement. */
export async function recordSimpleMemIndex(
  videoId: string,
  result: {
    videoMauId: string;
    fps: number;
    framesExtracted: number;
    framesProcessed: number;
    framesSkipped: number;
    coveredThroughSeconds: number;
    audioTranscribed: boolean;
    indexMs: number;
    config: Record<string, unknown>;
  },
): Promise<void> {
  await queryOne(
    `INSERT INTO simplemem_index (
        video_id, status, video_mau_id, fps, frames_extracted, frames_processed, frames_skipped,
        covered_through_seconds, audio_transcribed, index_ms, error, config)
     VALUES ($1, 'ready', $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10::jsonb)
     ON CONFLICT (video_id) DO UPDATE
       SET status = 'ready',
           video_mau_id = EXCLUDED.video_mau_id,
           fps = EXCLUDED.fps,
           frames_extracted = EXCLUDED.frames_extracted,
           frames_processed = EXCLUDED.frames_processed,
           frames_skipped = EXCLUDED.frames_skipped,
           covered_through_seconds = EXCLUDED.covered_through_seconds,
           audio_transcribed = EXCLUDED.audio_transcribed,
           index_ms = EXCLUDED.index_ms,
           error = NULL,
           config = EXCLUDED.config,
           updated_at = now()`,
    [
      videoId,
      result.videoMauId,
      result.fps,
      result.framesExtracted,
      result.framesProcessed,
      result.framesSkipped,
      result.coveredThroughSeconds,
      result.audioTranscribed,
      result.indexMs,
      JSON.stringify(result.config),
    ],
  );
}

export async function deleteSimpleMemIndex(videoId: string): Promise<void> {
  await queryOne('DELETE FROM simplemem_index WHERE video_id = $1', [videoId]);
}
