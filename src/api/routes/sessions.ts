import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import { adoptSessionWork, createSession, findSessionByToken } from '../../db/repositories/sessions.js';
import { logger } from '../../lib/logger.js';
import { ensureWorkspace } from '../../services/workspace/membership.js';
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

    // Take over what this browser made while signed out. Everything here is
    // best-effort: a session that cannot be carried is a smaller problem than
    // a sign-in that fails, and the person is signed in either way.
    let adopted: { videos: number; clipRequests: number; clips: number } | null = null;
    if (body.guestToken) {
      try {
        const guest = await findSessionByToken(body.guestToken);
        // Only a real GUEST session. One that already belongs to somebody is
        // never harvested, however the token got here — that would be one
        // account taking another's work.
        if (guest && !guest.userId) {
          const workspace = await ensureWorkspace(body.userId, body.email ?? null);
          adopted = await adoptSessionWork({
            sessionId: guest.id,
            userId: body.userId,
            workspaceId: workspace.id,
          });
          logger.info('adopted guest work on sign-in', adopted);
        }
      } catch (cause) {
        logger.error('could not adopt guest work on sign-in', {
          name: cause instanceof Error ? cause.name : 'unknown',
        });
      }
    }

    return reply.code(201).send({
      token,
      tokenType: 'Bearer',
      sessionId: session.id,
      userId: body.userId,
      expiresAt: session.expiresAt.toISOString(),
      ...(adopted ? { adopted } : {}),
    });
  });

  app.get('/api/sessions/current', async (request, reply) => {
    if (!request.principal) {
      return reply.code(401).send({ error: { code: 'unauthenticated', message: 'No valid session token' } });
    }
    return reply.send({ sessionId: request.principal.sessionId, userId: request.principal.userId });
  });
}
