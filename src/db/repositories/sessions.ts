import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { queryOne, queryRows } from '../pool.js';
import { env } from '../../config/env.js';
import type { Session } from '../../domain/types.js';

interface SessionRow {
  id: string;
  token_hash: string;
  user_id: string | null;
  label: string | null;
  expires_at: Date;
  created_at: Date;
}

function mapSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.user_id,
    label: row.label,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/**
 * Tokens are random 256-bit strings; only their SHA-256 digest is stored, so a
 * database leak does not hand out usable credentials.
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface CreatedSession {
  session: Session;
  token: string;
}

export async function createSession(context: {
  ip?: string;
  userAgent?: string;
  label?: string;
  /**
   * Set when the session belongs to a signed-in person. Identity lives in
   * Better Auth on the frontend service; this is the opaque id it issued,
   * recorded so everything the session creates belongs to the person rather
   * than to one browser tab.
   */
  userId?: string;
}): Promise<CreatedSession> {
  const token = generateToken();
  const row = await queryOne<SessionRow>(
    `INSERT INTO sessions (token_hash, user_id, created_ip, user_agent, label, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' seconds')::interval)
     RETURNING *`,
    [
      hashToken(token),
      context.userId ?? null,
      context.ip ?? null,
      context.userAgent ?? null,
      context.label ?? null,
      String(env.SESSION_TTL_SECONDS),
    ],
  );
  return { session: mapSession(row!), token };
}

/** Returns the session for a raw token, refreshing `last_seen_at`. */
export async function findSessionByToken(token: string): Promise<Session | null> {
  const row = await queryOne<SessionRow>(
    `UPDATE sessions
        SET last_seen_at = now()
      WHERE token_hash = $1 AND expires_at > now()
      RETURNING *`,
    [hashToken(token)],
  );
  return row ? mapSession(row) : null;
}

/**
 * Hand a guest session's work to the person who has just signed in.
 *
 * Someone can use CLIPIT signed out — upload a video, ask for a moment, cut a
 * clip. Publishing is where they are asked to sign in, and until now signing
 * in minted a NEW session and left everything they had just made behind,
 * still owned by the browser's guest session. Asking for an email address at
 * the exact moment you take away the work someone did to get there is the
 * worst possible trade.
 *
 * Three tables carry that ownership: videos, clip_requests, clips. Each is
 * stamped with the user AND their workspace, because a row with a user but a
 * null workspace is invisible to every workspace-scoped read — the same trap
 * populr recorded for connected accounts.
 *
 * Only rows with NO owner are taken. A row that already belongs to somebody
 * is never reassigned, whatever the session says.
 */
export async function adoptSessionWork(
  input: {
    sessionId: string;
    userId: string;
    workspaceId: string;
  },
  /**
   * The transaction this runs in, when it must move as one with the claim
   * that pays for it and the lock that orders it (adoptOnSignIn). Without
   * one, each table is its own statement, as before.
   */
  client?: Pick<PoolClient, 'query'>,
): Promise<{ videos: number; clipRequests: number; clips: number }> {
  const claim = async (table: 'videos' | 'clip_requests' | 'clips'): Promise<number> => {
    const sql = `UPDATE ${table}
          SET user_id = $2, workspace_id = $3
        WHERE session_id = $1 AND user_id IS NULL
        RETURNING id`;
    const params = [input.sessionId, input.userId, input.workspaceId];
    const rows = client ? (await client.query<{ id: string }>(sql, params)).rows : await queryRows<{ id: string }>(sql, params);
    return rows.length;
  };

  // Videos first, then the things that hang off them: if this is interrupted
  // part-way, work that is visible is work whose source is also visible.
  const videos = await claim('videos');
  const clipRequests = await claim('clip_requests');
  const clips = await claim('clips');
  return { videos, clipRequests, clips };
}

/**
 * Takes the guest session's row for the rest of the caller's transaction.
 *
 * Two sign-ins can adopt the same guest at once — the tab that still holds
 * the token and the phone that opened the link, or two links sent in a row.
 * Each adoption is three tables' worth of updates, and run side by side they
 * could split one guest's work between two accounts: the video to one, its
 * questions and clips to the other (Devin and Codex, #87). Locking the row
 * first queues the second behind the first; by the time it moves, the rows
 * are owned and it takes nothing, which is the right answer.
 *
 * Null when the session is gone. The owner comes back so a session that
 * already belongs to somebody is never adopted, however it was named.
 */
export async function lockSessionForAdoption(
  sessionId: string,
  client: Pick<PoolClient, 'query'>,
): Promise<{ userId: string | null } | null> {
  const result = await client.query<{ user_id: string | null }>(
    `SELECT user_id FROM sessions WHERE id = $1 FOR UPDATE`,
    [sessionId],
  );
  const row = result.rows[0];
  return row ? { userId: row.user_id } : null;
}
