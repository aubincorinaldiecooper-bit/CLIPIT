import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';
import { HttpError } from '../lib/errors.js';
import { findSessionByToken } from '../db/repositories/sessions.js';
import { listWorkspaceUserIds } from '../db/repositories/workspaces.js';
import type { Principal } from '../domain/types.js';

/**
 * Anonymous session authentication.
 *
 * A client calls POST /api/sessions once, stores the returned bearer token, and
 * sends it on every subsequent request. Resources are owned by the session that
 * created them.
 *
 * The indirection through `Principal` is deliberate: when real user accounts
 * land, `userId` becomes populated and ownership checks switch to it without
 * any route needing to change.
 */

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match?.[1]) return match[1].trim();
  }

  // Convenience for browser clients that cannot set headers on media requests.
  const headerToken = request.headers['x-session-token'];
  if (typeof headerToken === 'string' && headerToken.trim()) return headerToken.trim();

  return null;
}

/** Resolves the principal when a token is present; never rejects. */
export async function attachPrincipal(request: FastifyRequest): Promise<void> {
  request.principal = null;
  const token = extractToken(request);
  if (!token) return;

  const session = await findSessionByToken(token);
  if (!session) return;

  // A signed-in caller acts for their whole workspace. One small indexed
  // lookup per authenticated request buys a single, always-current answer —
  // no cache to go stale the moment someone is removed from a team.
  const userIds = session.userId ? await listWorkspaceUserIds(session.userId) : [];
  request.principal = {
    sessionId: session.id,
    userId: session.userId,
    userIds,
    // The session label is the address they signed in with, recorded at the
    // auth exchange; null for guests.
    email: session.label,
  };
}

/** preHandler for routes that require a caller identity. */
export async function requireSession(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!env.REQUIRE_SESSION) return;
  if (request.principal) return;

  throw new HttpError(
    401,
    'unauthenticated',
    'A session token is required. Create one with POST /api/sessions and send it as "Authorization: Bearer <token>".',
  );
}

export function principalOrNull(request: FastifyRequest): Principal | null {
  return request.principal ?? null;
}

/**
 * The scope every "what is mine" query runs in: this session, this person,
 * and everyone in their workspace.
 *
 * Deliberately one helper rather than three hand-built literals. When each
 * route assembled its own, adding the workspace to the shape meant remembering
 * three places — and forgetting one left a listing quietly narrowed to a
 * single person while ownership checks had already widened. One shape, one
 * place to change it.
 */
export function ownerScope(request: FastifyRequest): {
  sessionId: string | null;
  userId: string | null;
  userIds: string[];
} {
  const principal = request.principal;
  return {
    sessionId: principal?.sessionId ?? null,
    userId: principal?.userId ?? null,
    userIds: principal?.userIds ?? [],
  };
}

/**
 * Ownership check for a resource. Rows created before sessions existed, or by a
 * server-side process, have a null owner and are readable by anyone — which
 * only happens when REQUIRE_SESSION is off.
 */
export function assertOwnership(
  request: FastifyRequest,
  resource: { sessionId: string | null; userId: string | null },
  resourceName: string,
): void {
  if (!env.REQUIRE_SESSION) return;
  if (resource.sessionId === null && resource.userId === null) return;

  const principal = request.principal;
  if (!principal) throw HttpError.notFound(`${resourceName} not found`);

  // Anyone in the caller's workspace, which for a lone user is just them.
  if (resource.userId && principal.userIds.includes(resource.userId)) return;
  if (resource.sessionId && principal.sessionId === resource.sessionId) return;

  // 404 rather than 403: an unauthorised caller should not learn the id exists.
  throw HttpError.notFound(`${resourceName} not found`);
}
