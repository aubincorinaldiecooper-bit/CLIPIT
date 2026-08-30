import { queryRows } from '../pool.js';

/**
 * The record of publishes promised for later.
 *
 * The queue's delayed job is the alarm clock; this table is the promise
 * itself — what goes out, where, when, and afterwards whether it did. Every
 * transition is a guarded UPDATE, so two workers (or a worker and a cancel)
 * racing over the same row cannot both win.
 */

export interface ScheduledPostRow {
  id: string;
  user_id: string;
  workspace_id: string;
  clip_id: string;
  caption: string;
  account_ids: string[];
  scheduled_at: Date;
  status: 'waiting' | 'firing' | 'fired' | 'failed' | 'canceled';
  error: string | null;
  created_at: Date;
  claimed_at: Date | null;
  fired_at: Date | null;
}

export async function insertScheduledPost(input: {
  userId: string;
  workspaceId: string;
  clipId: string;
  caption: string;
  accountIds: string[];
  scheduledAt: Date;
}): Promise<ScheduledPostRow> {
  const rows = await queryRows<ScheduledPostRow>(
    `INSERT INTO scheduled_posts (user_id, workspace_id, clip_id, caption, account_ids, scheduled_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING *`,
    [input.userId, input.workspaceId, input.clipId, input.caption, JSON.stringify(input.accountIds), input.scheduledAt],
  );
  return rows[0]!;
}

export async function getScheduledPost(id: string): Promise<ScheduledPostRow | null> {
  const rows = await queryRows<ScheduledPostRow>(`SELECT * FROM scheduled_posts WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

/**
 * Claim a scheduled post for firing. Only a 'waiting' row can be claimed —
 * plus one exception: a row stuck in 'firing' for over ten minutes, which
 * means the process died between claiming and recording an outcome. The
 * in-flight guard inside the publish path keeps that reclaim from double-
 * posting when the first attempt got as far as submitting.
 */
export async function claimScheduledPost(id: string): Promise<ScheduledPostRow | null> {
  const rows = await queryRows<ScheduledPostRow>(
    `UPDATE scheduled_posts
        SET status = 'firing', claimed_at = now()
      WHERE id = $1
        AND (status = 'waiting'
             OR (status = 'firing' AND claimed_at < now() - interval '10 minutes'))
      RETURNING *`,
    [id],
  );
  return rows[0] ?? null;
}

export async function markScheduledPostFired(id: string): Promise<void> {
  await queryRows(
    `UPDATE scheduled_posts SET status = 'fired', fired_at = now(), error = NULL WHERE id = $1 AND status = 'firing'`,
    [id],
  );
}

export async function markScheduledPostFailed(id: string, error: string): Promise<void> {
  // Truncated the same way reclip errors are: this column is shown to a
  // person, and a stack trace is not an explanation.
  await queryRows(
    `UPDATE scheduled_posts SET status = 'failed', fired_at = now(), error = $2 WHERE id = $1 AND status = 'firing'`,
    [id, error.slice(0, 500)],
  );
}

/** Cancel: only a promise not yet being kept can be taken back. */
export async function cancelScheduledPost(id: string, userId: string): Promise<ScheduledPostRow | null> {
  const rows = await queryRows<ScheduledPostRow>(
    `UPDATE scheduled_posts SET status = 'canceled' WHERE id = $1 AND user_id = $2 AND status = 'waiting' RETURNING *`,
    [id, userId],
  );
  return rows[0] ?? null;
}

/** The user's pending promises, soonest first — what the UI lists and cancels. */
export async function listWaitingScheduledPosts(userId: string): Promise<Array<ScheduledPostRow & { clip_description: string | null }>> {
  return queryRows<ScheduledPostRow & { clip_description: string | null }>(
    `SELECT sp.*, COALESCE(c.title, m.description) AS clip_description
       FROM scheduled_posts sp
       JOIN clips c ON c.id = sp.clip_id
       LEFT JOIN clip_matches m ON m.id = c.clip_match_id
      WHERE sp.user_id = $1 AND sp.status = 'waiting'
      ORDER BY sp.scheduled_at ASC
      LIMIT 100`,
    [userId],
  );
}

/** Waiting scheduled posts for one clip — what blocks deleting it. */
export async function listWaitingScheduledPostsForClip(clipId: string): Promise<ScheduledPostRow[]> {
  return queryRows<ScheduledPostRow>(
    `SELECT * FROM scheduled_posts WHERE clip_id = $1 AND status = 'waiting'`,
    [clipId],
  );
}
