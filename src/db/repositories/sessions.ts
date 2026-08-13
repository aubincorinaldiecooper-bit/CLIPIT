import { createHash, randomBytes } from 'node:crypto';
import { queryOne } from '../pool.js';
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

export async function createSession(context: { ip?: string; userAgent?: string; label?: string }): Promise<CreatedSession> {
  const token = generateToken();
  const row = await queryOne<SessionRow>(
    `INSERT INTO sessions (token_hash, created_ip, user_agent, label, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)
     RETURNING *`,
    [hashToken(token), context.ip ?? null, context.userAgent ?? null, context.label ?? null, String(env.SESSION_TTL_SECONDS)],
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
