import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { requireSession } from '../auth.js';
import { enforceRateLimits, MINUTE } from '../rateLimit.js';
import { parse } from '../validation.js';
import { getClip } from '../../db/repositories/clips.js';
import {
  consumeConnectionState,
  createConnectionState,
  getSocialAccount,
  insertPublishedPost,
  listSocialAccounts,
  setSocialAccountStatus,
  getSocialProfile,
} from '../../db/repositories/social.js';
import {
  PUBLISH_PLATFORMS,
  getOrCreateZernioProfile,
  isPublishPlatform,
  syncAccounts,
  verifyConnected,
} from '../../services/social/accounts.js';
import { zernio, ZernioApiError, zernioConfigured } from '../../services/zernio/client.js';
import { getStorage } from '../../services/storage/s3.js';

/**
 * Social publishing, the clip-first way: connect an account once (hosted
 * OAuth through Zernio), then publish clips to it and watch how they do.
 *
 * Two standing decisions live here:
 *
 * - Signed-in users only. A social account bound to a guest session would be
 *   stranded when the tab closed — the opposite of what connecting is for.
 *   Guests get a sentence, not a broken button.
 *
 * - The OAuth callback trusts only the single-use state token minted by the
 *   authenticated connect route (borrowed from populr). It is a raw browser
 *   redirect with no CLIPIT session on it; a missing, expired, or reused
 *   token fails the connect — it is never license to guess an owner.
 */

const CONNECT_STATE_TTL_SECONDS = 15 * 60;

function requireZernio(): void {
  if (!zernioConfigured()) {
    throw HttpError.serviceUnavailable('Publishing is not configured on this deployment');
  }
}

/** The signed-in user id, or the honest refusal for guests. */
function requireUserId(principal: { userId: string | null } | null): string {
  if (!principal?.userId) {
    throw HttpError.forbidden('Connecting social accounts needs an account — sign in first');
  }
  return principal.userId;
}

