import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import { discoverInternetVideos } from '../../services/webSearch/discover.js';
import { getWebVideoSearchConfig, requireBraveSearchApiKey } from '../../services/webSearch/config.js';
import { requireSession } from '../auth.js';
import { enforceRateLimits, HOUR } from '../rateLimit.js';
import { parse } from '../validation.js';

const discoverySchema = z.object({
  question: z.string().trim().min(3).max(2_000),
  freshness: z.enum(['day', 'week', 'month', 'year']).optional(),
  country: z.string().trim().min(2).max(3).optional(),
  language: z.string().trim().min(2).max(10).optional(),
  safeSearch: z.enum(['off', 'moderate', 'strict']).optional(),
});

/**
 * Searches for candidate footage on the public web. It does NOT claim any
 * result has been watched: acquisition and Clipit verification are a later
 * boundary and every returned candidate says so explicitly.
 */
export async function registerWebVideoSearchRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/web-video-search', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      {
        scope: 'search',
        perSession: env.RATE_LIMIT_SEARCH_PER_SESSION_HOURLY,
        perIp: env.RATE_LIMIT_SEARCH_PER_IP_HOURLY,
        windowSeconds: HOUR,
      },
    ]);

    const body = parse(discoverySchema, request.body);
    try {
      requireBraveSearchApiKey(getWebVideoSearchConfig());
    } catch {
      throw HttpError.serviceUnavailable('Internet video search is not configured yet.');
    }

    const result = await discoverInternetVideos({
      question: body.question,
      freshness: body.freshness,
      country: body.country,
      language: body.language,
      safeSearch: body.safeSearch,
    });

    return reply.send(result);
  });
}
