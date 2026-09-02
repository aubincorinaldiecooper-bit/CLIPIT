import { adoptSessionWork, findSessionByToken } from '../../db/repositories/sessions.js';
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
 *   where no guest token exists.
 *
 * Both name a session. Each is honoured once, an owned session is never
 * taken whichever way it was named, and the same session named twice is
 * adopted once. Everything here is best-effort: a claim that cannot be
 * honoured is a smaller problem than a sign-in that fails, and the person
 * is signed in either way. Null means nothing was adopted, for whichever
 * reason — the caller has no use for the difference.
 */
export async function adoptOnSignIn(input: {
  userId: string;
  email: string | null;
  guestToken?: string | undefined;
  handoff?: string | undefined;
}): Promise<Adopted | null> {
  try {
    const guests = new Map<string, Claim>();
    if (input.guestToken) {
      const guest = await findSessionByToken(input.guestToken);
      // Only a real GUEST session. One that already belongs to somebody is
      // never harvested, however the token got here — that would be one
      // account taking another's work.
      if (guest && !guest.userId) guests.set(guest.id, 'token');
    }
    if (input.handoff) {
      // Redeemed whether or not it is then used: a hand-over is spent by the
      // sign-in it travelled with, never left live in an inbox.
      const named = await redeemHandoff(input.handoff);
      if (named && !named.userId && !guests.has(named.sessionId)) {
        guests.set(named.sessionId, 'handoff');
      }
    }
    if (guests.size === 0) return null;

    const workspace = await ensureWorkspace(input.userId, input.email);
    const total: Adopted = { videos: 0, clipRequests: 0, clips: 0 };
    for (const [sessionId, via] of guests) {
      const adopted = await adoptSessionWork({ sessionId, userId: input.userId, workspaceId: workspace.id });
      total.videos += adopted.videos;
      total.clipRequests += adopted.clipRequests;
      total.clips += adopted.clips;
      logger.info('adopted guest work on sign-in', { ...adopted, via });
    }
    return total;
  } catch (cause) {
    logger.error('could not adopt guest work on sign-in', {
      name: cause instanceof Error ? cause.name : 'unknown',
    });
    return null;
  }
}
