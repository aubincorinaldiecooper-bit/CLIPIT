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
  findInFlightPublish,
  getSocialAccount,
  insertPublishedPost,
  listSocialAccounts,
  setSocialAccountStatus,
  getSocialProfile,
  updatePublishedPost,
} from '../../db/repositories/social.js';
import {
  PUBLISH_PLATFORMS,
  getOrCreateZernioProfile,
  isPublishPlatform,
  syncAccounts,
  usableZernioId,
  verifyConnectAttempt,
} from '../../services/social/accounts.js';
import { zernio, ZernioApiError, zernioConfigured } from '../../services/zernio/client.js';
import { executeClipPublish } from '../../services/social/publishClip.js';
import {
  cancelScheduledPost,
  getScheduledPost,
  insertScheduledPost,
  listScheduledPostsForUser,
  type ScheduledPostRow,
  type ScheduledPostView,
} from '../../db/repositories/scheduledPosts.js';
import { enqueueScheduledPublish, removeScheduledPublishJob } from '../../queues/index.js';

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

/**
 * How long a 'submitting' record blocks a re-publish of the same clip. Long
 * enough to absorb a double-click or an automatic retry after a dropped
 * response; short enough that a genuinely stuck submission doesn't lock the
 * clip out of publishing forever.
 */
const PUBLISH_RETRY_GUARD_SECONDS = 2 * 60;

/** Platform names as their own users write them, never a lowercased id. */
const PLATFORM_LABEL: Record<string, string> = {
  tiktok: 'TikTok',
  youtube: 'YouTube',
  instagram: 'Instagram',
};

/**
 * Turn a failure in the connect flow into something a person can act on.
 *
 * What this replaces is the generic 500 — "Something went wrong handling this
 * request" — which is what a real user saw on every Connect button while the
 * flow was permanently broken. It told the one person who could do something
 * about it precisely nothing: not whether it was us or the platform, not
 * whether waiting would help, not whether to stop trying.
 *
 * Two rules hold throughout. Only the HTTP STATUS is ever read, because the
 * upstream body can carry tokens and billing identifiers. And the publishing
 * provider is never named to the browser — the person connected a YouTube
 * account, and that is the only vocabulary this app owes them.
 */
export function connectFailure(cause: unknown, context: string): HttpError {
  // Record it. HttpError is returned to the browser verbatim and NEVER logged
  // by the error handler, so turning these failures into friendly messages
  // also turned them invisible: the first live failure after this shipped
  // produced a perfect sentence for the user and not one line to debug from.
  // Status and error name only — the body can carry tokens and billing ids.
  logger.error('connect flow failed', {
    context,
    status: cause instanceof ZernioApiError ? cause.status : null,
    name: cause instanceof Error ? cause.name : 'unknown',
    // The provider's own message text is safe: it is the summary line the
    // client builds ("Zernio POST /profiles failed with 409"), not the body.
    detail: cause instanceof ZernioApiError ? cause.message : null,
  });

  if (!(cause instanceof ZernioApiError)) {
    // Our own plumbing, not the platform's. Say so rather than implying the
    // platform is down — blaming the wrong party sends someone off checking
    // a service that was never the problem.
    return HttpError.serviceUnavailable(`${context}. This one is on us — try again in a moment.`);
  }
  if (cause.status === 402) {
    return HttpError.paymentRequired('Connecting another account needs a plan upgrade');
  }
  if (cause.status === 401 || cause.status === 403) {
    return HttpError.serviceUnavailable(
      `${context}. CLIPIT's own connection to the publishing service was refused — this is on our side, not yours.`,
    );
  }
  if (cause.status === 429) {
    return HttpError.serviceUnavailable(`${context}. Too many attempts just now — wait a minute and try again.`);
  }
  if (cause.status >= 500) {
    return HttpError.serviceUnavailable(
      `${context}. The publishing service isn't responding — this usually clears on its own, so try again shortly.`,
    );
  }
  return HttpError.serviceUnavailable(`${context}. Try again, and let us know if it keeps happening.`);
}

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

/**
 * Publishing happens from a person's own library: the accounts they connected
 * and the clips they cut. Shared rooms hold clips people send each other;
 * whose accounts a room would publish to is a question with no obvious right
 * answer, so it is deliberately not asked here.
 */
