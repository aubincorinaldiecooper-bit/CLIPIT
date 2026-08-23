import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { requireSession } from '../auth.js';
import { enforceRateLimits, MINUTE } from '../rateLimit.js';
import { parse } from '../validation.js';
import {
  consumeInvite,
  findInviteByToken,
  getMembership,
  getWorkspaceForUser,
  insertInvite,
  insertMember,
  listMembers,
  listPendingInvites,
  moveMemberToWorkspace,
  removeMember,
  revokeInvite,
  type WorkspaceInviteRow,
  type WorkspaceMemberRow,
} from '../../db/repositories/workspaces.js';
import { ensureWorkspace, sendInviteEmail } from '../../services/workspace/membership.js';

/**
 * Teams: a workspace and the invitations into it.
 *
 * Two standing decisions live here, both taken with the owner:
 *
 * - A workspace shares EVERYTHING. Joining one means the same library and the
 *   same connected social accounts, which is why an invitation is a serious
 *   act and why only the owner may send one.
 *
 * - Signed-in users only, like publishing. A guest tab cannot own a team, and
 *   a workspace bound to one would vanish with the tab.
 *
 * The invitation link carries a single-use token whose hash alone is stored,
 * the same shape as the OAuth connect flow: a database read cannot be
 * replayed as an invitation, and two clicks on the same emailed link cannot
 * both join.
 */

const INVITE_TTL_SECONDS = 7 * 24 * 60 * 60;