export async function registerSocialRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The OAuth return target. Registered before /:platform so "callback" is
   * never read as a platform name. Unauthenticated by nature — identity
   * comes only from consuming the state token.
   */
  app.get('/api/connect/callback', async (request, reply) => {
    const { state: stateToken } = parse(
      z.object({ state: z.string().trim().min(1).optional() }).passthrough(),
      request.query,
      'query parameters',
    );

    const to = new URL(env.FRONTEND_URL ? `${env.FRONTEND_URL.replace(/\/+$/, '')}/publishing` : 'about:blank');
    if (!env.FRONTEND_URL) {
      // A misconfigured deployment answers plainly instead of redirecting nowhere.
      return reply.code(503).send({ error: 'FRONTEND_URL is not set; cannot finish the connect flow' });
    }

    const state = stateToken ? await consumeConnectionState(stateToken) : null;
    if (!state) {
      logger.warn('social connect callback had no valid state token', {
        present: Boolean(stateToken),
      });
      to.searchParams.set('connect_error', 'connect_failed');
      return reply.redirect(to.toString());
    }

    // Synchronization is part of OAuth completion, not a side effect: the
    // redirect only says "connected" once the account list Zernio returns
    // for this user actually contains the platform, re-read through the same
    // user-scoped path the API serves.
    try {
      const profile = await getSocialProfile(state.user_id);
      if (!profile) throw new Error('no Zernio profile for user at callback time');
      await syncAccounts(state.user_id, profile.zernio_profile_id);
      const verified = await verifyConnected(state.user_id, state.platform);
      if (verified) {
        to.searchParams.set('connected', state.platform);
        logger.info('social account connected', { platform: state.platform });
      } else {
        to.searchParams.set('connect_error', 'account_sync_failed');
        to.searchParams.set('platform', state.platform);
      }
    } catch (cause) {
      // Never log the error wholesale — Zernio errors can carry the raw
      // upstream body, which may include tokens.
      logger.error('social account sync failed after OAuth', {
        platform: state.platform,
        error: cause instanceof Error ? cause.name : 'unknown',
      });
      const subscriptionRequired = cause instanceof ZernioApiError && cause.status === 402;
      to.searchParams.set('connect_error', subscriptionRequired ? 'subscription_required' : 'account_sync_failed');
      to.searchParams.set('platform', state.platform);
    }
    return reply.redirect(to.toString());
  });

  /** Start the hosted-OAuth flow for one platform. Returns { url }. */
  app.get('/api/connect/:platform', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);
    requireZernio();
    if (!env.ZERNIO_CONNECT_REDIRECT_URL) {
      throw HttpError.serviceUnavailable('Publishing is not configured on this deployment');
    }

    const userId = requireUserId(request.principal);
    const { platform } = parse(z.object({ platform: z.string().toLowerCase() }), request.params, 'path parameters');
    if (!isPublishPlatform(platform)) {
      throw HttpError.badRequest(`CLIPIT publishes to: ${PUBLISH_PLATFORMS.join(', ')}`);
    }

    const profileId = await getOrCreateZernioProfile(userId, `clipit-${userId.slice(0, 12)}`);

    // Persist who/what server-side; thread only the opaque token through
    // Zernio. Nothing identifying ever rides in the redirect query string.
    const token = await createConnectionState({ userId, platform, ttlSeconds: CONNECT_STATE_TTL_SECONDS });
    const redirectTarget = new URL(env.ZERNIO_CONNECT_REDIRECT_URL);
    redirectTarget.searchParams.set('state', token);

    let url: string;
    try {
      url = await zernio.getConnectUrl(platform, { profileId, redirectUrl: redirectTarget.toString() });
    } catch (cause) {
      if (cause instanceof ZernioApiError && cause.status === 402) {
        // Only the status is inspected — never the body, which can carry
        // provider-internal billing identifiers.
        throw HttpError.paymentRequired('Connecting another account needs a plan upgrade');
      }
      throw cause;
    }

    return reply.send({ platform, url });
  });

  /**
   * The caller's connected accounts. Guests get an empty list plus the
   * honest reason, so the page can say "sign in" instead of "nothing".
   */
  app.get('/api/social-accounts', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);
    if (!zernioConfigured()) {
      return reply.send({ configured: false, signInRequired: false, accounts: [] });
    }
    const userId = request.principal?.userId ?? null;
    if (!userId) {
      return reply.send({ configured: true, signInRequired: true, accounts: [] });
    }
    const accounts = await listSocialAccounts(userId);
    return reply.send({
      configured: true,
      signInRequired: false,
      accounts: accounts.map((account) => ({
        id: account.id,
        platform: account.platform,
        displayName: account.display_name,
        status: account.status,
      })),
    });
  });

  /**
   * Disconnect. Zernio confirms the revoke BEFORE the local row flips —
   * never the other way around, so a failed revoke can't leave the screen
   * showing "disconnected" while the connection is still live and able to act.
   */
  app.delete('/api/social-accounts/:accountId', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);
    requireZernio();
    const userId = requireUserId(request.principal);
    const { accountId } = parse(z.object({ accountId: z.string().min(1) }), request.params, 'path parameters');

    const account = await getSocialAccount(accountId);
    if (!account || account.user_id !== userId) throw HttpError.notFound('Account not found');

    await zernio.disconnectAccount(accountId);
    const updated = await setSocialAccountStatus(accountId, 'disconnected');
    return reply.send({
      account: {
        id: accountId,
        platform: account.platform,
        displayName: account.display_name,
        status: updated?.status ?? 'disconnected',
      },
    });
  });

  /** Publish one clip to chosen (or all) connected accounts. */
  app.post('/api/clips/:clipId/publish', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'generate', perSession: env.RATE_LIMIT_GENERATE_PER_SESSION_HOURLY, windowSeconds: 60 * 60 },
    ]);
    requireZernio();
    const userId = requireUserId(request.principal);
    const { clipId } = parse(z.object({ clipId: z.string().uuid() }), request.params, 'path parameters');
    const body = parse(
      z.object({
        caption: z.string().trim().max(5000).default(''),
        accountIds: z.array(z.string().min(1)).max(10).optional(),
      }),
      request.body ?? {},
    );

    const clip = await getClip(clipId);
    if (!clip || clip.userId !== userId) throw HttpError.notFound('Clip not found');
    if (clip.status !== 'ready' || !clip.storageKey) {
      throw HttpError.conflict('This clip is not ready yet — publish it once it has finished cutting');
    }

    const stored = (await listSocialAccounts(userId)).filter((account) => account.status === 'connected');
    if (stored.length === 0) {
      throw HttpError.unprocessable('No connected accounts. Connect one on the Publishing page first.');
    }

    let targets = stored;
    if (body.accountIds?.length) {
      const wanted = new Set(body.accountIds);
      targets = stored.filter((account) => wanted.has(account.id));
      if (targets.length !== wanted.size) {
        throw HttpError.badRequest('Some accountIds are not your connected accounts');
      }
    }

    // A fresh signed URL minted at publish time: Zernio downloads the file
    // server-side, so the API never proxies the bytes.
    const mediaUrl = await getStorage().createDownloadUrl(clip.storageKey);

    const created = await zernio.createPost({
      content: body.caption,
      platforms: targets.map((account) => ({ platform: account.platform, accountId: account.id })),
      mediaUrls: [mediaUrl],
      publishNow: true,
    });

    const post = await insertPublishedPost({
      userId,
      clipId,
      zernioPostId:
        (typeof created.id === 'string' && created.id) || (typeof created.postId === 'string' && created.postId) || null,
      caption: body.caption,
      targets: targets.map((account) => ({ platform: account.platform, accountId: account.id })),
      status: typeof created.status === 'string' ? created.status : 'submitted',
    });

    logger.info('clip publish submitted', { clipId, targets: targets.length });

    return reply.code(202).send({
      post: {
        id: post.id,
        clipId,
        status: post.status,
        targets: targets.map((account) => ({ platform: account.platform, accountId: account.id })),
        createdAt: post.created_at.toISOString(),
      },
    });
  });
}