function requireWorkspaceId(principal: { ownWorkspaceId: string | null } | null): string {
  if (!principal?.ownWorkspaceId) {
    throw HttpError.forbidden('Publishing needs an account — sign in first');
  }
  return principal.ownWorkspaceId;
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
    // for this user actually changed for THIS attempt — judged against a
    // snapshot taken before the sync, re-read through the same user-scoped
    // path the API serves. An attempt that changed nothing while an older
    // account was already connected reports 'nothing_new', not success.
    try {
      const profile = await getSocialProfile(state.user_id);
      if (!profile) throw new Error('no Zernio profile for user at callback time');
      if (!state.workspace_id) throw new Error('connect state has no workspace');
      const before = await listSocialAccounts(state.workspace_id, { platform: state.platform });
      await syncAccounts(state.user_id, profile.zernio_profile_id, state.workspace_id);
      const { outcome, account } = await verifyConnectAttempt(state.workspace_id, state.platform, before);
      if (outcome === 'connected') {
        to.searchParams.set('connected', state.platform);
        // The page that was added, so the confirmation can name it. Someone
        // connects an account, not a platform, and with two Instagram pages
        // "Instagram is connected" does not say which one they just added.
        if (account?.display_name) to.searchParams.set('account', account.display_name);
        logger.info('social account connected', { platform: state.platform });
      } else {
        to.searchParams.set('connect_error', outcome === 'nothing_new' ? 'nothing_new' : 'account_sync_failed');
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

    let profileId: string;
    try {
      profileId = await getOrCreateZernioProfile(userId, `clipit-${userId.slice(0, 12)}`);
    } catch (cause) {
      throw connectFailure(cause, 'Your publishing workspace could not be set up');
    }

    // Persist who/what server-side; thread only the opaque token through
    // Zernio. Nothing identifying ever rides in the redirect query string.
    const token = await createConnectionState({
      userId,
      workspaceId: requireWorkspaceId(request.principal),
      platform,
      ttlSeconds: CONNECT_STATE_TTL_SECONDS,
    });
    const redirectTarget = new URL(env.ZERNIO_CONNECT_REDIRECT_URL);
    redirectTarget.searchParams.set('state', token);

    let url: string;
    try {
      url = await zernio.getConnectUrl(platform, { profileId, redirectUrl: redirectTarget.toString() });
    } catch (cause) {
      throw connectFailure(cause, `${PLATFORM_LABEL[platform] ?? platform} could not be reached for sign-in`);
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
    // The caller's own accounts: publishing belongs to a person's library,
    // never to a shared room (see requireWorkspaceId above).
    const accounts = await listSocialAccounts(requireWorkspaceId(request.principal));
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
    if (!account || account.workspace_id !== requireWorkspaceId(request.principal)) {
      throw HttpError.notFound('Account not found');
    }

    // A stored id is not automatically a usable one. populr exports its guard
    // for exactly this call: an id that got persisted as the literal
    // "undefined" by an earlier normalisation bug would otherwise be sent as
    // DELETE /accounts/undefined — a request against nothing, whose failure
    // reads as "the platform refused" rather than "our record is bad".
    if (!usableZernioId(accountId)) {
      logger.error('refusing to disconnect with an unusable stored id', { platform: account.platform });
      throw HttpError.unprocessable(
        'This account is recorded incorrectly and cannot be disconnected automatically. Reconnect it, then try again.',
      );
    }
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

  /** Publish one clip to chosen (or all) connected accounts — now, or later. */
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
        // min(1): an explicitly empty selection is a refusal to pick, not
        // permission to post to every connected account. Omit to mean "all".
        accountIds: z.array(z.string().min(1)).min(1).max(10).optional(),
        /**
         * Post at this time instead of now. The submission itself — file,
         * caption, accounts — runs at that minute through the exact same
         * path as an immediate publish; nothing external happens today.
         */
        scheduledAt: z.string().datetime({ offset: true }).optional(),
      }),
      request.body ?? {},
    );

    const workspaceId = requireWorkspaceId(request.principal);

    if (body.scheduledAt !== undefined) {
      const when = new Date(body.scheduledAt);
      const lead = when.getTime() - Date.now();
      if (lead < 60 * 1000) {
        throw HttpError.badRequest('Pick a time at least a minute from now — or use Post now.');
      }
      if (lead > SCHEDULE_HORIZON_DAYS * 24 * 60 * 60 * 1000) {
        throw HttpError.badRequest(`Scheduling reaches ${SCHEDULE_HORIZON_DAYS} days ahead at most.`);
      }

      // Checked NOW so a bad promise is refused to your face rather than
      // failing quietly at 6 PM — and checked AGAIN at fire time by
      // executeClipPublish, because hours can undo any of it.
      const clip = await getClip(clipId);
      if (!clip || clip.workspaceId !== workspaceId) throw HttpError.notFound('Clip not found');
      if (clip.status !== 'ready' || !clip.storageKey) {
        throw HttpError.conflict('This clip is not ready yet — schedule it once it has finished cutting');
      }
      const stored = (await listSocialAccounts(workspaceId)).filter((account) => account.status === 'connected');
      if (stored.length === 0) {
        throw HttpError.unprocessable('No connected accounts. Connect one on the Publishing page first.');
      }
      if (body.accountIds?.length) {
        const known = new Set(stored.map((account) => account.id));
        if (!body.accountIds.every((id) => known.has(id))) {
          throw HttpError.badRequest('Some accountIds are not your connected accounts');
        }
      }

      const scheduled = await insertScheduledPost({
        userId,
        workspaceId,
        clipId,
        caption: body.caption,
        accountIds: body.accountIds ?? [],
        scheduledAt: when,
      });
      try {
        await enqueueScheduledPublish({ scheduledPostId: scheduled.id }, when);
      } catch (cause) {
        // No alarm, no promise: a row the queue will never fire would sit
        // as "Scheduled" forever. Take it back and report the failure.
        await cancelScheduledPost(scheduled.id, userId);
        throw cause;
      }
      logger.info('clip publish scheduled', { clipId, scheduledAt: when.toISOString() });
      return reply.code(202).send({ scheduled: serializeScheduledPost(scheduled) });
    }

    const posts = await executeClipPublish({
      userId,
      workspaceId,
      clipId,
      caption: body.caption,
      accountIds: body.accountIds ?? null,
    });

    // `post` keeps the old single-post shape for existing clients; `posts`
    // is the whole story, one entry per shape.
    return reply.code(202).send({ post: posts[0], posts });
  });

  /**
   * The publishes promised for later — those still waiting, and those that
   * recently fired or failed. A failed promise that vanished from this list
   * would turn a missed publication into a silent one.
   */
  app.get('/api/scheduled-posts', { preHandler: requireSession }, async (request, reply) => {
    const userId = requireUserId(request.principal);
    if (!zernioConfigured()) return reply.send({ scheduled: [] });
    const rows = await listScheduledPostsForUser(userId);
    return reply.send({
      scheduled: rows.map((row: ScheduledPostView) => ({
        ...serializeScheduledPost(row),
        clipTitle: row.clip_description ?? null,
        // What the platforms actually did, read from the posts themselves.
        outcome: row.outcome,
        firedAt: row.fired_at ? row.fired_at.toISOString() : null,
      })),
    });
  });

  /** Take back a promise not yet kept. Idempotent from the caller's side. */
  app.delete('/api/scheduled-posts/:id', { preHandler: requireSession }, async (request, reply) => {
    const userId = requireUserId(request.principal);
    const { id } = parse(z.object({ id: z.string().uuid() }), request.params, 'path parameters');
    const canceled = await cancelScheduledPost(id, userId);
    if (!canceled) {
      const existing = await getScheduledPost(id);
      if (!existing || existing.user_id !== userId) throw HttpError.notFound('Scheduled post not found');
      // Found but not cancelable: it already fired, failed, or was canceled.
      // Saying which is the difference between "too late" and "already done".
      throw HttpError.conflict(
        existing.status === 'canceled'
          ? 'This scheduled post was already canceled.'
          : 'Too late to cancel — this post has already started going out.',
      );
    }
    // Best-effort: the row's status is the truth the worker checks at fire
    // time, so a job that outlives its canceled row fires into a no-op.
    await removeScheduledPublishJob(id).catch(() => undefined);
    return reply.send({ scheduled: serializeScheduledPost(canceled) });
  });
}

/** How far ahead a publish can be promised. */
const SCHEDULE_HORIZON_DAYS = 30;

function serializeScheduledPost(row: ScheduledPostRow) {
  return {
    id: row.id,
    clipId: row.clip_id,
    caption: row.caption,
    accountIds: row.account_ids,
    scheduledAt: row.scheduled_at.toISOString(),
    status: row.status,
    error: row.error,
  };
}