function requireUserId(principal: { userId: string | null } | null): string {
  if (!principal?.userId) {
    throw HttpError.forbidden('Teams need an account — sign in first');
  }
  return principal.userId;
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
   * The caller's team. Guests are told to sign in rather than shown an empty
   * team, which would read as "you have no teammates" when the truth is "we
   * do not know who you are".
   */
  app.get('/api/workspace', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const userId = request.principal?.userId ?? null;
    if (!userId) return reply.send({ signInRequired: true, workspace: null, members: [], invites: [] });

    const workspace = await ensureWorkspace(userId, request.principal?.email ?? null);
    const membership = await getMembership(userId);
    const isOwner = membership?.role === 'owner';
    const members = await listMembers(workspace.id);
    // Pending invitations are the owner's business: they name addresses that
    // have been offered access and have not taken it yet.
    const invites = isOwner ? await listPendingInvites(workspace.id) : [];

    return reply.send({
      signInRequired: false,
      workspace: { id: workspace.id, name: workspace.name, isOwner },
      members: members.map((member) => serializeMember(member, userId)),
      invites: invites.map(serializeInvite),
      // Said plainly so the page can warn instead of silently creating
      // invitations whose emails will never arrive.
      emailConfigured: Boolean(env.RESEND_API_KEY),
    });
  });

  /** Invite someone by email. Owner only. */
  app.post('/api/workspace/invites', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const userId = requireUserId(request.principal);
    const { email } = parse(
      z.object({ email: z.string().trim().toLowerCase().email().max(320) }),
      request.body ?? {},
    );

    const workspace = await ensureWorkspace(userId, request.principal?.email ?? null);
    const membership = await getMembership(userId);
    if (membership?.role !== 'owner') {
      throw HttpError.forbidden('Only the workspace owner can invite people');
    }

    const members = await listMembers(workspace.id);
    if (members.some((member) => member.email?.toLowerCase() === email)) {
      throw HttpError.conflict('That person is already in this workspace');
    }

    if (!env.FRONTEND_URL) {
      throw HttpError.serviceUnavailable('Invitations are not configured on this deployment');
    }

    const { invite, token } = await insertInvite({
      workspaceId: workspace.id,
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
      invitedByEmail: membership?.email ?? null,
    });

    logger.info('workspace invite created', { workspaceId: workspace.id, emailed: delivery.sent });

    return reply.code(201).send({
      invite: serializeInvite(invite),
      // Never claim an email arrived that did not. The link still works, so
      // the page can offer to copy it instead.
      emailed: delivery.sent,
      emailProblem: delivery.reason ?? null,
      acceptUrl: acceptUrl.toString(),
    });
  });

  /** Withdraw an invitation that has not been accepted. Owner only. */
  app.delete('/api/workspace/invites/:inviteId', { preHandler: requireSession }, async (request, reply) => {
    const userId = requireUserId(request.principal);
    const { inviteId } = parse(z.object({ inviteId: z.string().uuid() }), request.params, 'path parameters');

    const workspace = await getWorkspaceForUser(userId);
    const membership = await getMembership(userId);
    if (!workspace || membership?.role !== 'owner') {
      throw HttpError.forbidden('Only the workspace owner can withdraw invitations');
    }

    const revoked = await revokeInvite(workspace.id, inviteId);
    if (!revoked) throw HttpError.notFound('Invitation not found');
    return reply.send({ inviteId, revoked: true });
  });

  /**
   * What an invitation is for, before anyone commits to it — the token is
   * looked up but not spent, so a person can see whose team they are being
   * asked to join (and sign in first if they need to) without burning the
   * link.
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

    const workspace = await getWorkspaceForUser(invite.invited_by);
    return reply.send({
      valid: true,
      workspaceName: workspace?.name ?? 'a CLIPIT workspace',
      email: invite.email,
    });
  });

  /** Accept an invitation. The caller must be signed in — that is who joins. */
  app.post('/api/workspace/invites/accept', { preHandler: requireSession }, async (request, reply) => {
    await enforceRateLimits(request, [
      { scope: 'read', perSession: env.RATE_LIMIT_READ_PER_SESSION_MINUTE, windowSeconds: MINUTE },
    ]);

    const userId = requireUserId(request.principal);
    const { invite: token } = parse(
      z.object({ invite: z.string().trim().min(1).max(200) }),
      request.body ?? {},
    );

    // One workspace per person, so joining a team means leaving your own room
    // behind — refuse rather than silently move someone's library out of
    // reach. Their own workspace is only "leavable" if it is empty of others.
    const existing = await getMembership(userId);
    if (existing) {
      const peers = await listMembers(existing.workspace_id);
      if (peers.length > 1) {
        throw HttpError.conflict(
          'You are already in a workspace with other people. Leave that team before joining another.',
        );
      }
    }

    const invite = await consumeInvite(token, userId);
    if (!invite) {
      throw HttpError.badRequest('That invitation has expired or has already been used. Ask for a new one.');
    }

    // The invite is spent; the membership must follow. A person already alone
    // in their own workspace is moved into the new one.
    if (existing) {
      await moveMemberToWorkspace(userId, invite.workspace_id, invite.email);
    } else {
      await insertMember({
        workspaceId: invite.workspace_id,
        userId,
        role: 'member',
        email: request.principal?.email ?? invite.email,
      });
    }

    const workspace = await getWorkspaceForUser(userId);
    logger.info('workspace invite accepted', { workspaceId: invite.workspace_id });

    return reply.send({
      joined: true,
      workspace: workspace ? { id: workspace.id, name: workspace.name, isOwner: false } : null,
    });
  });

  /** Remove a teammate. Owner only; the owner cannot remove themselves. */
  app.delete('/api/workspace/members/:memberUserId', { preHandler: requireSession }, async (request, reply) => {
    const userId = requireUserId(request.principal);
    const { memberUserId } = parse(
      z.object({ memberUserId: z.string().min(1).max(128) }),
      request.params,
      'path parameters',
    );

    const workspace = await getWorkspaceForUser(userId);
    const membership = await getMembership(userId);
    if (!workspace || membership?.role !== 'owner') {
      throw HttpError.forbidden('Only the workspace owner can remove people');
    }
    if (memberUserId === userId) {
      throw HttpError.conflict('The owner cannot be removed from their own workspace');
    }

    const removed = await removeMember(workspace.id, memberUserId);
    if (!removed) throw HttpError.notFound('That person is not in this workspace');

    logger.info('workspace member removed', { workspaceId: workspace.id });
    return reply.send({ removed: true });
  });
}
