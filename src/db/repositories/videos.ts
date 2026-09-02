import { queryOne, queryRows } from '../pool.js';
import { coveredSeconds } from './scenes.js';
import type {
  IndexStatus,
  SourceType,
  TranscriptSource,
  TranscriptStatus,
  Video,
  VideoChunk,
  VideoStatus,
} from '../../domain/types.js';

interface VideoRow {
  id: string;
  session_id: string | null;
  user_id: string | null;
  workspace_id: string | null;
  source_type: SourceType;
  source_url: string | null;
  original_filename: string | null;
  title: string | null;
  status: VideoStatus;
  error_message: string | null;
  duration_seconds: number | null;
  size_bytes: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  video_codec: string | null;
  audio_codec: string | null;
  has_audio: boolean | null;
  metadata: Record<string, unknown>;
  original_storage_key: string | null;
  proxy_storage_key: string | null;
  playback_storage_key: string | null;
  poster_storage_key: string | null;
  captions_storage_key: string | null;
  chunk_seconds: number | null;
  chunk_count: number;
  transcript_status: TranscriptStatus;
  transcript_source: TranscriptSource | null;
  transcript_error: string | null;
  transcript_segment_count: number;
  footage_expired_at: Date | null;
  index_status: IndexStatus;
  index_error: string | null;
  scene_count: number;
  created_at: Date;
  updated_at: Date;
}

