import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { summariseActivity } from '../../db/repositories/activity.js';
import { requireSession } from '../auth.js';
import { enforceRateLimits, MINUTE } from '../rateLimit.js';

/** The caller's own activity, for the home screen. Counted, never estimated. */
export async function registerStatsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/stats', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const stats = await summariseActivity({
      sessionId: request.principal?.sessionId ?? null,
      userId: request.principal?.userId ?? null,
    });

    return reply.send({ stats });
  });
}
