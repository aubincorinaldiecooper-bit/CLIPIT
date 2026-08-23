import { queryOne, queryRows } from '../pool.js';
import type { Clip, ClipStatus } from '../../domain/types.js';

interface ClipRow {
  id: string;
  video_id: string;
  clip_match_id: string;
  session_id: string | null;
  user_id: string | null;
  start_seconds: number;
  end_seconds: number;
  storage_key: string | null;
  status: ClipStatus;
  error_message: string | null;
  duration_seconds: number | null;
  size_bytes: number | null;
  created_at: Date;
  updated_at: Date;
}

function mapClip(row: ClipRow): Clip {
  return {
    id: row.id,
    videoId: row.video_id,
    clipMatchId: row.clip_match_id,
    sessionId: row.session_id,
    userId: row.user_id,
    startSeconds: row.start_seconds,
    endSeconds: row.end_seconds,
    storageKey: row.storage_key,
    status: row.status,
    errorMessage: row.error_message,
    durationSeconds: row.duration_seconds,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertClipInput {
  videoId: string;
  clipMatchId: string;
  sessionId: string | null;
  userId?: string | null;
  startSeconds: number;
  endSeconds: number;
}

/**
 * One clip per match. Re-generating an existing match resets it to `pending`
 * rather than creating a duplicate, which keeps `generate` idempotent.
 */
export async function upsertClipForMatch(input: UpsertClipInput): Promise<Clip> {
  const row = await queryOne<ClipRow>(
    `INSERT INTO clips (video_id, clip_match_id, session_id, user_id, start_seconds, end_seconds, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     ON CONFLICT (clip_match_id) DO UPDATE
       SET start_seconds = EXCLUDED.start_seconds,
           end_seconds = EXCLUDED.end_seconds,
           status = CASE WHEN clips.status = 'ready' THEN clips.status ELSE 'pending' END,
           error_message = CASE WHEN clips.status = 'ready' THEN clips.error_message ELSE NULL END,
           updated_at = now()
     RETURNING *`,
    [input.videoId, input.clipMatchId, input.sessionId, input.userId ?? null, input.startSeconds, input.endSeconds],
  );
  return mapClip(row!);
}

/** Every clip file cut from this video, so they can be deleted with it. */
export async function listClipKeysForVideo(videoId: string): Promise<string[]> {
  const rows = await queryRows<{ storage_key: string }>(
    'SELECT storage_key FROM clips WHERE video_id = $1 AND storage_key IS NOT NULL',
    [videoId],
  );
  return rows.map((row) => row.storage_key);
}

/** Forgets where the clips were, once their bytes are gone. */
export async function clearClipKeysForVideo(videoId: string): Promise<void> {
  await queryOne('UPDATE clips SET storage_key = NULL, updated_at = now() WHERE video_id = $1', [videoId]);
}

/**
 * A clip as the library shows it: the cut itself plus what it is OF — the
 * moment's description and still from the match, and the video's name.
 * Joined here rather than fetched per clip, because a library page that fires
 * sixty follow-up requests is a library that feels broken on hotel wifi.
 */
export interface LibraryClip {
  clip: Clip;
  description: string;
  thumbnailKey: string | null;
  videoTitle: string | null;
}

/**
 * Every finished clip the caller can still play, newest first.
 *
 * Owned by the person when signed in — across every session they have ever
 * had — and by the single session otherwise. Only clips whose file still
 * exists: the retention sweep nulls storage keys when guest footage goes, and
 * listing a clip we cannot play would be offering something we no longer have.
 */
export async function listClipsForPrincipal(
  principal: {
    sessionId: string | null;
    userId: string | null;
    userIds?: string[];
  },
  page: {
    /** Return clips strictly older than this; omit for the newest page. */
    before?: Date;
    limit: number;
  },
): Promise<LibraryClip[]> {
  // Signed in: the workspace's clips, teammates' included. Guest: this tab's.
  const scope = principal.userId ? 'c.user_id = ANY($1::text[])' : 'c.session_id = ANY($1::text[])';
  const owners = principal.userId
    ? principal.userIds?.length
      ? principal.userIds
      : [principal.userId]
    : principal.sessionId
      ? [principal.sessionId]
      : [];
  if (owners.length === 0) return [];

  // Keyset rather than offset: a library someone scrolls while cutting new
  // clips must not shift under them, and "skip 60" does exactly that when
  // clip 61 arrives mid-scroll.
  const rows = await queryRows<ClipRow & { description: string; thumbnail_key: string | null; video_title: string | null; video_filename: string | null }>(
    `SELECT c.*, m.description, m.thumbnail_key, v.title AS video_title, v.original_filename AS video_filename
       FROM clips c
       JOIN clip_matches m ON m.id = c.clip_match_id
       JOIN videos v ON v.id = c.video_id
      WHERE ${scope}
        AND c.status = 'ready'
        AND c.storage_key IS NOT NULL
        AND ($2::timestamptz IS NULL OR c.created_at < $2)
      ORDER BY c.created_at DESC
      LIMIT $3`,
    [owners, page.before ?? null, page.limit],
  );

  return rows.map((row) => ({
    clip: mapClip(row),
    description: row.description,
    thumbnailKey: row.thumbnail_key ?? null,
    videoTitle: row.video_title ?? row.video_filename ?? null,
  }));
}

export async function getClip(clipId: string): Promise<Clip | null> {
  const row = await queryOne<ClipRow>('SELECT * FROM clips WHERE id = $1', [clipId]);
  return row ? mapClip(row) : null;
}

export async function listClipsForRequest(requestId: string): Promise<Clip[]> {
  const rows = await queryRows<ClipRow>(
    `SELECT c.* FROM clips c
       JOIN clip_matches m ON m.id = c.clip_match_id
      WHERE m.clip_request_id = $1
      ORDER BY c.start_seconds ASC`,
    [requestId],
  );
  return rows.map(mapClip);
}

export async function setClipStatus(
  clipId: string,
  status: ClipStatus,
  options: { errorMessage?: string | null; storageKey?: string | null; durationSeconds?: number | null; sizeBytes?: number | null } = {},
): Promise<void> {
  await queryOne(
    `UPDATE clips
        SET status = $2,
            error_message = $3,
            storage_key = COALESCE($4, storage_key),
            duration_seconds = COALESCE($5, duration_seconds),
            size_bytes = COALESCE($6, size_bytes),
            updated_at = now()
      WHERE id = $1`,
    [
      clipId,
      status,
      options.errorMessage ?? null,
      options.storageKey ?? null,
      options.durationSeconds ?? null,
      options.sizeBytes ?? null,
    ],
  );
}
