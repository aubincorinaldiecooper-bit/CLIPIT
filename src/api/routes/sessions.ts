import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import { createSession } from '../../db/repositories/sessions.js';
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

    return reply.code(201).send({
      token,
      tokenType: 'Bearer',
      sessionId: session.id,
      userId: body.userId,
      expiresAt: session.expiresAt.toISOString(),
    });
  });

  app.get('/api/sessions/current', async (request, reply) => {
    if (!request.principal) {
      return reply.code(401).send({ error: { code: 'unauthenticated', message: 'No valid session token' } });
    }
    return reply.send({ sessionId: request.principal.sessionId, userId: request.principal.userId });
  });
}
