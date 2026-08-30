import { queryOne, queryRows } from '../pool.js';
import type { Clip, ClipStatus } from '../../domain/types.js';

interface ClipRow {
  id: string;
  video_id: string;
  clip_match_id: string;
  session_id: string | null;
  user_id: string | null;
  workspace_id: string | null;
  captions: unknown;
  derived_from_clip_id: string | null;
  focus_pct: number;
  start_seconds: number;
  end_seconds: number;
  predicted_start_seconds: number | null;
  predicted_end_seconds: number | null;
  boundaries_edited_at: Date | null;
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
    workspaceId: row.workspace_id,
    captions: row.captions ?? null,
    derivedFromClipId: row.derived_from_clip_id,
    focusPct: Number(row.focus_pct ?? 50),
    startSeconds: row.start_seconds,
    endSeconds: row.end_seconds,
    predictedStartSeconds: row.predicted_start_seconds ?? null,
    predictedEndSeconds: row.predicted_end_seconds ?? null,
    boundariesEditedAt: row.boundaries_edited_at ?? null,
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
 *
 * Two rules the ON CONFLICT branch holds:
 *
 * - `predicted_*` is written once, on first insert, and never again. It is
 *   the model's answer frozen at the moment it was given — the ground truth
 *   half of every boundary-accuracy number.
 * - Boundaries someone has moved stay moved. Before `boundaries_edited_at`
 *   existed, regenerating a match silently reset the clip to the prediction;
 *   with editing in the product that would discard a person's correction —
 *   and the measurement of it — on an idempotent retry.
 */
export async function upsertClipForMatch(input: UpsertClipInput): Promise<Clip> {
  const row = await queryOne<ClipRow>(
    `INSERT INTO clips (video_id, clip_match_id, session_id, user_id, workspace_id,
                        start_seconds, end_seconds, predicted_start_seconds, predicted_end_seconds, status)
     VALUES ($1, $2, $3, $4, (SELECT workspace_id FROM videos WHERE id = $1), $5, $6, $5, $6, 'pending')
     ON CONFLICT (clip_match_id) WHERE derived_from_clip_id IS NULL DO UPDATE
       SET start_seconds = CASE WHEN clips.boundaries_edited_at IS NULL THEN EXCLUDED.start_seconds ELSE clips.start_seconds END,
           end_seconds = CASE WHEN clips.boundaries_edited_at IS NULL THEN EXCLUDED.end_seconds ELSE clips.end_seconds END,
           status = CASE WHEN clips.status = 'ready' THEN clips.status ELSE 'pending' END,
           error_message = CASE WHEN clips.status = 'ready' THEN clips.error_message ELSE NULL END,
           updated_at = now()
     RETURNING *`,
    [input.videoId, input.clipMatchId, input.sessionId, input.userId ?? null, input.startSeconds, input.endSeconds],
  );
  return mapClip(row!);
}

/**
 * The person's answer to the model's prediction: new boundaries, recorded as
 * an edit, and the row set back to pending for the re-render that makes the
 * file match. `predicted_*` is deliberately not in the SET list — this
 * function is the reason it exists, and the one write that must never reach
 * it. Runs only on root clips: a captioned copy inherits its footage from
 * its source, and its boundaries with it.
 *
 * The status condition in the WHERE is the claim, not a courtesy check: two
 * re-evaluations racing past an in-memory status read would otherwise both
 * write, share one queued render (stable job id), and leave the file cut
 * from one set of boundaries while the row describes the other. A clip
 * mid-render is refused; a FAILED clip is claimable on purpose — new
 * boundaries are precisely how a failed render gets another chance.
 */
export async function setClipBoundaries(
  clipId: string,
  startSeconds: number,
  endSeconds: number,
): Promise<Clip | null> {
  const row = await queryOne<ClipRow>(
    `UPDATE clips
        SET start_seconds = $2,
            end_seconds = $3,
            boundaries_edited_at = now(),
            status = 'pending',
            error_message = NULL,
            updated_at = now()
      WHERE id = $1 AND derived_from_clip_id IS NULL AND status IN ('ready', 'failed')
      RETURNING *`,
    [clipId, startSeconds, endSeconds],
  );
  return row ? mapClip(row) : null;
}

/**
 * Undoes a boundary change whose re-render never happened — the job could
 * not be queued, or the render itself terminally failed.
 *
 * Without this the row would keep describing the NEW boundaries while the
 * stored file (if any) still shows the old cut, and every later attempt
 * would be refused by the claim. Putting back the previous boundaries, the
 * previous edit mark and the previous STATUS returns the clip to exactly
 * the state the person could see — a re-evaluation that failed is one that
 * did not happen. Matches rows in 'pending' (never started) or
 * 'generating' (died mid-render).
 */
export async function restoreClipBoundaries(
  clipId: string,
  previous: {
    startSeconds: number;
    endSeconds: number;
    boundariesEditedAt: Date | null;
    status?: 'ready' | 'failed';
  },
): Promise<void> {
  await queryOne(
    `UPDATE clips
        SET start_seconds = $2,
            end_seconds = $3,
            boundaries_edited_at = $4,
            status = $5,
            updated_at = now()
      WHERE id = $1 AND status IN ('pending', 'generating')`,
    [clipId, previous.startSeconds, previous.endSeconds, previous.boundariesEditedAt, previous.status ?? 'ready'],
  );
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
 * The caller's own library: every finished clip they can still play, newest
 * first.
 *
 * Theirs, and only theirs — being in a shared room does not put other
 * people's clips here, and nothing can move a clip out. What a room holds is
 * a separate question, answered by listWorkspaceClips.
 *
 * Only clips whose file still exists: the retention sweep nulls storage keys
 * when guest footage goes, and listing a clip we cannot play would be
 * offering something we no longer have.
 */
export async function listClipsForPrincipal(
  principal: {
    sessionId: string | null;
    userId: string | null;
    workspaceId?: string | null;
  },
  page: {
    /** Return clips strictly older than this; omit for the newest page. */
    before?: Date;
    limit: number;
  },
): Promise<LibraryClip[]> {
  // A signed-in person's own library; a guest's tab. The NULL-workspace arm
  // is a safety net for rows written before the personal workspace existed —
  // still this person's clips, and a library must not lose them.
  const usePersonal = Boolean(principal.workspaceId && principal.userId);
  const scope = usePersonal
    ? '(c.workspace_id = $1 OR (c.user_id = $4 AND c.workspace_id IS NULL))'
    : principal.userId
      ? 'c.user_id = $1'
      : 'c.session_id = $1';
  const owner = (usePersonal ? principal.workspaceId : principal.userId ?? principal.sessionId) ?? null;
  if (!owner) return [];

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
    usePersonal ? [owner, page.before ?? null, page.limit, principal.userId] : [owner, page.before ?? null, page.limit],
  );

  return rows.map((row) => ({
    clip: mapClip(row),
    description: row.description,
    thumbnailKey: row.thumbnail_key ?? null,
    videoTitle: row.video_title ?? row.video_filename ?? null,
  }));
}

/**
 * The clips that have been sent to a shared room, newest share first.
 *
 * Ordered by when it was SENT, not when it was cut: a room is a feed of what
 * people have put in it, and a clip cut last week but shared this morning is
 * this morning's news to everyone else in it.
 */
export async function listWorkspaceClips(workspaceId: string, limit = 60): Promise<LibraryClip[]> {
  const rows = await queryRows<
    ClipRow & { description: string; thumbnail_key: string | null; video_title: string | null; video_filename: string | null }
  >(
    `SELECT c.*, m.description, m.thumbnail_key, v.title AS video_title, v.original_filename AS video_filename
       FROM workspace_clips s
       JOIN clips c ON c.id = s.clip_id
       JOIN clip_matches m ON m.id = c.clip_match_id
       JOIN videos v ON v.id = c.video_id
      WHERE s.workspace_id = $1
        AND c.status = 'ready'
        AND c.storage_key IS NOT NULL
      ORDER BY s.created_at DESC
      LIMIT $2`,
    [workspaceId, limit],
  );
  return rows.map((row) => ({
    clip: mapClip(row),
    description: row.description,
    thumbnailKey: row.thumbnail_key ?? null,
    videoTitle: row.video_title ?? row.video_filename ?? null,
  }));
}

/** Send a clip to a room. Sending the same clip twice is not an error. */
export async function shareClipToWorkspace(input: {
  workspaceId: string;
  clipId: string;
  sharedBy: string;
}): Promise<void> {
  await queryOne(
    `INSERT INTO workspace_clips (workspace_id, clip_id, shared_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, clip_id) DO NOTHING
     RETURNING clip_id`,
    [input.workspaceId, input.clipId, input.sharedBy],
  );
}

/** Take a clip back out of a room. The clip itself is untouched. */
export async function unshareClipFromWorkspace(workspaceId: string, clipId: string): Promise<boolean> {
  const row = await queryOne<{ clip_id: string }>(
    `DELETE FROM workspace_clips WHERE workspace_id = $1 AND clip_id = $2 RETURNING clip_id`,
    [workspaceId, clipId],
  );
  return row !== null;
}

/** Which of the caller's rooms a clip has already been sent to. */
export async function listWorkspacesForClip(clipId: string): Promise<string[]> {
  const rows = await queryRows<{ workspace_id: string }>(
    'SELECT workspace_id FROM workspace_clips WHERE clip_id = $1',
    [clipId],
  );
  return rows.map((row) => row.workspace_id);
}

/**
 * A derived clip: the same moment as its source, rendered again with captions
 * burned in. It belongs to whoever pressed the button — their library, their
 * workspace — and remembers where it came from.
 */
export async function insertDerivedClip(input: {
  sourceClip: Clip;
  sessionId: string | null;
  userId: string | null;
  workspaceId: string | null;
  captions: unknown;
}): Promise<Clip> {
  const row = await queryOne<ClipRow>(
    `INSERT INTO clips (video_id, clip_match_id, session_id, user_id, workspace_id,
                        captions, derived_from_clip_id, start_seconds, end_seconds, status)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, 'pending')
     RETURNING *`,
    [
      input.sourceClip.videoId,
      input.sourceClip.clipMatchId,
      input.sessionId,
      input.userId,
      input.workspaceId,
      JSON.stringify(input.captions),
      input.sourceClip.id,
      input.sourceClip.startSeconds,
      input.sourceClip.endSeconds,
    ],
  );
  return mapClip(row!);
}

/**
 * Send a clip back through rendering. Deliberately does NOT touch the caption
 * spec: the new spec rides in the job and is written only when its render
 * succeeds, so the row always describes the file that exists.
 */
export async function setClipRenderPending(clipId: string): Promise<void> {
  await queryOne(
    `UPDATE clips SET status = 'pending', error_message = NULL, updated_at = now() WHERE id = $1 RETURNING id`,
    [clipId],
  );
}

/** The root clip cut from a moment, if one exists. Copies stay out of it. */
export async function getRootClipByMatchId(matchId: string): Promise<Clip | null> {
  const row = await queryOne<ClipRow>(
    `SELECT * FROM clips WHERE clip_match_id = $1 AND derived_from_clip_id IS NULL`,
    [matchId],
  );
  return row ? mapClip(row) : null;
}

export async function getClip(clipId: string): Promise<Clip | null> {
  const row = await queryOne<ClipRow>('SELECT * FROM clips WHERE id = $1', [clipId]);
  return row ? mapClip(row) : null;
}

export async function listClipsForRequest(requestId: string): Promise<Clip[]> {
  // Originals only. A match can now also have DERIVED clips (captioned
  // copies, possibly other people's); without this filter they collide with
  // the original in the by-match map and a search result can end up pointing
  // at a clip its owner cannot even open.
  const rows = await queryRows<ClipRow>(
    `SELECT c.* FROM clips c
       JOIN clip_matches m ON m.id = c.clip_match_id
      WHERE m.clip_request_id = $1
        AND c.derived_from_clip_id IS NULL
      ORDER BY c.start_seconds ASC`,
    [requestId],
  );
  return rows.map(mapClip);
}

export async function setClipStatus(
  clipId: string,
  status: ClipStatus,
  options: {
    errorMessage?: string | null;
    storageKey?: string | null;
    durationSeconds?: number | null;
    sizeBytes?: number | null;
    /** Written only when provided — on the success of the render that used it. */
    captions?: unknown;
  } = {},
): Promise<void> {
  await queryOne(
    `UPDATE clips
        SET status = $2,
            error_message = $3,
            storage_key = COALESCE($4, storage_key),
            duration_seconds = COALESCE($5, duration_seconds),
            size_bytes = COALESCE($6, size_bytes),
            captions = COALESCE($7::jsonb, captions),
            updated_at = now()
      WHERE id = $1`,
    [
      clipId,
      status,
      options.errorMessage ?? null,
      options.storageKey ?? null,
      options.durationSeconds ?? null,
      options.sizeBytes ?? null,
      options.captions === undefined ? null : JSON.stringify(options.captions),
    ],
  );
}
