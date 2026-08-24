import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { requireSession } from '../auth.js';
import { enforceRateLimits, MINUTE } from '../rateLimit.js';
import { parse } from '../validation.js';
import { serializeLibraryClip } from '../serializers.js';
import {
  getClip,
  listClipsForPrincipal,
  listWorkspaceClips,
  listWorkspacesForClip,
  shareClipToWorkspace,
  unshareClipFromWorkspace,
} from '../../db/repositories/clips.js';
import {
  acceptInviteAndJoin,
  createSharedWorkspace,
  findInviteByToken,
  getMembership,
  getOwnWorkspace,
  getWorkspaceById,
  insertInvite,
  leaveWorkspace,
  listMembers,
  listPendingInvites,
  listShareTargets,
  listWorkspacesForUser,
  removeMember,
  revokeInvite,
  type WorkspaceInviteRow,
  type WorkspaceMemberRow,
} from '../../db/repositories/workspaces.js';
import { ensureWorkspace, sendInviteEmail } from '../../services/workspace/membership.js';

/**
 * Workspaces: shared rooms you navigate to, holding clips people have sent
 * there.
 *
 * The standing decisions, all taken with the owner:
 *
 * - A workspace is a PLACE, not a mode. Nothing about the rest of the app
 *   changes because you have one; your library stays your library, and you
 *   open a room to see what is in it.
 *
 * - Sending a clip SHARES it. It appears in the room and stays in the library
 *   of whoever cut it — sending is not supposed to cost you the thing you
 *   sent.
 *
 * - Only the room's owner invites and removes people. Signed-in users only,
 *   like publishing: a room bound to a guest tab would vanish with the tab.
 *
 * Invitations carry a single-use token whose hash alone is stored, the same
 * shape as the OAuth connect flow.
 */

const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

function requireUserId(principal: { userId: string | null } | null): string {
  if (!principal?.userId) {
    throw HttpError.forbidden('Workspaces need an account — sign in first');
  }
  return principal.userId;
}

/**
 * The room, confirmed to be one this caller is actually in. 404 rather than
 * 403 throughout: someone guessing ids should not learn which ones exist.
 */
async function requireMembership(
  request: FastifyRequest,
  workspaceId: string,
): Promise<{ userId: string; isOwner: boolean }> {
  const userId = requireUserId(request.principal);
  const membership = await getMembership(userId, workspaceId);
  if (!membership) throw HttpError.notFound('Workspace not found');
  return { userId, isOwner: membership.role === 'owner' };
}

async function requireOwner(request: FastifyRequest, workspaceId: string, action: string): Promise<string> {
  const { userId, isOwner } = await requireMembership(request, workspaceId);
  if (!isOwner) throw HttpError.forbidden(`Only the workspace owner can ${action}`);
  return userId;
}

function serializeMember(member: WorkspaceMemberRow, callerUserId: string) {
  return {
    userId: member.user_id,
    email: member.email,
    role: member.role,
    joinedAt: member.joined_at.toISOString(),
    isYou: member.user_id === callerUserId,
  };
}

function serializeInvite(invite: WorkspaceInviteRow) {
  return {
    id: invite.id,
    email: invite.email,
    invitedAt: invite.created_at.toISOString(),
    expiresAt: invite.expires_at.toISOString(),
  };
}