function mapVideo(row: VideoRow): Video {
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    sourceType: row.source_type,
    sourceUrl: row.source_url,
    originalFilename: row.original_filename,
    title: row.title,
    status: row.status,
    errorMessage: row.error_message,
    durationSeconds: row.duration_seconds,
    sizeBytes: row.size_bytes,
    width: row.width,
    height: row.height,
    fps: row.fps,
    videoCodec: row.video_codec,
    audioCodec: row.audio_codec,
    hasAudio: row.has_audio,
    metadata: row.metadata ?? {},
    originalStorageKey: row.original_storage_key,
    proxyStorageKey: row.proxy_storage_key,
    playbackStorageKey: row.playback_storage_key ?? null,
    posterStorageKey: row.poster_storage_key,
    captionsStorageKey: row.captions_storage_key,
    chunkSeconds: row.chunk_seconds,
    chunkCount: row.chunk_count,
    transcriptStatus: row.transcript_status,
    transcriptSource: row.transcript_source,
    transcriptError: row.transcript_error,
    transcriptSegmentCount: row.transcript_segment_count,
    footageExpiredAt: row.footage_expired_at ?? null,
    indexStatus: row.index_status,
    // Filled by getVideoWithReadProgress; zero unless it was asked for.
    indexReadThroughSeconds: 0,
    indexError: row.index_error,
    sceneCount: row.scene_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateVideoInput {
  sessionId: string | null;
  userId?: string | null;
  /** The room this video is being added to; null for a guest's upload. */
  workspaceId?: string | null;
  sourceType: SourceType;
  sourceUrl?: string | null;
  originalFilename?: string | null;
  title?: string | null;
  status: VideoStatus;
  originalStorageKey?: string | null;
}

export async function createVideo(input: CreateVideoInput): Promise<Video> {
  const row = await queryOne<VideoRow>(
    `INSERT INTO videos (session_id, user_id, workspace_id, source_type, source_url, original_filename, title, status, original_storage_key)
     VALUES ($1, $2, $9, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.sessionId,
      input.userId ?? null,
      input.sourceType,
      input.sourceUrl ?? null,
      input.originalFilename ?? null,
      input.title ?? null,
      input.status,
      input.originalStorageKey ?? null,
      input.workspaceId ?? null,
    ],
  );
  return mapVideo(row!);
}

/**
 * A video with how much of it its notes describe.
 *
 * Kept as a separate read rather than a column: the seconds the notes cover
 * are derivable from the notes themselves, and a duplicate of it in `videos`
 * is one more thing that can disagree with the truth. Coverage, not the
 * furthest second reached — see coveredSeconds for why.
 */
export async function getVideoWithReadProgress(videoId: string): Promise<Video | null> {
  const video = await getVideo(videoId);
  if (!video) return null;
  return { ...video, indexReadThroughSeconds: await coveredSeconds(videoId) };
}

/**
 * The caller's own library of videos, newest first, footage intact only.
 *
 * Signed in, that is their personal workspace — across every session they
 * have ever had; a guest gets the single tab's uploads. Videos whose footage
 * the retention sweep has already removed are left out: they cannot be
 * played or searched again, and listing them would be offering something we
 * no longer have.
 */
export async function listVideosForPrincipal(principal: {
  sessionId: string | null;
  userId: string | null;
  workspaceId?: string | null;
}): Promise<Video[]> {
  if (principal.workspaceId && principal.userId) {
    // Their library. The NULL-workspace arm is a safety net for rows written
    // before the personal workspace existed: they are still this person's
    // videos, and a library must not lose them to a bookkeeping gap.
    const rows = await queryRows<VideoRow>(
      `SELECT * FROM videos
        WHERE (workspace_id = $1 OR (user_id = $2 AND workspace_id IS NULL))
          AND footage_expired_at IS NULL
        ORDER BY created_at DESC
        LIMIT 30`,
      [principal.workspaceId, principal.userId],
    );
    return rows.map(mapVideo);
  }

  if (principal.userId) {
    // Signed in with no workspace yet: their own rows, as before.
    const rows = await queryRows<VideoRow>(
      `SELECT * FROM videos
        WHERE user_id = $1 AND footage_expired_at IS NULL
        ORDER BY created_at DESC
        LIMIT 30`,
      [principal.userId],
    );
    return rows.map(mapVideo);
  }

  if (!principal.sessionId) return [];
  const rows = await queryRows<VideoRow>(
    `SELECT * FROM videos
      WHERE session_id = $1 AND footage_expired_at IS NULL
      ORDER BY created_at DESC
      LIMIT 30`,
    [principal.sessionId],
  );
  return rows.map(mapVideo);
}

export async function getVideo(videoId: string): Promise<Video | null> {
  const row = await queryOne<VideoRow>('SELECT * FROM videos WHERE id = $1', [videoId]);
  return row ? mapVideo(row) : null;
}

export async function setVideoStatus(
  videoId: string,
  status: VideoStatus,
  errorMessage: string | null = null,
): Promise<void> {
  await queryOne(
    `UPDATE videos SET status = $2, error_message = $3, updated_at = now() WHERE id = $1`,
    [videoId, status, errorMessage],
  );
}

export interface VideoMediaUpdate {
  originalFilename?: string | null;
  originalStorageKey?: string | null;
  proxyStorageKey?: string | null;
  playbackStorageKey?: string | null;
  posterStorageKey?: string | null;
  captionsStorageKey?: string | null;
  durationSeconds?: number | null;
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  videoCodec?: string | null;
  audioCodec?: string | null;
  hasAudio?: boolean | null;
  title?: string | null;
  sourceUrl?: string | null;
  metadata?: Record<string, unknown>;
  chunkSeconds?: number | null;
  chunkCount?: number;
}

const mediaColumns: Record<keyof VideoMediaUpdate, string> = {
  originalFilename: 'original_filename',
  originalStorageKey: 'original_storage_key',
  proxyStorageKey: 'proxy_storage_key',
  playbackStorageKey: 'playback_storage_key',
  posterStorageKey: 'poster_storage_key',
  captionsStorageKey: 'captions_storage_key',
  durationSeconds: 'duration_seconds',
  sizeBytes: 'size_bytes',
  width: 'width',
  height: 'height',
  fps: 'fps',
  videoCodec: 'video_codec',
  audioCodec: 'audio_codec',
  hasAudio: 'has_audio',
  title: 'title',
  sourceUrl: 'source_url',
  metadata: 'metadata',
  chunkSeconds: 'chunk_seconds',
  chunkCount: 'chunk_count',
};

export async function updateVideoMedia(videoId: string, update: VideoMediaUpdate): Promise<void> {
  const assignments: string[] = [];
  const params: unknown[] = [videoId];

  for (const [key, column] of Object.entries(mediaColumns) as [keyof VideoMediaUpdate, string][]) {
    const value = update[key];
    if (value === undefined) continue;
    params.push(key === 'metadata' ? JSON.stringify(value) : value);
    assignments.push(`${column} = $${params.length}${key === 'metadata' ? '::jsonb' : ''}`);
  }

  if (assignments.length === 0) return;
  await queryOne(`UPDATE videos SET ${assignments.join(', ')}, updated_at = now() WHERE id = $1`, params);
}

export async function setTranscriptStatus(
  videoId: string,
  status: TranscriptStatus,
  options: { source?: TranscriptSource | null; error?: string | null; segmentCount?: number } = {},
): Promise<void> {
  await queryOne(
    `UPDATE videos
        SET transcript_status = $2,
            transcript_source = COALESCE($3, transcript_source),
            transcript_error = $4,
            transcript_segment_count = COALESCE($5, transcript_segment_count),
            updated_at = now()
      WHERE id = $1`,
    [videoId, status, options.source ?? null, options.error ?? null, options.segmentCount ?? null],
  );
}

/**
 * Videos whose session has gone quiet, and whose footage is therefore
 * unreachable by anyone.
 *
 * A guest token lives in the browser tab, so a closed browser means the
 * session can never be used again. `last_seen_at` is how that looks from the
 * server: no requests since. The idle window is generous on purpose — a tab
 * left open overnight is still someone's session, and deleting their video out
 * from under them would be far worse than paying for another day of storage.
 */
export async function listVideosWithUnreachableFootage(
  idleSeconds: number,
  limit: number,
): Promise<Array<{ videoId: string; sessionId: string | null }>> {
  const rows = await queryRows<{ id: string; session_id: string | null }>(
    `SELECT v.id, v.session_id
       FROM videos v
       LEFT JOIN sessions s ON s.id = v.session_id
      WHERE v.footage_expired_at IS NULL
        -- A signed-in person's footage is not tied to a browser tab. Their
        -- session going quiet means they closed the laptop, not that the
        -- video is unreachable: they can sign in again. Guest footage keeps
        -- the old rule. What accounts eventually pay for storage is a product
        -- decision for later; silently deleting their videos is not.
        AND v.user_id IS NULL
        AND (
          v.session_id IS NULL
          OR s.id IS NULL
          OR s.expires_at <= now()
          OR s.last_seen_at < now() - ($1 || ' seconds')::interval
        )
      ORDER BY v.created_at ASC
      LIMIT $2`,
    [String(Math.floor(idleSeconds)), limit],
  );
  return rows.map((row) => ({ videoId: row.id, sessionId: row.session_id }));
}

/**
 * Records that the footage is gone and forgets where it was.
 *
 * The keys are nulled rather than left pointing at deleted objects: a key that
 * resolves to nothing is a lie the rest of the system would act on, signing
 * URLs for bytes that are not there. Chunk rows keep theirs, because deleting
 * them would cascade to the matches and take the feedback with it — the video
 * being flagged is what tells everything else the footage is gone.
 */
export async function markFootageExpired(videoId: string): Promise<void> {
  await queryOne(
    `UPDATE videos
        SET footage_expired_at = now(),
            original_storage_key = NULL,
            proxy_storage_key = NULL,
            playback_storage_key = NULL,
            captions_storage_key = NULL,
            updated_at = now()
      WHERE id = $1`,
    [videoId],
  );
}

export async function setIndexStatus(
  videoId: string,
  status: IndexStatus,
  options: {
    error?: string | null;
    sceneCount?: number;
    indexMs?: number;
    /**
     * The configuration this video was read under, snapshotted at read time.
     * Settings drift; a row that says what was set when it was written is
     * what keeps last month's numbers comparable to this month's.
     */
    analysisConfig?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await queryOne(
    `UPDATE videos
        SET index_status = $2,
            index_error = $3,
            scene_count = COALESCE($4, scene_count),
            index_ms = COALESCE($5, index_ms),
            analysis_config = COALESCE($6, analysis_config),
            updated_at = now()
      WHERE id = $1`,
    [
      videoId,
      status,
      options.error ?? null,
      options.sceneCount ?? null,
      options.indexMs ?? null,
      options.analysisConfig ? JSON.stringify(options.analysisConfig) : null,
    ],
  );
}

interface ChunkRow {
  id: string;
  video_id: string;
  chunk_index: number;
  global_start_seconds: number;
  global_end_seconds: number;
  duration_seconds: number;
  storage_key: string;
  created_at: Date;
}

function mapChunk(row: ChunkRow): VideoChunk {
  return {
    id: row.id,
    videoId: row.video_id,
    chunkIndex: row.chunk_index,
    globalStartSeconds: row.global_start_seconds,
    globalEndSeconds: row.global_end_seconds,
    durationSeconds: row.duration_seconds,
    storageKey: row.storage_key,
    createdAt: row.created_at,
  };
}

export interface NewChunk {
  chunkIndex: number;
  globalStartSeconds: number;
  globalEndSeconds: number;
  durationSeconds: number;
  storageKey: string;
}

export async function replaceChunks(videoId: string, chunks: NewChunk[]): Promise<VideoChunk[]> {
  await queryOne('DELETE FROM video_chunks WHERE video_id = $1', [videoId]);
  if (chunks.length === 0) return [];

  const values: string[] = [];
  const params: unknown[] = [videoId];
  for (const chunk of chunks) {
    const base = params.length;
    params.push(
      chunk.chunkIndex,
      chunk.globalStartSeconds,
      chunk.globalEndSeconds,
      chunk.durationSeconds,
      chunk.storageKey,
    );
    values.push(`($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
  }

  const rows = await queryRows<ChunkRow>(
    `INSERT INTO video_chunks (video_id, chunk_index, global_start_seconds, global_end_seconds, duration_seconds, storage_key)
     VALUES ${values.join(', ')}
     RETURNING *`,
    params,
  );
  return rows.map(mapChunk);
}

export async function listChunks(videoId: string): Promise<VideoChunk[]> {
  const rows = await queryRows<ChunkRow>(
    'SELECT * FROM video_chunks WHERE video_id = $1 ORDER BY chunk_index ASC',
    [videoId],
  );
  return rows.map(mapChunk);
}

export async function getChunk(chunkId: string): Promise<VideoChunk | null> {
  const row = await queryOne<ChunkRow>('SELECT * FROM video_chunks WHERE id = $1', [chunkId]);
  return row ? mapChunk(row) : null;
}

/**
 * Claims a video's footage for removal — or refuses, because it is no
 * longer a guest's.
 *
 * The sweep selects idle guest videos and then deletes their objects one by
 * one. Between the selection and the deletes, the guest can sign in and the
 * video becomes an account's: footage the person can now come back for
 * would be removed out from under them (Devin, #88). So the removal starts
 * by marking the video expired in ONE statement that also requires it to
 * still be unowned. Adoption's own update and this one contend on the row;
 * whichever commits first wins, and the other re-reads the row before it
 * moves. If adoption got there first, this finds nothing and the sweep
 * deletes nothing. The keys stay in place here — they are nulled by
 * markFootageExpired once the objects are actually gone.
 *
 * `onlyIfUnowned` is the sweep's rule. An owner removing their own video
 * has already been checked against it by the route, and their video is
 * theirs whoever it belonged to before; that call passes false.
 */
export async function claimFootageForExpiry(
  videoId: string,
  options: { onlyIfUnowned: boolean },
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE videos
        SET footage_expired_at = now(),
            updated_at = now()
      WHERE id = $1
        AND footage_expired_at IS NULL
        ${options.onlyIfUnowned ? 'AND user_id IS NULL' : ''}
      RETURNING id`,
    [videoId],
  );
  return row !== null;
}

/**
 * Gives a claim back when the removal it paid for failed part-way.
 *
 * A claim left standing after a failure would hide the video from every
 * later sweep — the selection skips expired videos — with its objects still
 * stored and the video reachable by nobody (Devin, #88). Released, the next
 * sweep selects it again; the deletes are safe to repeat. Only ever called
 * before markFootageExpired has run, so the keys are still in place.
 */
export async function releaseFootageClaim(videoId: string): Promise<void> {
  await queryOne(
    `UPDATE videos
        SET footage_expired_at = NULL,
            updated_at = now()
      WHERE id = $1`,
    [videoId],
  );
}
