import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import { createSession } from '../../db/repositories/sessions.js';
import { createHandoff } from '../../db/repositories/sessionHandoffs.js';
import { adoptOnSignIn } from '../../services/session/adoptOnSignIn.js';
import { requireSession } from '../auth.js';
import { clientIp, enforceRateLimits, HOUR } from '../rateLimit.js';
import { parse } from '../validation.js';

/**
 * Compared as digests so length differences cannot leak through timing, and a
 * mistyped secret takes exactly as long to reject as a nearly-right one.
 */
function secretMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const exchangeSchema = z.object({
  /** Better Auth's opaque user id — text, not one of our UUIDs. */
  userId: z.string().trim().min(1).max(128),
  /** Shown in session listings; identifies whose session this is. */
  email: z.string().trim().email().max(320).optional(),
  /**
   * The GUEST token this browser was using, if it had one. Signing in then
   * takes over the work done under it — the video uploaded, the clips cut —
   * instead of leaving it stranded on a session nobody will return to.
   *
   * Optional by design: a first-time visitor who signs in before doing
   * anything has nothing to carry, and that is not an error.
   */
  guestToken: z.string().trim().min(1).max(512).optional(),
  /**
   * The HAND-OVER the sign-in link carried, if it did: the guest's claim on
   * its work for when the link opens somewhere the guest token is not — a
   * new tab, another device. Issued by POST /api/sessions/handoff, spent
   * here. Optional for the same reason the token is.
   */
  handoff: z.string().trim().min(1).max(512).optional(),
});

/**
 * Issues the anonymous session token the rest of the API expects. This is the
 * only unauthenticated /api route.
 */
export async function registerSessionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/sessions', async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'sessions', perIp: env.RATE_LIMIT_SESSION_CREATE_PER_IP_HOURLY, windowSeconds: HOUR },
    ]);

    const userAgent = request.headers['user-agent'];
    const { session, token } = await createSession({
      ip: clientIp(request),
      ...(typeof userAgent === 'string' ? { userAgent } : {}),
    });

    return reply.code(201).send({
      // The raw token is returned exactly once; only its hash is stored.
      token,
      tokenType: 'Bearer',
      sessionId: session.id,
      expiresAt: session.expiresAt.toISOString(),
      usage: 'Send this as the "Authorization: Bearer <token>" header on all /api requests.',
    });
  });

  /**
   * Turns "signed in on the site" into "recognised by this API".
   *
   * Sign-in itself happens in the frontend service (Better Auth), which holds
   * the only proof — an httpOnly cookie the browser will never send here,
   * because the two services live on different origins. So the frontend
   * SERVER verifies the cookie and calls this with a shared secret, and the
   * API mints a bearer token bound to the user. The browser never holds the
   * secret and never talks to this route directly.
   *
   * Everything a user-bound session creates is owned by the person, not the
   * tab — which is what makes "come back to your videos" possible at all.
   * What the person made BEFORE signing in comes along too, by the guest
   * token when the link opened in the same tab and by the hand-over the
   * link carried when it opened anywhere else (see adoptOnSignIn).
   */
  app.post('/api/sessions/exchange', async (request, reply) => {
    if (!env.AUTH_BRIDGE_SECRET) {
      throw new HttpError(503, 'auth_not_configured', 'Sign-in is not configured on this server.');
    }

    await enforceRateLimits(request, [
      { scope: 'sessions', perIp: env.RATE_LIMIT_SESSION_CREATE_PER_IP_HOURLY, windowSeconds: HOUR },
    ]);

    const presented = request.headers['x-auth-bridge-secret'];
    if (typeof presented !== 'string' || !secretMatches(presented, env.AUTH_BRIDGE_SECRET)) {
      // 404, not 401: an outsider probing for this route should not learn it
      // exists, let alone that it guards something.
      throw HttpError.notFound('Not found');
    }

    const body = parse(exchangeSchema, request.body ?? {});
    const userAgent = request.headers['user-agent'];
    const { session, token } = await createSession({
      ip: clientIp(request),
      userId: body.userId,
      ...(body.email ? { label: body.email } : {}),
      ...(typeof userAgent === 'string' ? { userAgent } : {}),
    });

    // Take over what this person made while signed out, by whichever claim
    // the sign-in carried: the guest token (same tab) or the hand-over the
    // link brought (any tab). Best-effort, inside: the person is signed in
    // either way.
    const adopted = await adoptOnSignIn({
      userId: body.userId,
      email: body.email ?? null,
      guestToken: body.guestToken,
      handoff: body.handoff,
    });

    return reply.code(201).send({
      token,
      tokenType: 'Bearer',
      sessionId: session.id,
      userId: body.userId,
      expiresAt: session.expiresAt.toISOString(),
      ...(adopted ? { adopted } : {}),
    });
  });

  /**
   * Packs this guest's claim on its work into a token that can travel in a
   * sign-in link.
   *
   * The guest token dies with its tab by design, and the magic link opens
   * wherever the email is read — usually a new tab, often a phone. Without
   * this, signing in from there minted an account session with nothing in
   * it, and the video the person had just uploaded stayed behind on a guest
   * session nobody would return to. The frontend asks for a hand-over
   * BEFORE sending the link and puts it in the link's return address; the
   * exchange above redeems it, once, wherever the link lands.
   *
   * A signed-in session has nothing to hand over — its work already belongs
   * to the person — and is told so with a null, not an error.
   */
  app.post('/api/sessions/handoff', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'sessions', perIp: env.RATE_LIMIT_SESSION_CREATE_PER_IP_HOURLY, windowSeconds: HOUR },
    ]);
    const principal = request.principal;
    if (!principal) {
      throw new HttpError(401, 'unauthenticated', 'A session token is required to hand its work over.');
    }
    if (principal.userId) {
      return reply.code(200).send({ handoff: null });
    }
    const { token, expiresAt } = await createHandoff(principal.sessionId);
    return reply.code(201).send({ handoff: token, expiresAt: expiresAt.toISOString() });
  });

  app.get('/api/sessions/current', async (request, reply) => {
    if (!request.principal) {
      return reply.code(401).send({ error: { code: 'unauthenticated', message: 'No valid session token' } });
    }
    return reply.send({ sessionId: request.principal.sessionId, userId: request.principal.userId });
  });
}
