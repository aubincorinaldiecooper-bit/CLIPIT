import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import { getClip } from '../../db/repositories/clips.js';
import { assertOwnership, requireSession } from '../auth.js';
import { enforceRateLimits, MINUTE } from '../rateLimit.js';
import { serializeClip } from '../serializers.js';
import { parse } from '../validation.js';

export async function registerClipRoutes(app: FastifyInstance): Promise<void> {
  /** A single clip, with a freshly signed playback URL once it is ready. */
  app.get('/api/clips/:clipId', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const { clipId } = parse(
      z.object({ clipId: z.string().uuid('must be a UUID') }),
      request.params,
      'path parameters',
    );

    const clip = await getClip(clipId);
    if (!clip) throw HttpError.notFound('Clip not found');
    assertOwnership(request, clip, 'Clip');

    return reply.send({ clip: await serializeClip(clip) });
  });
}
