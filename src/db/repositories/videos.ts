import { queryOne, queryRows } from '../pool.js';
import type {
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
  captions_storage_key: string | null;
  chunk_seconds: number | null;
  chunk_count: number;
  transcript_status: TranscriptStatus;
  transcript_source: TranscriptSource | null;
  transcript_error: string | null;
  transcript_segment_count: number;
  created_at: Date;
  updated_at: Date;
}

function mapVideo(row: VideoRow): Video {
  return {
    id: row.id,
    sessionId: row.session_id,
    userId: row.user_id,
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
    captionsStorageKey: row.captions_storage_key,
    chunkSeconds: row.chunk_seconds,
    chunkCount: row.chunk_count,
    transcriptStatus: row.transcript_status,
    transcriptSource: row.transcript_source,
    transcriptError: row.transcript_error,
    transcriptSegmentCount: row.transcript_segment_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateVideoInput {
  sessionId: string | null;
  userId?: string | null;
  sourceType: SourceType;
  sourceUrl?: string | null;
  originalFilename?: string | null;
  title?: string | null;
  status: VideoStatus;
  originalStorageKey?: string | null;
}

export async function createVideo(input: CreateVideoInput): Promise<Video> {
  const row = await queryOne<VideoRow>(
    `INSERT INTO videos (session_id, user_id, source_type, source_url, original_filename, title, status, original_storage_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
    ],
  );
  return mapVideo(row!);
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
