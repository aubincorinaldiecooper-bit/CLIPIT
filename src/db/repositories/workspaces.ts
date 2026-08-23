import { createHash, randomBytes } from 'node:crypto';
import { queryOne, queryRows, withTransaction } from '../pool.js';

/**
 * Workspaces: the room a team works in (migration 017). A workspace shares
 * everything — library and connected accounts alike — so membership is the
 * answer to "may this person see this", and every row here belongs to a
 * signed-in user, never a guest session.
 */

export interface WorkspaceRow {
  id: string;
  name: string;
  owner_user_id: string;
  created_at: Date;
}

export interface WorkspaceMemberRow {
  workspace_id: string;
  user_id: string;
  role: string;
  email: string | null;
  joined_at: Date;
}

export interface WorkspaceInviteRow {
  id: string;
  workspace_id: string;
  email: string;
  invited_by: string;
  expires_at: Date;
  accepted_at: Date | null;
  accepted_by: string | null;
  revoked_at: Date | null;
  created_at: Date;
}

const INVITE_COLUMNS = `id, workspace_id, email, invited_by, expires_at, accepted_at, accepted_by, revoked_at, created_at`;

// --- workspaces and membership ----------------------------------------------

export async function getWorkspaceForUser(userId: string): Promise<WorkspaceRow | null> {
  return queryOne<WorkspaceRow>(
    `SELECT w.id, w.name, w.owner_user_id, w.created_at
       FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.user_id = $1`,
    [userId],
  );
}

export async function getMembership(userId: string): Promise<WorkspaceMemberRow | null> {
  return queryOne<WorkspaceMemberRow>(
    `SELECT workspace_id, user_id, role, email, joined_at FROM workspace_members WHERE user_id = $1`,
    [userId],
  );
}

export async function listMembers(workspaceId: string): Promise<WorkspaceMemberRow[]> {
  return queryRows<WorkspaceMemberRow>(
    `SELECT workspace_id, user_id, role, email, joined_at
       FROM workspace_members WHERE workspace_id = $1
      ORDER BY (role = 'owner') DESC, joined_at ASC`,
    [workspaceId],
  );
}

/**
 * Every user id that shares a workspace with this one — the caller included,
 * always, even before any workspace row exists. Authorization asks this
 * question on every signed-in request, so it must answer with the caller
 * rather than an empty list when a workspace has not been provisioned yet.
 */
export async function listWorkspaceUserIds(userId: string): Promise<string[]> {
  const rows = await queryRows<{ user_id: string }>(
    `SELECT peer.user_id
       FROM workspace_members me
       JOIN workspace_members peer ON peer.workspace_id = me.workspace_id
      WHERE me.user_id = $1`,
    [userId],
  );
  const ids = rows.map((row) => row.user_id);
  return ids.includes(userId) ? ids : [userId, ...ids];
}

/**
 * The user's own workspace, created on first use. Two racing first-uses
 * converge on one row: the owner index makes the second INSERT a no-op and
 * the existing row is returned.
 */
export async function insertWorkspace(input: {
  name: string;
  ownerUserId: string;
  email: string | null;
}): Promise<WorkspaceRow> {
  const created = await queryOne<WorkspaceRow>(
    `INSERT INTO workspaces (name, owner_user_id)
     VALUES ($1, $2)
     ON CONFLICT (owner_user_id) DO UPDATE SET owner_user_id = workspaces.owner_user_id
     RETURNING id, name, owner_user_id, created_at`,
    [input.name, input.ownerUserId],
  );
  const workspace = created!;
  await queryOne(
    `INSERT INTO workspace_members (workspace_id, user_id, role, email)
     VALUES ($1, $2, 'owner', $3)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING user_id`,
    [workspace.id, input.ownerUserId, input.email],
  );
  return workspace;
}

export async function removeMember(workspaceId: string, userId: string): Promise<boolean> {
  const row = await queryOne<{ user_id: string }>(
    `DELETE FROM workspace_members
      WHERE workspace_id = $1 AND user_id = $2 AND role <> 'owner'
      RETURNING user_id`,
    [workspaceId, userId],
  );
  return row !== null;
}

