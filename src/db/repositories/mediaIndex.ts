import { query, queryOne, queryRows } from '../pool.js';
import { unpackVector } from '../../services/mediaIndex/vectors.js';

/**
 * The Media Index: reading and writing what a video looks like.
 *
 * Two tables, and the split matters. `media_index` holds the vectors.
 * `media_index_status` holds how much of the video they actually cover, which
 * is the only thing that lets a search tell "nothing matches there" apart from
 * "nothing has read there". Storing vectors without storing coverage would
 * produce a search that answers confidently about footage it never saw.
 */

export type MediaIndexState = 'queued' | 'running' | 'ready' | 'partial' | 'failed' | 'unavailable';

export interface IndexedWindow {
  windowKey: string;
  startSeconds: number;
  endSeconds: number;
  embedding: readonly number[];
}

/** A window on its way out of the database, vector already unpacked. */
export interface StoredWindow {
  windowKey: string;
  startSeconds: number;
  endSeconds: number;
  embedding: Float32Array;
}

export interface MediaIndexStatus {
  videoId: string;
  state: MediaIndexState;
  /** Every second up to here has a stored window. A gap pulls this back to the gap. */
  coveredThroughSeconds: number;
  windowsPlanned: number;
  windowsStored: number;
  windowsFailed: number;
  model: string;
  revision: string;
  dims: number | null;
  indexVersion: string;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
}

