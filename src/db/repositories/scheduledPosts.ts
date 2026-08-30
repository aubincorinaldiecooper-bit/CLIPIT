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
  post_ids: string[];
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
 * How long a claim may sit in 'firing' before another run may take it over.
 * A process that died between claiming and recording an outcome leaves the
 * row here; the in-flight guard inside the publish path is what keeps the
 * reclaim from double-posting when the first attempt got as far as
 * submitting. Exported because the worker has to re-arm its own alarm for
 * exactly this long — BullMQ's stall retry fires sooner than this window,
 * and a retry that arrives too early would otherwise be the LAST one.
 */
export const CLAIM_QUARANTINE_MS = 10 * 60 * 1000;

/**
 * Claim a scheduled post for firing. Only a 'waiting' row can be claimed —
 * plus one exception: a row stuck in 'firing' past the quarantine above.
 */
export async function claimScheduledPost(id: string): Promise<ScheduledPostRow | null> {
  const rows = await queryRows<ScheduledPostRow>(
    `UPDATE scheduled_posts
        SET status = 'firing', claimed_at = now()
      WHERE id = $1
        AND (status = 'waiting'
             OR (status = 'firing' AND claimed_at < now() - make_interval(secs => $2)))
      RETURNING *`,
    [id, CLAIM_QUARANTINE_MS / 1000],
  );
  return rows[0] ?? null;
}

/**
 * The worker ran and handed the publish off. `postIds` is what it created —
 * the schedule stops being the record of the outcome at this point, and
 * those rows become it (a shape still being cut can still fail later, and
 * saying "fired" without them would call that a success).
 */
export async function markScheduledPostFired(id: string, postIds: string[]): Promise<void> {
  await queryRows(
    `UPDATE scheduled_posts
        SET status = 'fired', fired_at = now(), error = NULL, post_ids = $2::jsonb
      WHERE id = $1 AND status = 'firing'`,
    [id, JSON.stringify(postIds)],
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

/**
 * One promise as a person needs to read it: what it is, when it goes (or
 * went), and what actually happened.
 *
 * `outcome` is derived from the published_posts rows the fire created, not
 * from the schedule's own status: a schedule can be 'fired' while a shape
 * is still being cut, and that render can still fail. Reading the posts is
 * what keeps "Posted" from being a claim nobody checked.
 */
export interface ScheduledPostView extends ScheduledPostRow {
  clip_description: string | null;
  /** null while waiting; otherwise what the posts say as a whole. */
  outcome: 'posting' | 'posted' | 'partly_failed' | 'failed' | null;
}

function deriveOutcome(
  row: ScheduledPostRow,
  postStatuses: string[],
): ScheduledPostView['outcome'] {
  if (row.status === 'waiting' || row.status === 'canceled') return null;
  // The fire itself failed: nothing was ever handed off.
  if (row.status === 'failed') return 'failed';
  if (row.status === 'firing') return 'posting';
  if (postStatuses.length === 0) return 'posting';
  const failed = postStatuses.filter((status) => status === 'failed').length;
  const pending = postStatuses.filter((status) => status === 'submitting' || status === 'rendering').length;
  if (failed === postStatuses.length) return 'failed';
  if (failed > 0) return 'partly_failed';
  if (pending > 0) return 'posting';
  return 'posted';
}

/**
 * The promises worth showing: everything still waiting, plus anything that
 * fired or failed recently. A failed promise that vanished from the list
 * would turn a missed publication into a silent one — the exact failure
 * this codebase bans.
 */
export async function listScheduledPostsForUser(
  userId: string,
  recentDays = 7,
): Promise<ScheduledPostView[]> {
  const rows = await queryRows<ScheduledPostRow & { clip_description: string | null; post_statuses: string[] | null }>(
    `SELECT sp.*,
            COALESCE(c.title, m.description) AS clip_description,
            COALESCE(
              (SELECT array_agg(pp.status)
                 FROM published_posts pp
                WHERE pp.id::text = ANY (SELECT jsonb_array_elements_text(sp.post_ids))),
              ARRAY[]::text[]
            ) AS post_statuses
       FROM scheduled_posts sp
       LEFT JOIN clips c ON c.id = sp.clip_id
       LEFT JOIN clip_matches m ON m.id = c.clip_match_id
      WHERE sp.user_id = $1
        AND (sp.status = 'waiting'
             OR (sp.status <> 'canceled' AND sp.scheduled_at > now() - make_interval(days => $2)))
      ORDER BY sp.scheduled_at ASC
      LIMIT 100`,
    [userId, recentDays],
  );
  return rows.map((row) => ({
    ...row,
    outcome: deriveOutcome(row, row.post_statuses ?? []),
  }));
}

/** Waiting scheduled posts for one clip — what blocks deleting it. */
export async function listWaitingScheduledPostsForClip(clipId: string): Promise<ScheduledPostRow[]> {
  return queryRows<ScheduledPostRow>(
    `SELECT * FROM scheduled_posts WHERE clip_id = $1 AND status = 'waiting'`,
    [clipId],
  );
}
