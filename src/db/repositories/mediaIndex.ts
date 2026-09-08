import { query, queryOne, queryRows, withTransaction } from '../pool.js';
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
  /**
   * The store's content tag for the footage these vectors describe.
   *
   * Not decoration, and not implied by the rest. The analysis proxy lives at
   * a deterministic key and re-processing overwrites it, so a REPLACED video
   * has the same key, the same window keys and — if the model settings did
   * not change — the same model, revision and dimensions. Without this, a run
   * against new footage would keep every old window it did not reach and
   * serve it as the new video.
   */
  sourceIdentity: string;
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
/**
 * The INSERT a batch of windows becomes, as text and bound values.
 *
 * Separated from the call so it can be checked without a database. It was
 * shipped once with a placeholder that had no value behind it — every insert
 * would have been rejected by Postgres for a parameter-count mismatch, and
 * nothing caught it: TypeScript cannot see inside a SQL string, and no test
 * here reaches a real server. The arithmetic is now something a test can hold
 * to account.
 */
export function buildWindowInsert(
  videoId: string,
  windows: readonly IndexedWindow[],
  provenance: WindowProvenance,
  packVector: (values: readonly number[]) => Buffer,
  runStartedAt: Date,
): { text: string; values: unknown[] } {
  const PER_WINDOW = 8;
  const values: unknown[] = [];
  const tuples = windows.map((window, i) => {
    const base = i * PER_WINDOW;
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
    const shared = windows.length * PER_WINDOW;
    return (
      `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, ` +
      `$${base + 6}, $${base + 7}, $${base + 8}, $${shared + 1}, $${shared + 2}, $${shared + 3})`
    );
  });
  values.push(provenance.indexVersion, provenance.sourceIdentity, runStartedAt);

  return {
    text:
      `INSERT INTO media_index
         (video_id, window_key, start_seconds, end_seconds, embedding, dims, model, revision, index_version, source_identity, run_started_at)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (video_id, window_key) DO UPDATE SET
         start_seconds   = EXCLUDED.start_seconds,
         end_seconds     = EXCLUDED.end_seconds,
         embedding       = EXCLUDED.embedding,
         dims            = EXCLUDED.dims,
         model           = EXCLUDED.model,
         revision        = EXCLUDED.revision,
         index_version   = EXCLUDED.index_version,
         source_identity = EXCLUDED.source_identity,
         run_started_at  = EXCLUDED.run_started_at,
         created_at      = now()`,
    values,
  };
}

/**
 * Stores a batch of embedded windows.
 *
 * An upsert on (video_id, window_key), because the window grid is
 * deterministic: re-indexing rewrites the same windows rather than laying a
 * second copy of the video beside the first.
 *
 * Returns 0 without storing anything when this attempt is no longer the
 * current one, or when retention has claimed the footage. A caller that goes
 * on counting windows it did not write would report coverage the index does
 * not have.
 */
