import type { PoolClient } from 'pg';
import { query, withTransaction } from '../pool.js';
import { generateToken, hashToken } from './sessions.js';

/**
 * A hand-over outlives the magic link it travels in (Better Auth's links
 * last minutes) and never approaches a session's own life: long enough for
 * an email to be opened, short enough that a stale link in an inbox stops
 * being a claim on anything.
 */
export const HANDOFF_TTL_SECONDS = 60 * 60;

/**
 * How many live claims one guest session may hold. Re-sending a link — a
 * mistyped address, a second try — must not kill the one just sent, so it
 * is not one; and it is not unbounded, or a guest could grow the table
 * without limit from behind changing addresses (Devin, #87). The newest
 * survive.
 */
export const LIVE_HANDOFFS_PER_SESSION = 5;

export interface Handoff {
  /** The raw token, returned exactly once; only its digest is stored. */
  token: string;
  expiresAt: Date;
}

/** Digest of an address, compared for equality only: case and edges do not count. */
export function hashEmail(email: string): string {
  return hashToken(email.trim().toLowerCase());
}

/**
 * Packs a guest session's claim on its work into a token that can travel in
 * a sign-in link — a link to ONE address, the only sign-in the claim will
 * answer. See migration 040 for why one is needed at all.
 */
export async function createHandoff(sessionId: string, email: string): Promise<Handoff> {
  const token = generateToken();

  // The sweep first, on an ordinary connection: claims past their hour go.
  // Outside the transaction below on purpose — a transaction that waits on
  // the pool for a side-query holds one connection while asking for another.
  await query(`DELETE FROM session_handoffs WHERE expires_at <= now()`);

  // Then, holding this guest's session row: keep only its newest few live
  // claims and add this one. A burst of requests for one session queues on
  // the lock, so each sees the rows the previous one left — not the same
  // allowance all at once, which would let every one of them through the
  // cap (Devin and Codex, #88).
  const expiresAt = await withTransaction(async (client) => {
    await client.query(`SELECT id FROM sessions WHERE id = $1 FOR UPDATE`, [sessionId]);
    await client.query(
      `DELETE FROM session_handoffs
        WHERE session_id = $1
          AND redeemed_at IS NULL
          AND id NOT IN (
            SELECT id FROM session_handoffs
             WHERE session_id = $1 AND redeemed_at IS NULL
             ORDER BY created_at DESC
             LIMIT $2
          )`,
      [sessionId, LIVE_HANDOFFS_PER_SESSION - 1],
    );
    const result = await client.query<{ expires_at: Date }>(
      `INSERT INTO session_handoffs (token_hash, email_hash, session_id, expires_at)
       VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)
       RETURNING expires_at`,
      [hashToken(token), hashEmail(email), sessionId, String(HANDOFF_TTL_SECONDS)],
    );
    return result.rows[0]!.expires_at;
  });
  return { token, expiresAt };
}

export interface RedeemedHandoff {
  sessionId: string;
  /** The named session's owner — null for a guest, which is the only kind worth adopting. */
  userId: string | null;
}

/**
 * Redeems a hand-over exactly once, for the address it was sent to.
 *
 * Runs on the caller's transaction: the mark is committed together with the
 * adoption it pays for, so a failure between the two rolls it back and the
 * claim stays usable for the retry (Devin, #87). The row is marked in the
 * same statement that finds it, so two tabs racing on one link get one
 * winner and one null. A link opened by a different address than the one
 * it was sent to leaves the row untouched: the claim answers one sign-in.
 * Unknown, expired and already-used tokens all come back as null; the
 * caller cannot tell them apart, and does not need to.
 */
export async function redeemHandoff(
  token: string,
  email: string,
  client: Pick<PoolClient, 'query'>,
): Promise<RedeemedHandoff | null> {
  const result = await client.query<{ session_id: string; user_id: string | null }>(
    `UPDATE session_handoffs h
        SET redeemed_at = now()
       FROM sessions s
      WHERE h.token_hash = $1
        AND h.email_hash = $2
        AND h.redeemed_at IS NULL
        AND h.expires_at > now()
        AND s.id = h.session_id
      RETURNING h.session_id, s.user_id`,
    [hashToken(token), hashEmail(email)],
  );
  const row = result.rows[0];
  return row ? { sessionId: row.session_id, userId: row.user_id } : null;
}