interface StatusRow {
  video_id: string;
  state: MediaIndexState;
  covered_through_seconds: string | number;
  windows_planned: number;
  windows_stored: number;
  windows_failed: number;
  model: string;
  revision: string;
  dims: number | null;
  index_version: string;
  error: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

function mapStatus(row: StatusRow): MediaIndexStatus {
  return {
    videoId: row.video_id,
    state: row.state,
    coveredThroughSeconds: Number(row.covered_through_seconds),
    windowsPlanned: row.windows_planned,
    windowsStored: row.windows_stored,
    windowsFailed: row.windows_failed,
    model: row.model,
    revision: row.revision,
    dims: row.dims,
    indexVersion: row.index_version,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

export interface WindowProvenance {
  dims: number;
  model: string;
  revision: string;
  indexVersion: string;
}

/**
 * Stores a batch of embedded windows.
 *
 * An upsert on (video_id, window_key), because the window grid is
 * deterministic: re-indexing a video rewrites the same windows rather than
 * laying a second copy of the video beside the first. That is what makes a
 * retry safe and a resume cheap.
 *
 * The vectors arrive already packed so this layer never has to know the byte
 * format, and a batch that mixes dimensions is refused rather than stored —
 * vectors of two different shapes in one video's index cannot be compared, and
 * would fail at search time as a bad answer instead of here as a bad write.
 */
export async function storeIndexedWindows(
  videoId: string,
  windows: readonly IndexedWindow[],
  provenance: WindowProvenance,
  packVector: (values: readonly number[]) => Buffer,
): Promise<number> {
  if (windows.length === 0) return 0;

  const wrong = windows.find((window) => window.embedding.length !== provenance.dims);
  if (wrong) {
    throw new Error(
      `window ${wrong.windowKey} has ${wrong.embedding.length} dimensions, not the ${provenance.dims} this index stores`,
    );
  }

  const values: unknown[] = [];
  const tuples = windows.map((window, i) => {
    const base = i * 8;
    values.push(
      videoId,
      window.windowKey,
      window.startSeconds,
      window.endSeconds,
      packVector(window.embedding),
      provenance.dims,
      provenance.model,
      provenance.revision,
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${windows.length * 8 + 1})`;
  });
  values.push(provenance.indexVersion);

  const result = await query(
    `INSERT INTO media_index
       (video_id, window_key, start_seconds, end_seconds, embedding, dims, model, revision, index_version)
     VALUES ${tuples.join(', ')}
     ON CONFLICT (video_id, window_key) DO UPDATE SET
       start_seconds = EXCLUDED.start_seconds,
       end_seconds   = EXCLUDED.end_seconds,
       embedding     = EXCLUDED.embedding,
       dims          = EXCLUDED.dims,
       model         = EXCLUDED.model,
       revision      = EXCLUDED.revision,
       index_version = EXCLUDED.index_version,
       created_at    = now()`,
    values as never,
  );
  return result.rowCount ?? 0;
}

/**
 * Every stored window for one video, vectors unpacked and ready to compare.
 *
 * Whole-video rather than top-k in SQL, because the similarity is computed in
 * this process (migration 044 says why). A search is always about one video,
 * so this is hundreds of rows, not the whole table.
 *
 * A row whose vector does not match its stated size throws rather than being
 * skipped. Silently dropping it would shrink the searched region without
 * saying so, which is the one thing coverage exists to prevent.
 */
export async function listIndexedWindows(videoId: string): Promise<StoredWindow[]> {
  const rows = await queryRows<{
    window_key: string;
    start_seconds: string | number;
    end_seconds: string | number;
    embedding: Buffer;
    dims: number;
  }>(
    `SELECT window_key, start_seconds, end_seconds, embedding, dims
       FROM media_index
      WHERE video_id = $1
      ORDER BY start_seconds`,
    [videoId],
  );

  return rows.map((row) => ({
    windowKey: row.window_key,
    startSeconds: Number(row.start_seconds),
    endSeconds: Number(row.end_seconds),
    embedding: unpackVector(row.embedding, row.dims),
  }));
}

export async function getMediaIndexStatus(videoId: string): Promise<MediaIndexStatus | null> {
  const row = await queryOne<StatusRow>('SELECT * FROM media_index_status WHERE video_id = $1', [videoId]);
  return row ? mapStatus(row) : null;
}

export interface StatusPatch {
  coveredThroughSeconds?: number;
  windowsPlanned?: number;
  windowsStored?: number;
  windowsFailed?: number;
  model?: string;
  revision?: string;
  dims?: number;
  indexVersion?: string;
  error?: string | null;
  startedAt?: Date;
  finishedAt?: Date;
}

/**
 * Writes where a video's indexing has got to.
 *
 * Upsert rather than insert-then-update so the first progress report does not
 * need a row to already exist, and so a re-index does not have to clear
 * anything first.
 */
export async function setMediaIndexStatus(
  videoId: string,
  state: MediaIndexState,
  patch: StatusPatch = {},
): Promise<void> {
  await query(
    `INSERT INTO media_index_status
       (video_id, state, covered_through_seconds, windows_planned, windows_stored, windows_failed,
        model, revision, dims, index_version, error, started_at, finished_at, updated_at)
     VALUES ($1, $2, COALESCE($3, 0), COALESCE($4, 0), COALESCE($5, 0), COALESCE($6, 0),
             COALESCE($7, ''), COALESCE($8, ''), $9, COALESCE($10, ''), $11, $12, $13, now())
     ON CONFLICT (video_id) DO UPDATE SET
       state                   = EXCLUDED.state,
       covered_through_seconds = COALESCE($3, media_index_status.covered_through_seconds),
       windows_planned         = COALESCE($4, media_index_status.windows_planned),
       windows_stored          = COALESCE($5, media_index_status.windows_stored),
       windows_failed          = COALESCE($6, media_index_status.windows_failed),
       model                   = COALESCE($7, media_index_status.model),
       revision                = COALESCE($8, media_index_status.revision),
       dims                    = COALESCE($9, media_index_status.dims),
       index_version           = COALESCE($10, media_index_status.index_version),
       error                   = $11,
       started_at              = COALESCE($12, media_index_status.started_at),
       finished_at             = COALESCE($13, media_index_status.finished_at),
       updated_at              = now()`,
    [
      videoId,
      state,
      patch.coveredThroughSeconds ?? null,
      patch.windowsPlanned ?? null,
      patch.windowsStored ?? null,
      patch.windowsFailed ?? null,
      patch.model ?? null,
      patch.revision ?? null,
      patch.dims ?? null,
      patch.indexVersion ?? null,
      patch.error ?? null,
      patch.startedAt ?? null,
      patch.finishedAt ?? null,
    ] as never,
  );
}

/** Removes a video's index. Called with its footage, so the two cannot drift apart. */
export async function deleteMediaIndex(videoId: string): Promise<void> {
  await query('DELETE FROM media_index WHERE video_id = $1', [videoId]);
  await query('DELETE FROM media_index_status WHERE video_id = $1', [videoId]);
}
