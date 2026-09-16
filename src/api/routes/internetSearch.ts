import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import {
  enqueueInternetSearch,
  getInternetSearchQueue,
  type InternetSearchProgress,
} from '../../queues/internetSearch.js';
import { search } from '../../services/discovery/searxng.js';
import { requireSession } from '../auth.js';
import { enforceRateLimits, HOUR } from '../rateLimit.js';
import { parse } from '../validation.js';

const searchSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
});

const searchIdSchema = z.object({
  searchId: z.string().uuid(),
});

/** A search belongs to whoever started it, and nobody else can read it. */
function assertOwner(request: FastifyRequest, data: { sessionId: string | null; userId: string | null }): void {
  if (!data.sessionId && !data.userId) return;
  const principal = request.principal;
  if (!principal) throw HttpError.notFound('Search not found');
  if (data.userId && principal.userId === data.userId) return;
  if (data.sessionId && principal.sessionId === data.sessionId) return;
  throw HttpError.notFound('Search not found');
}

/** The first thing a search reports, before anything has been looked at. */
const STARTING: InternetSearchProgress = { phase: 'loading', moments: [], candidatesFound: 0 };

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
      // Fastify is built with `logger: false`, so request.log goes nowhere.
      logger.warn('internet search provider failed', { query, err: message });
      throw HttpError.serviceUnavailable(`Could not search the internet right now: ${message}`);
    }
  });

  /**
   * Start a search and hand back its address straight away.
   *
   * Watching pages takes minutes, and the point of the results screen is that
   * it fills as they are watched. So this answers immediately with an id, and
   * the moments arrive through the read below as the scouts find them.
   */
  app.post('/api/internet-searches', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      {
        scope: 'search',
        perSession: env.RATE_LIMIT_SEARCH_PER_SESSION_HOURLY,
        perIp: env.RATE_LIMIT_SEARCH_PER_IP_HOURLY,
        windowSeconds: HOUR,
      },
    ]);

    const { query } = parse(searchSchema, request.body ?? {});
    const searchId = randomUUID();
    await enqueueInternetSearch(searchId, {
      query,
      sessionId: request.principal?.sessionId ?? null,
      userId: request.principal?.userId ?? null,
    });
    return reply.code(202).send({ searchId, query, ...STARTING });
  });

  /**
   * How a search is doing, and what it has found so far.
   *
   * A search that has not reported anything yet is loading, not empty: the
   * screen must not say a search found nothing while it is still starting up.
   * A search that failed says so rather than answering with no moments, which
   * would claim the internet has nothing on this.
   */
  app.get('/api/internet-searches/:searchId', { preHandler: requireSession }, async (request, reply) => {
    const { searchId } = parse(searchIdSchema, request.params, 'path parameters');
    const job = await getInternetSearchQueue().getJob(searchId);
    if (!job) throw HttpError.notFound('Search not found');
    assertOwner(request, job.data);

    const state = await job.getState();
    if (state === 'failed') {
      throw HttpError.serviceUnavailable(job.failedReason || 'That search could not be finished.');
    }

    const reported = (job.progress ?? null) as InternetSearchProgress | null;
    const finished = (job.returnvalue ?? null) as InternetSearchProgress | null;
    return reply.send({ searchId, query: job.data.query, ...(finished ?? reported ?? STARTING) });
  });
}
