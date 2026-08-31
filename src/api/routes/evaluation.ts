import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import { evaluationReport } from '../../services/evaluation.js';
import { verticalRenderMetrics } from '../../db/repositories/verticalRenders.js';
import { requireSession } from '../auth.js';
import { enforceRateLimits, MINUTE } from '../rateLimit.js';
import { parse } from '../validation.js';

/**
 * The owner's reading of the evaluation layer: quality, timestamp accuracy,
 * performance and cost, segmentable by provider, model, prompt version, date
 * and video length.
 *
 * Gated by sign-in address against EVAL_OWNER_EMAILS. With the variable
 * unset, or for anyone not on it, the route answers 404 — the numbers are
 * the owner's reading of the whole product, and a locked door that admits
 * it exists still says where the safe is.
 */

const querySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  provider: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  promptVersion: z.string().trim().min(1).max(64).optional(),
  durationBucket: z.enum(['under_5m', '5m_to_20m', '20m_to_60m', 'over_60m']).optional(),
  /** Usage lane: first-pass analysis or Re-clip re-evaluation. */
  stage: z.enum(['initial', 'reclip']).optional(),
});

const verticalQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(7),
});

function ownerEmails(): string[] {
  return (env.EVAL_OWNER_EMAILS ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0);
}

export async function registerEvaluationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/evaluation', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const owners = ownerEmails();
    const email = request.principal?.email?.trim().toLowerCase() ?? null;
    if (owners.length === 0 || !email || !owners.includes(email)) {
      throw HttpError.notFound('Not found');
    }

    const filters = parse(querySchema, request.query ?? {}, 'query parameters');
    if (filters.from && filters.to && filters.to <= filters.from) {
      throw HttpError.badRequest('`to` must be after `from`.');
    }

    return reply.send(await evaluationReport(filters));
  });

  /**
   * What the post-ready pipeline is actually doing — including everything
   * creators never see.
   *
   * The product rule is that a moment whose render failed simply is not in
   * the deck: no error card, no retry button, no landscape substitute. That
   * is right for the creator and dangerous for us, because a pipeline
   * silently dropping a third of its candidates looks, from outside, exactly
   * like a video that only had two good moments in it. This route is the
   * inside view, and it is the only place that distinction is visible.
   *
   * Same locked door as the evaluation report above.
   */
  app.get('/api/evaluation/vertical', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const owners = ownerEmails();
    const email = request.principal?.email?.trim().toLowerCase() ?? null;
    if (owners.length === 0 || !email || !owners.includes(email)) {
      throw HttpError.notFound('Not found');
    }

    const { days } = parse(verticalQuerySchema, request.query ?? {}, 'query parameters');
    return reply.send(await verticalRenderMetrics(days));
  });
}
