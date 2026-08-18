import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { query } from '../../db/pool.js';
import { getRedis } from '../../queues/connection.js';

/**
 * Liveness plus dependency checks. Railway hits this for health checks, so it
 * stays cheap and never touches external paid services.
 */
export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async (_request, reply) => {
    const checks: Record<string, { ok: boolean; error?: string }> = {};

    try {
      await query('SELECT 1');
      checks.database = { ok: true };
    } catch (error) {
      checks.database = { ok: false, error: (error as Error).message };
    }

    try {
      await getRedis().ping();
      checks.redis = { ok: true };
    } catch (error) {
      checks.redis = { ok: false, error: (error as Error).message };
    }

    const ok = Object.values(checks).every((check) => check.ok);

    return reply.code(ok ? 200 : 503).send({
      status: ok ? 'ok' : 'degraded',
      checks,
      config: {
        maxSourceDurationSeconds: env.MAX_SOURCE_DURATION_SECONDS,
        analysisChunkSeconds: env.ANALYSIS_CHUNK_SECONDS,
        transcriptionEnabled: env.TRANSCRIPTION_ENABLED,
        model: env.OPENROUTER_VIDEO_MODEL,
      },
      time: new Date().toISOString(),
    });
  });
}