export async function registerWorkspaceRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Every workspace this person is in, their own first — the traditional
   * shape: your first workspace is where all your clips live, and creating
   * another (with people invited into it) is how sharing starts.
   */
  app.get('/api/workspaces', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const userId = request.principal?.userId ?? null;
    if (!userId) return reply.send({ signInRequired: true, workspaces: [] });

    // Their personal room is made on first sight so uploads always have
    // somewhere to land, even for someone who never opens this page.
    await ensureWorkspace(userId, request.principal?.email ?? null);
    const workspaces = await listWorkspacesForUser(userId);

    return reply.send({
      signInRequired: false,
      workspaces: workspaces.map((row) => ({
        id: row.id,
        name: row.name,
        isOwner: row.owner_user_id === userId,
        isPersonal: row.is_personal,
        memberCount: row.member_count,
        clipCount: row.clip_count,
      })),
      // Said plainly so the page can warn instead of silently creating
      // invitations whose emails will never arrive.
      emailConfigured: Boolean(env.RESEND_API_KEY),
    });
  });

  /** Make a room. Whoever makes it owns it. */
  app.post('/api/workspaces', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const userId = requireUserId(request.principal);
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(80) }), request.body ?? {});

    await ensureWorkspace(userId, request.principal?.email ?? null);
    const workspace = await createSharedWorkspace({
      name,
      ownerUserId: userId,
      email: request.principal?.email ?? null,
    });
    logger.info('workspace created', { workspaceId: workspace.id });

    return reply.code(201).send({
      workspace: { id: workspace.id, name: workspace.name, isOwner: true, memberCount: 1, clipCount: 0 },
    });
  });

  /** One room: what is in it, and who is in it. */
  app.get('/api/workspaces/:workspaceId', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const { workspaceId } = parse(z.object({ workspaceId: z.string().uuid() }), request.params, 'path parameters');
    const { userId, isOwner } = await requireMembership(request, workspaceId);

    const workspace = await getWorkspaceById(workspaceId);
    if (!workspace) throw HttpError.notFound('Workspace not found');

    const [members, clips, invites] = await Promise.all([
      listMembers(workspaceId),
      // The personal workspace IS the library: its page shows every playable
      // clip its owner has cut. A shared room shows what was sent to it.
      // One page of 60 either way — and the response says when there is
      // more, so the page can point at the full library instead of silently
      // truncating.
      workspace.is_personal
        ? listClipsForPrincipal({ sessionId: null, userId, workspaceId }, { limit: 61 })
        : listWorkspaceClips(workspaceId, 61),
      // Pending invitations are the owner's business: they name addresses
      // that have been offered access and have not taken it yet.
      isOwner && !workspace.is_personal ? listPendingInvites(workspaceId) : Promise.resolve([]),
    ]);

    const page = clips.slice(0, 60);
    return reply.send({
      workspace: { id: workspace.id, name: workspace.name, isOwner, isPersonal: workspace.is_personal },
      members: members.map((member) => serializeMember(member, userId)),
      clips: await Promise.all(page.map((entry) => serializeLibraryClip(entry))),
      // True when a 61st exists: the page must say so rather than let its
      // own list silently disagree with the count beside it.
      hasMoreClips: clips.length > page.length,
      invites: invites.map(serializeInvite),
      emailConfigured: Boolean(env.RESEND_API_KEY),
    });
  });

  /**
   * Send a clip to a room. Any member may send; the clip must be one the
   * sender can already open, which is what stops a room being used to reach
   * into someone else's library.
   */
  app.post('/api/workspaces/:workspaceId/clips', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const { workspaceId } = parse(z.object({ workspaceId: z.string().uuid() }), request.params, 'path parameters');
    const { clipId } = parse(z.object({ clipId: z.string().uuid() }), request.body ?? {});
    const { userId } = await requireMembership(request, workspaceId);

    const target = await getWorkspaceById(workspaceId);
    if (target?.is_personal) {
      // A share into your own workspace would be invisible (its page lists
      // the library, not shares) and unremovable from any screen — and for a
      // teammate's clip it would quietly pin permanent access. Refused.
      throw HttpError.conflict('Your own workspace already holds your clips — send to a shared workspace.');
    }

    const clip = await getClip(clipId);
    if (!clip) throw HttpError.notFound('Clip not found');

    const mine = clip.workspaceId
      ? (request.principal?.workspaceIds ?? []).includes(clip.workspaceId)
      : clip.userId === userId;
    if (!mine) {
      // Already-shared clips can be passed on by anyone who can see them.
      const sharedWith = await listWorkspacesForClip(clipId);
      const reachable = sharedWith.some((id) => (request.principal?.workspaceIds ?? []).includes(id));
      if (!reachable) throw HttpError.notFound('Clip not found');
    }

    if (clip.status !== 'ready' || !clip.storageKey) {
      throw HttpError.conflict('This clip is not ready yet — send it once it has finished cutting');
    }

    await shareClipToWorkspace({ workspaceId, clipId, sharedBy: userId });
    logger.info('clip sent to workspace', { workspaceId });
    return reply.code(201).send({ shared: true });
  });

  /** Take a clip back out of a room. The clip itself is untouched. */
  app.delete(
    '/api/workspaces/:workspaceId/clips/:clipId',
    { preHandler: requireSession },
    async (request, reply) => {
      const { workspaceId, clipId } = parse(
        z.object({ workspaceId: z.string().uuid(), clipId: z.string().uuid() }),
        request.params,
        'path parameters',
      );
      await requireMembership(request, workspaceId);

      const removed = await unshareClipFromWorkspace(workspaceId, clipId);
      if (!removed) throw HttpError.notFound('That clip is not in this workspace');
      return reply.send({ removed: true });
    },
  );

  /** Invite someone into a room. Owner only. */
  app.post('/api/workspaces/:workspaceId/invites', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const { workspaceId } = parse(z.object({ workspaceId: z.string().uuid() }), request.params, 'path parameters');
    const { email } = parse(
      z.object({ email: z.string().trim().toLowerCase().email().max(320) }),
      request.body ?? {},
    );
    const userId = await requireOwner(request, workspaceId, 'invite people');

    const workspace = await getWorkspaceById(workspaceId);
    if (!workspace) throw HttpError.notFound('Workspace not found');
    if (workspace.is_personal) {
      throw HttpError.conflict('Your personal workspace is yours alone — create a workspace to invite people into.');
    }

    const members = await listMembers(workspaceId);
    if (members.some((member) => member.email?.toLowerCase() === email)) {
      throw HttpError.conflict('That person is already in this workspace');
    }

    if (!env.FRONTEND_URL) {
      throw HttpError.serviceUnavailable('Invitations are not configured on this deployment');
    }

    const { invite, token } = await insertInvite({
      workspaceId,
      email,
      invitedBy: userId,
      ttlSeconds: INVITE_TTL_SECONDS,
    });

    const acceptUrl = new URL(`${env.FRONTEND_URL.replace(/\/+$/, '')}/join`);
    acceptUrl.searchParams.set('invite', token);

    const delivery = await sendInviteEmail({
      to: email,
      acceptUrl: acceptUrl.toString(),
      workspaceName: workspace.name,
      invitedByEmail: members.find((member) => member.user_id === userId)?.email ?? null,
    });

    logger.info('workspace invite created', { workspaceId, emailed: delivery.sent });

    return reply.code(201).send({
      invite: serializeInvite(invite),
      // Never claim an email arrived that did not. The link still works, so
      // the page can offer to pass it on by hand instead.
      emailed: delivery.sent,
      emailProblem: delivery.reason ?? null,
      acceptUrl: acceptUrl.toString(),
    });
  });

  /** Withdraw an invitation that has not been accepted. Owner only. */
  app.delete(
    '/api/workspaces/:workspaceId/invites/:inviteId',
    { preHandler: requireSession },
    async (request, reply) => {
      const { workspaceId, inviteId } = parse(
        z.object({ workspaceId: z.string().uuid(), inviteId: z.string().uuid() }),
        request.params,
        'path parameters',
      );
      await requireOwner(request, workspaceId, 'withdraw invitations');

      const revoked = await revokeInvite(workspaceId, inviteId);
      if (!revoked) throw HttpError.notFound('Invitation not found');
      return reply.send({ inviteId, revoked: true });
    },
  );

  /** Remove someone from a room. Owner only; never themselves. */
  app.delete(
    '/api/workspaces/:workspaceId/members/:memberUserId',
    { preHandler: requireSession },
    async (request, reply) => {
      const { workspaceId, memberUserId } = parse(
        z.object({ workspaceId: z.string().uuid(), memberUserId: z.string().min(1).max(128) }),
        request.params,
        'path parameters',
      );
      const userId = await requireOwner(request, workspaceId, 'remove people');
      if (memberUserId === userId) {
        throw HttpError.conflict('The owner cannot be removed from their own workspace');
      }

      const removed = await removeMember(workspaceId, memberUserId);
      if (!removed) throw HttpError.notFound('That person is not in this workspace');

      logger.info('workspace member removed', { workspaceId });
      return reply.send({ removed: true });
    },
  );

  /** Leave a room. An owner cannot leave their own. */
  app.delete('/api/workspaces/:workspaceId/members/me', { preHandler: requireSession }, async (request, reply) => {
    const { workspaceId } = parse(z.object({ workspaceId: z.string().uuid() }), request.params, 'path parameters');
    const { userId } = await requireMembership(request, workspaceId);

    const left = await leaveWorkspace(userId, workspaceId);
    if (!left) {
      throw HttpError.conflict('You cannot leave a workspace you own. Hand it over or remove the others first.');
    }

    logger.info('workspace left', { workspaceId });
    return reply.send({ left: true });
  });

  /**
   * What an invitation is for, before anyone commits to it — the token is
   * looked up but not spent, so a person can see which room they are being
   * asked into (and sign in first if they need to) without burning the link.
   */
  app.get('/api/workspace/invites/preview', async (request, reply) => {
    const { invite: token } = parse(
      z.object({ invite: z.string().trim().min(1).max(200) }),
      request.query,
      'query parameters',
    );

    const invite = await findInviteByToken(token);
    if (!invite || invite.revoked_at || invite.accepted_at || invite.expires_at.getTime() <= Date.now()) {
      // One answer for every dead end: an outsider guessing tokens learns
      // nothing about which ones existed.
      return reply.send({ valid: false, workspaceName: null, email: null });
    }

    const workspace = await getWorkspaceById(invite.workspace_id);
    return reply.send({
      valid: true,
      workspaceName: workspace?.name ?? 'a CLIPIT workspace',
      email: invite.email,
    });
  });

  /** Accept an invitation. The signed-in caller is who joins. */
  app.post('/api/workspace/invites/accept', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const userId = requireUserId(request.principal);
    const { invite: token } = parse(z.object({ invite: z.string().trim().min(1).max(200) }), request.body ?? {});

    // Their own room is made first if they have never signed in here, so
    // accepting cannot leave someone in a team with nowhere of their own.
    await ensureWorkspace(userId, request.principal?.email ?? null);

    // Already in this room: spend nothing — the link stays good for whoever
    // it was meant for — and say so rather than claiming a fresh join.
    const preview = await findInviteByToken(token);
    if (preview && (await getMembership(userId, preview.workspace_id))) {
      const workspace = await getWorkspaceById(preview.workspace_id);
      return reply.send({
        joined: true,
        alreadyMember: true,
        workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
      });
    }

    // Spending the invitation and taking up the membership happen together or
    // not at all: a spent invitation that let nobody in cannot be retried.
    const invite = await acceptInviteAndJoin(token, userId, request.principal?.email ?? null);
    if (!invite) {
      throw HttpError.badRequest('That invitation has expired or has already been used. Ask for a new one.');
    }

    const workspace = await getWorkspaceById(invite.workspace_id);
    logger.info('workspace invite accepted', { workspaceId: invite.workspace_id });

    return reply.send({
      joined: true,
      alreadyMember: false,
      workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
    });
  });

  /**
   * The rooms a clip can be sent to, and which it is already in — everything
   * the library's "Send to workspace" control needs in one call.
   */
  app.get('/api/clips/:clipId/workspaces', { preHandler: requireSession }, async (request, reply) => {
    const { clipId } = parse(z.object({ clipId: z.string().uuid() }), request.params, 'path parameters');
    const userId = request.principal?.userId ?? null;
    // A guest is told WHY the list is empty, not shown an empty list that
    // reads as "you have no workspaces".
    if (!userId) return reply.send({ signInRequired: true, workspaces: [], sharedWith: [] });

    // Shared rooms only: the personal workspace already holds the caller's
    // clips, and offering it as a destination created invisible shares.
    const [rooms, sharedWith] = await Promise.all([
      listShareTargets(userId),
      listWorkspacesForClip(clipId),
    ]);
    return reply.send({
      signInRequired: false,
      workspaces: rooms.map((row) => ({ id: row.id, name: row.name })),
      sharedWith: sharedWith.filter((id) => rooms.some((row) => row.id === id)),
    });
  });

  /** A person's own room, so "Your clips" can name itself if it ever needs to. */
  app.get('/api/workspace', { preHandler: requireSession }, async (request, reply) => {
    const userId = request.principal?.userId ?? null;
    if (!userId) return reply.send({ signInRequired: true, workspace: null });
    const workspace = await getOwnWorkspace(userId);
    return reply.send({
      signInRequired: false,
      workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
    });
  });
}
