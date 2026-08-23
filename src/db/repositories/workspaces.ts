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

/**
 * The workspace this person is currently working in — the one their library
 * shows and their next upload lands in. Null only before their first
 * workspace exists.
 */
export async function getActiveWorkspace(userId: string): Promise<WorkspaceRow | null> {
  return queryOne<WorkspaceRow>(
    `SELECT w.id, w.name, w.owner_user_id, w.created_at
       FROM workspace_active a
       JOIN workspaces w ON w.id = a.workspace_id
      WHERE a.user_id = $1`,
    [userId],
  );
}

/** Every workspace this person belongs to, their own first. */
export async function listWorkspacesForUser(
  userId: string,
): Promise<Array<WorkspaceRow & { role: string; is_active: boolean }>> {
  return queryRows<WorkspaceRow & { role: string; is_active: boolean }>(
    `SELECT w.id, w.name, w.owner_user_id, w.created_at, m.role,
            (a.workspace_id = w.id) AS is_active
       FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
       LEFT JOIN workspace_active a ON a.user_id = m.user_id
      WHERE m.user_id = $1
      ORDER BY (w.owner_user_id = $1) DESC, m.joined_at ASC`,
    [userId],
  );
}

/** This person's membership of one workspace — the role check for owner-only acts. */
export async function getMembership(userId: string, workspaceId: string): Promise<WorkspaceMemberRow | null> {
  return queryOne<WorkspaceMemberRow>(
    `SELECT workspace_id, user_id, role, email, joined_at
       FROM workspace_members WHERE user_id = $1 AND workspace_id = $2`,
    [userId, workspaceId],
  );
}

/** Switch rooms. Refuses a workspace the person is not a member of. */
export async function setActiveWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const row = await queryOne<{ user_id: string }>(
    `INSERT INTO workspace_active (user_id, workspace_id)
     SELECT $1, $2
      WHERE EXISTS (SELECT 1 FROM workspace_members WHERE user_id = $1 AND workspace_id = $2)
     ON CONFLICT (user_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, updated_at = now()
     RETURNING user_id`,
    [userId, workspaceId],
  );
  return row !== null;
}

/**
 * Leave a workspace. An owner cannot leave their own — it is their room, and
 * a room with no owner has nobody who can invite or remove anyone. When the
 * room they leave was the one they were working in, they land back in their
 * own.
 */
export async function leaveWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  return withTransaction(async (client) => {
    const left = await client.query<{ user_id: string }>(
      `DELETE FROM workspace_members
        WHERE user_id = $1 AND workspace_id = $2 AND role <> 'owner'
        RETURNING user_id`,
      [userId, workspaceId],
    );
    if (left.rowCount === 0) return false;

    await client.query(
      `UPDATE workspace_active a
          SET workspace_id = (
                SELECT m.workspace_id FROM workspace_members m
                 JOIN workspaces w ON w.id = m.workspace_id
                WHERE m.user_id = $1
                ORDER BY (w.owner_user_id = $1) DESC, m.joined_at ASC
                LIMIT 1
              ),
              updated_at = now()
        WHERE a.user_id = $1 AND a.workspace_id = $2`,
      [userId, workspaceId],
    );
    return true;
  });
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
 * What a signed-in caller may act on, resolved once per request:
 *
 * - `activeWorkspaceId` — the room they are working in. Their library, their
 *   home counts, and their next upload all belong to this one.
 * - `workspaceIds` — every room they belong to. Opening something by its id
 *   works from any of them, so a link a teammate sends is never a dead end
 *   just because the recipient is looking at a different workspace.
 */
export async function getWorkspaceContext(
  userId: string,
): Promise<{ activeWorkspaceId: string | null; workspaceIds: string[] }> {
  const rows = await queryRows<{ workspace_id: string; is_active: boolean }>(
    `SELECT m.workspace_id, (a.workspace_id = m.workspace_id) AS is_active
       FROM workspace_members m
       LEFT JOIN workspace_active a ON a.user_id = m.user_id
      WHERE m.user_id = $1`,
    [userId],
  );
  const workspaceIds = rows.map((row) => row.workspace_id);
  const active = rows.find((row) => row.is_active)?.workspace_id ?? workspaceIds[0] ?? null;
  return { activeWorkspaceId: active, workspaceIds };
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
     ON CONFLICT (workspace_id, user_id) DO NOTHING
     RETURNING user_id`,
    [workspace.id, input.ownerUserId, input.email],
  );
  // Their own room is where they start; joining another switches them.
  await queryOne(
    `INSERT INTO workspace_active (user_id, workspace_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO NOTHING
     RETURNING user_id`,
    [input.ownerUserId, workspace.id],
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

    // Joining adds a room; it never takes one away. Someone already in this
    // workspace simply keeps the membership they have (DO UPDATE rather than
    // DO NOTHING so the write always affects a row and the guard below can
    // tell a real failure from a harmless repeat).
    const joined = await client.query<{ user_id: string }>(
      `INSERT INTO workspace_members (workspace_id, user_id, role, email)
       VALUES ($1, $2, 'member', $3)
       ON CONFLICT (workspace_id, user_id) DO UPDATE
          SET email = COALESCE(workspace_members.email, EXCLUDED.email)
       RETURNING user_id`,
      [invite.workspace_id, userId, fallbackEmail ?? invite.email],
    );
    if (joined.rowCount === 0) {
      // Nothing joined, so nothing may be spent either.
      throw new Error('workspace membership write affected no row');
    }

    // Land them in the room they just accepted — that is what they clicked.
    await client.query(
      `INSERT INTO workspace_active (user_id, workspace_id)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET workspace_id = EXCLUDED.workspace_id, updated_at = now()`,
      [userId, invite.workspace_id],
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
