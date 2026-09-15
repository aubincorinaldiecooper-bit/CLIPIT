import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import { search } from '../../services/discovery/searxng.js';
import { requireSession } from '../auth.js';
import { enforceRateLimits, HOUR } from '../rateLimit.js';
import { parse } from '../validation.js';

const searchSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
});

/**
 * Search the internet for something worth watching.
 *
 * Whatever the user typed is what is searched, passed through verbatim: there
 * are no predetermined categories here.
 *
 * The reply answers in one step. It returns pages, not files — the browser
 * runtime opens them and Gander watches the result — so nothing is downloaded
 * or resolved to a media URL on the way out.
 */
export async function registerInternetSearchRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/internet-search', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      {
        scope: 'search',
        perSession: env.RATE_LIMIT_SEARCH_PER_SESSION_HOURLY,
        perIp: env.RATE_LIMIT_SEARCH_PER_IP_HOURLY,
        windowSeconds: HOUR,
      },
    ]);

    const { query } = parse(searchSchema, request.body ?? {});

    try {
      const candidates = await search(query);
      return reply.send({ query, candidates });
    } catch (error) {
      // A provider that refused, timed out or is unconfigured has told us
      // nothing about what is out there. Returning an empty list here would
      // say "the internet has nothing on this", which is a different answer
      // from "we could not look" — so say which one it is.
      const message = error instanceof Error ? error.message : String(error);
      request.log.warn({ err: error, query }, 'internet search provider failed');
      throw HttpError.serviceUnavailable(`Could not search the internet right now: ${message}`);
    }
  });
}
