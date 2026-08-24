import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { env } from '../config/env.js';
import { ExternalServiceError, HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { attachPrincipal } from './auth.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerVideoRoutes } from './routes/videos.js';
import { registerClipRequestRoutes } from './routes/clipRequests.js';
import { registerClipRoutes } from './routes/clips.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerSocialRoutes } from './routes/social.js';
import { registerZernioWebhookRoutes } from './routes/zernioWebhook.js';
import { registerWorkspaceRoutes } from './routes/workspace.js';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    trustProxy: env.TRUST_PROXY,
    // Requests carry JSON metadata only — media goes straight to storage.
    bodyLimit: 1024 * 1024,
  });

  await app.register(cors, {
    origin: env.API_CORS_ORIGIN === '*' ? true : env.API_CORS_ORIGIN.split(',').map((value) => value.trim()),
    credentials: true,
  });

  app.addHook('onRequest', attachPrincipal);

  app.addHook('onResponse', async (request, reply) => {
    // One structured line per request; media routes are not chatty.
    logger.debug('request', {
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
      sessionId: request.principal?.sessionId,
    });
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, details: error.details ?? undefined },
      });
    }

    // A dependency being unreachable is not a bug in the request. Say which
    // one failed — a misconfigured bucket otherwise reads as a generic 500.
    if (error instanceof ExternalServiceError) {
      logger.error('external service unavailable', {
        method: request.method,
        url: request.url,
        service: error.service,
        err: error,
      });
      return reply.code(502).send({
        error: {
          code: 'upstream_unavailable',
          message: `The ${error.service} service is currently unavailable`,
        },
      });
    }

    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;

    if (statusCode >= 500) {
      logger.error('unhandled request error', { method: request.method, url: request.url, err: error });
      return reply.code(500).send({
        error: { code: 'internal_error', message: 'Something went wrong handling this request' },
      });
    }

    return reply.code(statusCode).send({
      error: { code: error.code ?? 'request_error', message: error.message },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: 'not_found', message: `No route for ${request.method} ${request.url}` },
    }),
  );

  await registerHealthRoutes(app);
  await registerSessionRoutes(app);
  await registerVideoRoutes(app);
  await registerClipRequestRoutes(app);
  await registerClipRoutes(app);
  await registerStatsRoutes(app);
  await registerSocialRoutes(app);
  await registerZernioWebhookRoutes(app);
  await registerWorkspaceRoutes(app);

  return app;
}
