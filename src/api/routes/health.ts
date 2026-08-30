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
        // Which service reads video, and the model that answers for it.
        videoProvider: env.VIDEO_PROVIDER,
        model: env.VIDEO_PROVIDER === 'minicpm' ? 'openbmb/MiniCPM-V-4.6' : env.OPENROUTER_VIDEO_MODEL,
        // Presence only — no probe. The Modal endpoint wakes a GPU when
        // called, and Railway polls this route; a health check that costs
        // GPU-seconds per poll would be a bill, not a check. Deeper probing
        // is a deliberate decision, not a default.
        ...(env.VIDEO_PROVIDER === 'minicpm'
          ? {
              minicpm: {
                endpointConfigured: Boolean(env.MINICPM_VIDEO_URL),
                proxyTokenConfigured: Boolean(env.MODAL_PROXY_TOKEN_ID && env.MODAL_PROXY_TOKEN_SECRET),
              },
            }
          : {}),
      },
      time: new Date().toISOString(),
    });
  });
}
