import type { FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { HttpError } from '../lib/errors.js';
import { getRedis } from '../queues/connection.js';
import { logger } from '../lib/logger.js';

/**
 * Fixed-window rate limiting backed by Redis, applied per session and per IP.
 *
 * Both dimensions matter: per-session stops one client from burning the
 * Video-model and STT budget, per-IP stops someone from minting unlimited anonymous
 * sessions to get around it.
 */

export interface RateLimitRule {
  /** Bucket name, e.g. "videos" or "search". */
  scope: string;
  perSession?: number;
  perIp?: number;
  windowSeconds: number;
}

interface ConsumeResult {
  allowed: boolean;
  count: number;
  limit: number;
  resetSeconds: number;
}

async function consume(key: string, limit: number, windowSeconds: number): Promise<ConsumeResult> {
  const redis = getRedis();
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const redisKey = `ratelimit:${key}:${bucket}`;

  const [count, ttl] = await redis
    .multi()
    .incr(redisKey)
    .expire(redisKey, windowSeconds, 'NX')
    .ttl(redisKey)
    .exec()
    .then((replies) => {
      const incr = Number(replies?.[0]?.[1] ?? 0);
      const remainingTtl = Number(replies?.[2]?.[1] ?? windowSeconds);
      return [incr, remainingTtl > 0 ? remainingTtl : windowSeconds] as const;
    });

  return { allowed: count <= limit, count, limit, resetSeconds: ttl };
}

export function clientIp(request: FastifyRequest): string {
  return request.ip || 'unknown';
}

/**
 * Applies every rule, or throws 429 with a Retry-After hint. A Redis failure is
 * logged and allowed through: rate limiting must not take the API down.
 */
export async function enforceRateLimits(request: FastifyRequest, rules: RateLimitRule[]): Promise<void> {
  if (!env.RATE_LIMIT_ENABLED) return;

  const sessionId = request.principal?.sessionId;
  const ip = clientIp(request);

  for (const rule of rules) {
    const checks: Array<Promise<ConsumeResult>> = [];

    if (rule.perSession !== undefined && sessionId) {
      checks.push(consume(`${rule.scope}:session:${sessionId}`, rule.perSession, rule.windowSeconds));
    }
    if (rule.perIp !== undefined) {
      checks.push(consume(`${rule.scope}:ip:${ip}`, rule.perIp, rule.windowSeconds));
    }

    let results: ConsumeResult[];
    try {
      results = await Promise.all(checks);
    } catch (error) {
      logger.warn('rate limit check failed, allowing request', { scope: rule.scope, err: error });
      continue;
    }

    const exceeded = results.find((result) => !result.allowed);
    if (exceeded) {
      throw new HttpError(
        429,
        'rate_limited',
        `Too many ${rule.scope} requests. Try again in ${exceeded.resetSeconds}s.`,
        { scope: rule.scope, limit: exceeded.limit, retryAfterSeconds: exceeded.resetSeconds },
      );
    }
  }
}

export const HOUR = 3600;
export const MINUTE = 60;