export async function storeIndexedWindows(
  videoId: string,
  windows: readonly IndexedWindow[],
  provenance: WindowProvenance,
  packVector: (values: readonly number[]) => Buffer,
  runStartedAt: Date,
): Promise<number> {
  if (windows.length === 0) return 0;

  const wrong = windows.find((window) => window.embedding.length !== provenance.dims);
  if (wrong) {
    throw new Error(
      `window ${wrong.windowKey} has ${wrong.embedding.length} dimensions, not the ${provenance.dims} this index stores`,
    );
  }

  const statement = buildWindowInsert(videoId, windows, provenance, packVector, runStartedAt);

  return withTransaction(async (client) => {
    // Locks the video row for this transaction, so retention's claim blocks
    // until these rows are committed, and a claim that got there first makes
    // this write find nothing and store nothing.
    const guard = await client.query(
      `SELECT 1 FROM videos
        WHERE id = $1 AND footage_expired_at IS NULL AND footage_claimed_at IS NULL
        FOR UPDATE`,
      [videoId],
    );
    if (guard.rowCount === 0) return 0;

    // And the run that opened must still be the current one. An older,
    // overlapping attempt writes nothing rather than overwriting the newer
    // run's work with vectors that every read would then filter out.
    const current = await client.query(
      `SELECT 1 FROM media_index_status WHERE video_id = $1 AND started_at = $2`,
      [videoId, runStartedAt],
    );
    if (current.rowCount === 0) return 0;

    const result = await client.query(statement.text, statement.values);
    return result.rowCount ?? 0;
  });
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
export interface IndexSnapshot {
  windows: StoredWindow[];
  /** The run these windows belong to, read in the SAME query as the windows. */
  runStartedAt: Date | null;
  /** Its coverage, likewise — so the two can never describe different runs. */
  coveredThroughSeconds: number;
}

/**
 * Every stored window for one video, with the run they belong to.
 *
 * Whole-video rather than top-k in SQL, because the similarity is computed in
 * this process (migration 044 says why). A search is always about one video,
 * so this is hundreds of rows, not the whole table.
 *
 * Coverage and the run identity come back from THIS query rather than from a
 * separate read. A re-index starting between two reads would otherwise pair
 * one run's windows with another run's coverage, and partly-read replacement
 * footage would be reported as fully read.
 *
 * A row whose vector does not match its stated size throws rather than being
 * skipped. Silently dropping it would shrink the searched region without
 * saying so, which is the one thing coverage exists to prevent.
 */
export async function listIndexedWindows(videoId: string): Promise<IndexSnapshot> {
  const rows = await queryRows<{
    window_key: string;
    start_seconds: string | number;
    end_seconds: string | number;
    embedding: Buffer;
    dims: number;
    run_started_at: Date | null;
    covered_through_seconds: string | number;
  }>(
    `SELECT m.window_key, m.start_seconds, m.end_seconds, m.embedding, m.dims,
            s.started_at AS run_started_at, s.covered_through_seconds
       FROM media_index m
       JOIN media_index_status s ON s.video_id = m.video_id
      WHERE m.video_id = $1
        AND m.model = s.model
        AND m.revision = s.revision
        AND m.dims = s.dims
        AND m.index_version = s.index_version
        AND m.source_identity = s.source_identity
      ORDER BY m.start_seconds`,
    [videoId],
  );

  return {
    windows: rows.map((row) => ({
      windowKey: row.window_key,
      startSeconds: Number(row.start_seconds),
      endSeconds: Number(row.end_seconds),
      embedding: unpackVector(row.embedding, row.dims),
    })),
    runStartedAt: rows[0]?.run_started_at ?? null,
    coveredThroughSeconds: Number(rows[0]?.covered_through_seconds ?? 0),
  };
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
  /**
   * Absent leaves whatever is recorded alone; an explicit null clears it.
   * The difference matters: a progress update that happened not to mention
   * the error must not erase why the last attempt failed.
   */
  error?: string | null;
  startedAt?: Date;
  finishedAt?: Date;
  /**
   * Write only while this is still the run that owns the status row.
   *
   * The window fence stops an obsolete attempt storing vectors, but it wrote
   * status regardless — so a superseded run could stamp its own counters and
   * coverage over the live run's, and a partial index would read as fully
   * ready. Progress and completion carry the run that produced them.
   */
  ifRunStartedAt?: Date;
  /**
   * Write only while the row is in one of these states.
   *
   * For an attempt that failed BEFORE it opened a run: it has no run identity
   * to be fenced on, and no claim on this row at all. Without a condition it
   * would stamp its failure over a newer attempt that has since opened, or
   * even completed — sending every later question to the slow path for a
   * video that is in fact indexed. Restricting it to `queued` means it can
   * only report a failure nobody has superseded.
   */
  ifState?: readonly MediaIndexState[];
}

/** States that mean the run is over, one way or another. */
const TERMINAL_STATES: ReadonlySet<MediaIndexState> = new Set<MediaIndexState>([
  'ready',
  'partial',
  'failed',
  'unavailable',
]);

/**
 * Writes where a video's indexing has got to.
 *
 * Upsert rather than insert-then-update, so the first progress report does not
 * need a row to already exist and a re-index does not have to clear anything.
 *
 * Two fields need more care than the counters:
 *
 * `error` survives a progress update that does not mention it. Collapsing an
 * absent error into null would mean any later write erased the reason the last
 * attempt failed, leaving a failed row that cannot say why.
 *
 * `finished_at` is cleared whenever the state is not terminal. Keeping the
 * previous run's completion time would produce a row reading `running` and
 * claiming it finished twenty minutes ago — two facts that cannot both be true.
 */
export interface StatusWrite {
  /** True when the error column is written at all; false leaves it as it was. */
  writeError: boolean;
  /** The value to write, when writeError. */
  errorValue: string | null;
  /** True when finished_at must be emptied, because this run is not over. */
  clearFinished: boolean;
}

/**
 * What a status write does to the two fields that are not simple counters.
 *
 * Pure, and exported, because both of the rules here were got wrong first
 * time: an omitted error erased the reason a run failed, and a restarted run
 * inherited the previous run's completion time. They are worth a test that
 * does not need a database.
 */
export function statusWriteDecision(state: MediaIndexState, patch: StatusPatch): StatusWrite {
  const terminal = TERMINAL_STATES.has(state);
  return {
    // Explicitly given wins. Otherwise a fresh run (queued/running) starts
    // with a clean error, and a terminal state keeps the one already recorded.
    writeError: 'error' in patch || !terminal,
    errorValue: 'error' in patch ? (patch.error ?? null) : null,
    clearFinished: !terminal,
  };
}

/**
 * "This run is still alive." Nothing else.
 *
 * The liveness signal, separated from progress on purpose. Progress arrives
 * when a batch of windows returns, and a batch can legitimately take a very
 * long time — it waits for a shared Modal permit that searches also draw on,
 * then retries internally, each attempt allowed a full request timeout. Time
 * since the last batch therefore measures how busy the system is, not whether
 * anything is still reading this video, and no arithmetic over those settings
 * turns one into the other: the permit wait is bounded by nothing at all.
 *
 * So the process says so itself, on a timer, while it is working. Silence then
 * means the process is gone — which is the only thing the read path actually
 * wants to know.
 *
 * Fenced on the run that opened the row: a worker whose run has been
 * superseded cannot keep a newer attempt's row looking alive, and one that
 * finished cannot revive a terminal state, because only `running` is touched.
 */
export async function touchMediaIndexRun(videoId: string, runStartedAt: Date): Promise<boolean> {
  const result = await query(
    `UPDATE media_index_status
        SET updated_at = now()
      WHERE video_id = $1 AND started_at = $2 AND state = 'running'`,
    [videoId, runStartedAt],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function setMediaIndexStatus(
  videoId: string,
  state: MediaIndexState,
  patch: StatusPatch = {},
): Promise<void> {
  const { writeError: errorGiven, errorValue, clearFinished } = statusWriteDecision(state, patch);

  await query(
    `INSERT INTO media_index_status
       (video_id, state, covered_through_seconds, windows_planned, windows_stored, windows_failed,
        model, revision, dims, index_version, error, started_at, finished_at, updated_at)
     VALUES ($1, $2, COALESCE($3, 0), COALESCE($4, 0), COALESCE($5, 0), COALESCE($6, 0),
             COALESCE($7, ''), COALESCE($8, ''), $9, COALESCE($10, ''),
             CASE WHEN $14 THEN $11 ELSE NULL END,
             $12,
             CASE WHEN $15 THEN NULL ELSE $13 END,
             now())
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
       error                   = CASE WHEN $14 THEN $11 ELSE media_index_status.error END,
       started_at              = COALESCE($12, media_index_status.started_at),
       finished_at             = CASE WHEN $15 THEN NULL
                                      ELSE COALESCE($13, media_index_status.finished_at) END,
       updated_at              = now()
     WHERE ($16::timestamptz IS NULL OR media_index_status.started_at = $16)
       AND ($17::text[] IS NULL OR media_index_status.state = ANY($17))`,
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
      errorValue,
      patch.startedAt ?? null,
      patch.finishedAt ?? null,
      errorGiven,
      clearFinished,
      patch.ifRunStartedAt ?? null,
      patch.ifState ? [...patch.ifState] : null,
    ] as never,
  );
}

/**
 * Opens an indexing run, and makes it the only run this video has.
 *
 * Any window stored under different provenance is deleted first. The read
 * filter already refuses to return those rows, so this is not what keeps a
 * search honest — it is what stops a video accumulating a dead copy of itself
 * every time the model is changed.
 *
 * Windows matching this exact provenance are KEPT, which is what makes a
 * resumed run cheap: an attempt that died at minute forty picks up from the
 * windows already paid for rather than re-embedding the whole video.
 */
export async function beginIndexRun(
  videoId: string,
  provenance: WindowProvenance,
): Promise<{ cleared: number; retained: string[]; runStartedAt: Date }> {
  // One transaction. Deleting the old index and recording the new run are a
  // single act: if the status write failed on its own, the previous index
  // would be gone while its status still read `ready`, and every search would
  // see a finished index with nothing in it until some later run repaired it.
  return withTransaction(async (client) => {
    const removed = await client.query(
      `DELETE FROM media_index
        WHERE video_id = $1
          AND (model <> $2 OR revision <> $3 OR dims <> $4 OR index_version <> $5 OR source_identity <> $6)`,
      [videoId, provenance.model, provenance.revision, provenance.dims, provenance.indexVersion, provenance.sourceIdentity],
    );

    // What survived: windows already paid for under this exact identity. They
    // are handed back so a resumed run counts them towards its coverage
    // instead of reporting a video as unread when most of it is stored.
    const kept = await client.query<{ window_key: string }>(
      `SELECT window_key FROM media_index
        WHERE video_id = $1 AND model = $2 AND revision = $3 AND dims = $4
          AND index_version = $5 AND source_identity = $6`,
      [videoId, provenance.model, provenance.revision, provenance.dims, provenance.indexVersion, provenance.sourceIdentity],
    );

    const opened = await client.query<{ started_at: Date }>(
      `INSERT INTO media_index_status
         (video_id, state, model, revision, dims, index_version, source_identity, error, started_at, finished_at, updated_at)
       VALUES ($1, 'running', $2, $3, $4, $5, $6, NULL, now(), NULL, now())
       ON CONFLICT (video_id) DO UPDATE SET
         state           = 'running',
         model           = $2,
         revision        = $3,
         dims            = $4,
         index_version   = $5,
         source_identity = $6,
         error           = NULL,
         started_at      = now(),
         finished_at     = NULL,
         updated_at      = now()
       RETURNING started_at`,
      [videoId, provenance.model, provenance.revision, provenance.dims, provenance.indexVersion, provenance.sourceIdentity],
    );

    const runStartedAt = opened.rows[0]?.started_at;
    if (!runStartedAt) throw new Error('the index run could not be opened');

    return { cleared: removed.rowCount ?? 0, retained: kept.rows.map((row) => row.window_key), runStartedAt };
  });
}

/** Removes a video's index. Called with its footage, so the two cannot drift apart. */
export async function deleteMediaIndex(videoId: string): Promise<void> {
  await query('DELETE FROM media_index WHERE video_id = $1', [videoId]);
  await query('DELETE FROM media_index_status WHERE video_id = $1', [videoId]);
}