/** Records the email a member signed in with, when it was not known before. */
export async function setMemberEmail(userId: string, email: string): Promise<void> {
  await queryOne(
    `UPDATE workspace_members SET email = $2 WHERE user_id = $1 AND (email IS NULL OR email <> $2) RETURNING user_id`,
    [userId, email],
  );
}

// --- invites ----------------------------------------------------------------

/** SHA-256 hex: deterministic for lookup, one-way so a DB read is not a key. */
function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function insertInvite(input: {
  workspaceId: string;
  email: string;
  invitedBy: string;
  ttlSeconds: number;
}): Promise<{ invite: WorkspaceInviteRow; token: string }> {
  const token = randomBytes(32).toString('base64url');
  const invite = await queryOne<WorkspaceInviteRow>(
    `INSERT INTO workspace_invites (workspace_id, email, token_hash, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)
     RETURNING ${INVITE_COLUMNS}`,
    [input.workspaceId, input.email, hashInviteToken(token), input.invitedBy, String(input.ttlSeconds)],
  );
  return { invite: invite!, token };
}

export async function listPendingInvites(workspaceId: string): Promise<WorkspaceInviteRow[]> {
  return queryRows<WorkspaceInviteRow>(
    `SELECT ${INVITE_COLUMNS}
       FROM workspace_invites
      WHERE workspace_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC`,
    [workspaceId],
  );
}

/** Look an invite up by its raw token without spending it — for the preview
 *  the acceptance page shows before anyone commits to joining. */
export async function findInviteByToken(token: string): Promise<WorkspaceInviteRow | null> {
  return queryOne<WorkspaceInviteRow>(
    `SELECT ${INVITE_COLUMNS} FROM workspace_invites WHERE token_hash = $1`,
    [hashInviteToken(token)],
  );
}

/**
 * Spend an invite AND take up the membership it grants, in one transaction.
 *
 * These two must not be separable. Consuming the token first and writing the
 * membership after leaves a window where the invitation is spent and nobody
 * joined — and because the token is single-use, every retry then fails
 * against an "already used" invitation that never let anyone in. Either both
 * happen or neither does, and a membership write that affects no row rolls
 * the consumption back.
 *
 * Returns null when the token was not spendable (expired, revoked, already
 * used, or never existed) — the caller cannot tell which, deliberately.
 */
export async function acceptInviteAndJoin(
  token: string,
  userId: string,
  fallbackEmail: string | null,
): Promise<WorkspaceInviteRow | null> {
  return withTransaction(async (client) => {
    const consumed = await client.query<WorkspaceInviteRow>(
      `UPDATE workspace_invites
          SET accepted_at = now(), accepted_by = $2
        WHERE token_hash = $1
          AND accepted_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > now()
        RETURNING ${INVITE_COLUMNS}`,
      [hashInviteToken(token), userId],
    );
    const invite = consumed.rows[0];
    if (!invite) return null;

    // One statement covers both cases — a first-time joiner and a person
    // moving out of the room they were alone in — so a membership race
    // cannot land between a failed INSERT and a compensating UPDATE.
    const joined = await client.query<{ user_id: string }>(
      `INSERT INTO workspace_members (workspace_id, user_id, role, email)
       VALUES ($1, $2, 'member', $3)
       ON CONFLICT (user_id) DO UPDATE
          SET workspace_id = EXCLUDED.workspace_id,
              role = 'member',
              email = COALESCE(workspace_members.email, EXCLUDED.email),
              joined_at = now()
       RETURNING user_id`,
      [invite.workspace_id, userId, fallbackEmail ?? invite.email],
    );
    if (joined.rowCount === 0) {
      // Nothing joined, so nothing may be spent either.
      throw new Error('workspace membership write affected no row');
    }

    // The room they left, if it was theirs and now stands empty.
    await client.query(
      `DELETE FROM workspaces w
        WHERE w.owner_user_id = $1
          AND NOT EXISTS (SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id)`,
      [userId],
    );

    return invite;
  });
}

export async function revokeInvite(workspaceId: string, inviteId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE workspace_invites SET revoked_at = now()
      WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
      RETURNING id`,
    [inviteId, workspaceId],
  );
  return row !== null;
}
