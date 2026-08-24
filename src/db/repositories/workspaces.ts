import { createHash, randomBytes } from 'node:crypto';
import { queryOne, queryRows, withTransaction } from '../pool.js';

/**
 * Workspaces (migrations 017-019).
 *
 * Two kinds, one table. A PERSONAL workspace is the private library a person
 * gets on first sign-in — one each, and nothing can move their work out of
 * it. A SHARED workspace is a room with people in it, holding clips that have
 * been sent there. You navigate to a shared room; you are never silently
 * "inside" one.
 *
 * Everything here belongs to a signed-in user, never a guest session.
 */

export interface WorkspaceRow {
  id: string;
  name: string;
  owner_user_id: string;
  /** True for the one room each person gets on first sign-in: their library. */
  is_personal: boolean;
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
 * A person's own room: where their uploads land and their library lives.
 *
 * There is no "currently in" state any more. Yours is yours, always, and a
 * workspace is somewhere you navigate to rather than something you are
 * inside — which is what makes every screen predictable.
 */
export async function getOwnWorkspace(userId: string): Promise<WorkspaceRow | null> {
  return queryOne<WorkspaceRow>(
    `SELECT id, name, owner_user_id, is_personal, created_at FROM workspaces WHERE owner_user_id = $1 AND is_personal`,
    [userId],
  );
}

/**
 * Every workspace this person belongs to, their own FIRST — the traditional
 * shape, by the owner's call: your first workspace is where all your clips
 * live, and the ones after it are the rooms you share with people.
 *
 * Counts are honest about what each page will show: the personal workspace
 * counts the library's playable clips; a shared room counts what has been
 * sent to it.
 */
export async function listWorkspacesForUser(userId: string): Promise<
  Array<
    WorkspaceRow & {
      role: string;
      is_personal: boolean;
      member_count: number;
      clip_count: number;
      owner_email: string | null;
    }
  >
> {
  return queryRows<
    WorkspaceRow & {
      role: string;
      is_personal: boolean;
      member_count: number;
      clip_count: number;
      owner_email: string | null;
    }
  >(
    // A room belongs to somebody, and which somebody is the thing that tells
    // one apart from another in a list. The owner's address lives on the
    // membership row rather than the workspace, so it is joined in here.
    `SELECT w.id, w.name, w.owner_user_id, w.created_at, m.role, w.is_personal,
            (SELECT o.email FROM workspace_members o
              WHERE o.workspace_id = w.id AND o.user_id = w.owner_user_id
              LIMIT 1) AS owner_email,
            (SELECT count(*)::int FROM workspace_members x WHERE x.workspace_id = w.id) AS member_count,
            CASE WHEN w.is_personal THEN
              (SELECT count(*)::int FROM clips c
                WHERE c.workspace_id = w.id AND c.status = 'ready' AND c.storage_key IS NOT NULL)
            ELSE
              (SELECT count(*)::int FROM workspace_clips c WHERE c.workspace_id = w.id)
            END AS clip_count
       FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1
      ORDER BY w.is_personal DESC, m.joined_at ASC`,
    [userId],
  );
}

/** Rooms a clip can be sent to: every shared room the caller is in. */
export async function listShareTargets(
  userId: string,
): Promise<Array<{ id: string; name: string }>> {
  return queryRows<{ id: string; name: string }>(
    `SELECT w.id, w.name
       FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1 AND NOT w.is_personal
      ORDER BY w.name ASC`,
    [userId],
  );
}

export async function getWorkspaceById(workspaceId: string): Promise<WorkspaceRow | null> {
  return queryOne<WorkspaceRow>(
    'SELECT id, name, owner_user_id, is_personal, created_at FROM workspaces WHERE id = $1',
    [workspaceId],
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

/**
 * Leave a shared room. An owner cannot leave their own — it is their room,
 * and one with no owner has nobody who can invite or remove anyone. Nothing
 * else moves: their library was never in the room to begin with, and clips
 * they sent stay where they sent them.
 */
export async function leaveWorkspace(userId: string, workspaceId: string): Promise<boolean> {
  const left = await queryOne<{ user_id: string }>(
    `DELETE FROM workspace_members
      WHERE user_id = $1 AND workspace_id = $2 AND role <> 'owner'
      RETURNING user_id`,
    [userId, workspaceId],
  );
  return left !== null;
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
 * - `ownWorkspaceId` — their personal room. Their library, their home counts,
 *   and their next upload all belong to it, and nothing can move them.
 * - `workspaceIds` — every room they belong to, personal and shared. Opening
 *   something by its id works from any of them, so a link a teammate sends is
 *   never a dead end.
 */
export async function getWorkspaceContext(
  userId: string,
): Promise<{ ownWorkspaceId: string | null; workspaceIds: string[] }> {
  const rows = await queryRows<{ workspace_id: string; is_own: boolean }>(
    `SELECT m.workspace_id, (w.is_personal AND w.owner_user_id = $1) AS is_own
       FROM workspace_members m
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1`,
    [userId],
  );
  return {
    ownWorkspaceId: rows.find((row) => row.is_own)?.workspace_id ?? null,
    workspaceIds: rows.map((row) => row.workspace_id),
  };
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
    `INSERT INTO workspaces (name, owner_user_id, is_personal)
     VALUES ($1, $2, true)
     ON CONFLICT (owner_user_id) WHERE is_personal
       DO UPDATE SET owner_user_id = workspaces.owner_user_id
     RETURNING id, name, owner_user_id, is_personal, created_at`,
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
  return workspace;
}

/**
 * A new shared room, owned by its creator. Distinct from insertWorkspace,
 * which makes the one personal room a person gets on first sign-in: there is
 * exactly one of those (the owner index enforces it) and any number of these.
 */
export async function createSharedWorkspace(input: {
  name: string;
  ownerUserId: string;
  email: string | null;
}): Promise<WorkspaceRow> {
  return withTransaction(async (client) => {
    const created = await client.query<WorkspaceRow>(
      `INSERT INTO workspaces (name, owner_user_id, is_personal) VALUES ($1, $2, false)
       RETURNING id, name, owner_user_id, is_personal, created_at`,
      [input.name, input.ownerUserId],
    );
    const workspace = created.rows[0]!;
    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role, email)
       VALUES ($1, $2, 'owner', $3)`,
      [workspace.id, input.ownerUserId, input.email],
    );
    return workspace;
  });
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
