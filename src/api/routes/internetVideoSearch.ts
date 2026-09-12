import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HttpError } from '../../lib/errors.js';
import { enqueueInternetVideoSearch, getInternetVideoSearchQueue } from '../../queues/internetVideoSearch.js';
import { requireSession } from '../auth.js';
import { parse } from '../validation.js';

const createSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
});

const paramsSchema = z.object({
  searchId: z.string().uuid(),
});

function assertJobOwner(request: FastifyRequest, data: { sessionId: string | null; userId: string | null }): void {
  if (!data.sessionId && !data.userId) return;
  const principal = request.principal;
  if (!principal) throw HttpError.notFound('Internet video search not found');
  if (data.userId && principal.userId === data.userId) return;
  if (data.sessionId && principal.sessionId === data.sessionId) return;
  throw HttpError.notFound('Internet video search not found');
}

export async function registerInternetVideoSearchRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/internet-video-search', { preHandler: requireSession }, async (request, reply) => {
    const { query } = parse(createSchema, request.body ?? {});
    const searchId = randomUUID();
    await enqueueInternetVideoSearch(searchId, {
      query,
      sessionId: request.principal?.sessionId ?? null,
      userId: request.principal?.userId ?? null,
    });
    return reply.code(202).send({
      searchId,
      status: 'queued',
      progress: { stage: 'queued', message: 'Search queued' },
    });
  });

  app.get('/api/internet-video-search/:searchId', { preHandler: requireSession }, async (request, reply) => {
    const { searchId } = parse(paramsSchema, request.params, 'path parameters');
    const job = await getInternetVideoSearchQueue().getJob(searchId);
    if (!job) throw HttpError.notFound('Internet video search not found');
    assertJobOwner(request, job.data);

    const state = await job.getState();
    if (state === 'completed') {
      return reply.send({ searchId, status: 'completed', progress: job.progress, result: job.returnvalue });
    }
    if (state === 'failed') {
      return reply.send({
        searchId,
        status: 'failed',
        progress: job.progress,
        error: job.failedReason || 'Internet video search failed',
      });
    }
    return reply.send({
      searchId,
      status: state === 'active' ? 'running' : state,
      progress: job.progress,
    });
  });
}
