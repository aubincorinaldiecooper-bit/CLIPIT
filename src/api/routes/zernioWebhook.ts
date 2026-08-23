import type { FastifyInstance } from 'fastify';
import { env, isProduction } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import {
  setSocialAccountStatus,
  updatePublishedPostStatusByZernioId,
} from '../../db/repositories/social.js';
import { mapZernioWebhook, verifyWebhookSignature } from '../../services/zernio/webhook.js';

/**
 * Zernio webhook intake, publishing subset only: post status updates land on
 * published_posts, account health changes land on social_accounts. The
 * security shape is populr's, ported intact:
 *
 * - The X-Zernio-Signature header (HMAC-SHA256 of the raw body, keyed with
 *   the secret configured on the Zernio webhook) is verified before any
 *   parsing. In production a missing ZERNIO_WEBHOOK_SECRET fails closed
 *   (503) — an unsigned production endpoint would let anyone who finds the
 *   URL rewrite post statuses and flip account health. Outside production,
 *   verification is skipped so the integration can be wired before a secret
 *   exists.
 * - Processing failures are ACKed (200) with a stable reason code so Zernio
 *   doesn't retry-storm an error it can't fix by resending. Payloads are
 *   never echoed back and never logged wholesale — Zernio bodies can carry
 *   tokens; logs get names and counts only.
 */
export async function registerZernioWebhookRoutes(app: FastifyInstance): Promise<void> {
  // An encapsulated scope: the raw-buffer JSON parser applies to this route
  // alone, leaving every other route's parsed-JSON behavior untouched. The
  // signature is an HMAC of the exact bytes sent, so the body must reach the
  // handler unparsed.
  await app.register(async (scope) => {
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });

    scope.post('/api/webhooks/zernio', async (request, reply) => {
      const secret = env.ZERNIO_WEBHOOK_SECRET;
      if (!secret) {
        if (isProduction) {
          logger.error('zernio webhook rejected: ZERNIO_WEBHOOK_SECRET is not configured in production');
          return reply.code(503).send({ error: 'webhook_not_configured' });
        }
      } else {
        const rawBody = Buffer.isBuffer(request.body) ? request.body : Buffer.from('');
        if (!verifyWebhookSignature(rawBody, request.headers['x-zernio-signature'], secret)) {
          return reply.code(401).send({ error: 'invalid_signature' });
        }
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse((request.body as Buffer).toString('utf8'));
      } catch {
        return reply.send({ received: true, handled: false, reason: 'invalid_json' });
      }

      const event = mapZernioWebhook(parsed);
      try {
        if (event.kind === 'post_status') {
          const updated = await updatePublishedPostStatusByZernioId(event.zernioPostId, event.status);
          if (updated === 0) {
            logger.warn('zernio webhook for unknown post', { status: event.status });
            return reply.send({ received: true, handled: false, reason: 'unknown_post' });
          }
          logger.info('published post status updated by webhook', { status: event.status, updated });
          return reply.send({ received: true, handled: true });
        }
        if (event.kind === 'account_status') {
          const row = await setSocialAccountStatus(event.accountId, event.status);
          if (!row) {
            logger.warn('zernio webhook for unknown account');
            return reply.send({ received: true, handled: false, reason: 'unknown_account' });
          }
          logger.info('social account status updated by webhook', { status: event.status });
          return reply.send({ received: true, handled: true });
        }
        return reply.send({ received: true, handled: false, reason: event.reason });
      } catch (cause) {
        logger.error('zernio webhook processing failed', {
          error: cause instanceof Error ? cause.name : 'unknown',
        });
        return reply.send({ received: true, handled: false, reason: 'processing_error' });
      }
    });
  });
}
