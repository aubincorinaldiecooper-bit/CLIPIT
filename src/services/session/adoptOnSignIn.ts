import { withTransaction } from '../../db/pool.js';
import { adoptSessionWork, findSessionByToken, lockSessionForAdoption } from '../../db/repositories/sessions.js';
import { redeemHandoff } from '../../db/repositories/sessionHandoffs.js';
import { logger } from '../../lib/logger.js';
import { ensureWorkspace } from '../workspace/membership.js';

export interface Adopted {
  videos: number;
  clipRequests: number;
  clips: number;
}

/** How a guest session came to be named by a sign-in. */
export type Claim = 'token' | 'handoff';

/**
 * Takes over what a person made while signed out, however their claim on it
 * arrived.
 *
 * Two claims exist and a sign-in may carry either, both, or neither:
 *
 * - the GUEST TOKEN, when the magic link opened in the very tab that did the
 *   work — the tab still holds it and sends it along;
 * - a HAND-OVER, packed into the link's return address before it was sent,
 *   for the far commoner case of the link opening in a new tab or on a phone
 *   where no guest token exists. It answers only the address the link went
 *   to, so a sign-in that carries no address cannot spend it.
 *
 * Everything that can be settled on an ordinary connection is settled
 * FIRST — the token looked up, the person's workspace in place — and only
 * then is a connection taken for the transaction. A transaction that waited
 * on the pool for its own side-queries would hold one connection while
 * asking for another: a pool of one deadlocks outright, a bigger one under
 * enough sign-ins at once (Devin and Codex, #88).
 *
 * Inside that transaction, on its one client: the hand-over redeemed, the
 * guest's session row locked, the work moved. So a failure anywhere rolls
 * the redemption back and the claim stays good for a retry; two sign-ins
 * adopting the same guest at once queue on the lock and the second takes
 * nothing, instead of each taking half; and the same session named twice
 * is adopted once. An owned session is never taken whichever way it was
 * named. Best-effort at the edge: a claim that cannot be honoured is a
 * smaller problem than a sign-in that fails, and the person is signed in
 * either way. Null means nothing was adopted, for whichever reason — the
 * caller has no use for the difference.
 */
export async function adoptOnSignIn(input: {
  userId: string;
  email: string | null;
  guestToken?: string | undefined;
  handoff?: string | undefined;
}): Promise<Adopted | null> {
  try {
    const claims = new Map<string, Claim>();
    if (input.guestToken) {
      const guest = await findSessionByToken(input.guestToken);
      if (guest && !guest.userId) claims.set(guest.id, 'token');
    }
    // A hand-over can only be judged inside the transaction that spends it,
    // so its presence is enough to go on.
    const handoff = input.handoff && input.email ? { token: input.handoff, email: input.email } : null;
    if (claims.size === 0 && !handoff) return null;

    const workspace = await ensureWorkspace(input.userId, input.email);

    return await withTransaction(async (client) => {
      if (handoff) {
        // Redeemed on this transaction, whether or not it is then needed:
        // spent by the sign-in it travelled with, never left live in an
        // inbox — and unspent again if that sign-in's adoption fails.
        const named = await redeemHandoff(handoff.token, handoff.email, client);
        if (named && !named.userId && !claims.has(named.sessionId)) {
          claims.set(named.sessionId, 'handoff');
        }
      }
      if (claims.size === 0) return null;

      const total: Adopted = { videos: 0, clipRequests: 0, clips: 0 };
      let adoptedAny = false;
      for (const [sessionId, via] of claims) {
        // Only a real GUEST session, and only one at a time. One that already
        // belongs to somebody is never harvested, however the claim got
        // here — that would be one account taking another's work.
        const locked = await lockSessionForAdoption(sessionId, client);
        if (!locked || locked.userId) continue;
        const adopted = await adoptSessionWork({ sessionId, userId: input.userId, workspaceId: workspace.id }, client);
        total.videos += adopted.videos;
        total.clipRequests += adopted.clipRequests;
        total.clips += adopted.clips;
        adoptedAny = true;
        logger.info('adopted guest work on sign-in', { ...adopted, via });
      }
      return adoptedAny ? total : null;
    });
  } catch (cause) {
    logger.error('could not adopt guest work on sign-in', {
      name: cause instanceof Error ? cause.name : 'unknown',
    });
    return null;
  }
}
