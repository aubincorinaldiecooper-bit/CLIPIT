import { queryOne } from '../pool.js';
import { generateToken, hashToken } from './sessions.js';

/**
 * A hand-over outlives the magic link it travels in (Better Auth's links
 * last minutes) and never approaches a session's own life: long enough for
 * an email to be opened, short enough that a stale link in an inbox stops
 * being a claim on anything.
 */
export const HANDOFF_TTL_SECONDS = 60 * 60;

export interface Handoff {
  /** The raw token, returned exactly once; only its digest is stored. */
  token: string;
  expiresAt: Date;
}

/**
 * Packs a guest session's claim on its work into a token that can travel in
 * a sign-in link. See migration 040 for why one is needed at all.
 */
export async function createHandoff(sessionId: string): Promise<Handoff> {
  const token = generateToken();
  const row = await queryOne<{ expires_at: Date }>(
    `INSERT INTO session_handoffs (token_hash, session_id, expires_at)
     VALUES ($1, $2, now() + ($3 || ' seconds')::interval)
     RETURNING expires_at`,
    [hashToken(token), sessionId, String(HANDOFF_TTL_SECONDS)],
  );
  return { token, expiresAt: row!.expires_at };
}

export interface RedeemedHandoff {
  sessionId: string;
  /** The named session's owner — null for a guest, which is the only kind worth adopting. */
  userId: string | null;
}

/**
 * Redeems a hand-over exactly once.
 *
 * The row is marked in the same statement that finds it, so two tabs racing
 * on the same link get one winner and one null — never two adoptions, and
 * never a token that stays live after use. Unknown, expired and already-used
 * tokens all come back as null; the caller cannot tell them apart, and does
 * not need to.
 */
export async function redeemHandoff(token: string): Promise<RedeemedHandoff | null> {
  const row = await queryOne<{ session_id: string; user_id: string | null }>(
    `UPDATE session_handoffs h
        SET redeemed_at = now()
       FROM sessions s
      WHERE h.token_hash = $1
        AND h.redeemed_at IS NULL
        AND h.expires_at > now()
        AND s.id = h.session_id
      RETURNING h.session_id, s.user_id`,
    [hashToken(token)],
  );
  return row ? { sessionId: row.session_id, userId: row.user_id } : null;
}
