import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { createSession } from '../../db/repositories/sessions.js';
import { clientIp, enforceRateLimits, HOUR } from '../rateLimit.js';

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

  app.get('/api/sessions/current', async (request, reply) => {
    if (!request.principal) {
      return reply.code(401).send({ error: { code: 'unauthenticated', message: 'No valid session token' } });
    }
    return reply.send({ sessionId: request.principal.sessionId, userId: request.principal.userId });
  });
}
