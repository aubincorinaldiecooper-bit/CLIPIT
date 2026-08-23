import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/lib/errors.js';
import { assertOwnership, ownerScope } from '../src/api/auth.js';
import type { Principal } from '../src/domain/types.js';

/**
 * Who may see what, once a person can belong to several workspaces.
 *
 * This is the boundary that matters most in the team feature, and it has two
 * distinct halves that are easy to confuse:
 *
 * - Opening something by id works from ANY room the caller belongs to, so a
 *   link a teammate sends is never a dead end.
 * - A listing shows ONE room — the active one — so a person's other projects
 *   never leak into a team's library.
 *
 * A mistake here either hides a teammate's clip from the person it belongs
 * to, or shows someone footage that is not theirs. The second is the one
 * worth being paranoid about, so most of these cases are refusals.
 */

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sessionId: 'session-1',
    userId: 'user-1',
    activeWorkspaceId: 'ws-1',
    workspaceIds: ['ws-1'],
    email: null,
    ...overrides,
  };
}

/** assertOwnership reads request.principal; this is the smallest stand-in. */
function requestWith(value: Principal | null): Parameters<typeof assertOwnership>[0] {
  return { principal: value } as Parameters<typeof assertOwnership>[0];
}

function check(
  caller: Principal | null,
  resource: { sessionId: string | null; userId: string | null; workspaceId?: string | null },
) {
  return () => assertOwnership(requestWith(caller), resource, 'Video');
}

describe('assertOwnership across workspaces', () => {
  it("lets someone open their own room's work", () => {
    expect(check(principal(), { sessionId: null, userId: 'user-1', workspaceId: 'ws-1' })).not.toThrow();
  });

  it("lets a teammate open a workspace-mate's work", () => {
    // Made by someone else, in a room this caller is in.
    expect(check(principal(), { sessionId: null, userId: 'user-2', workspaceId: 'ws-1' })).not.toThrow();
  });

  it('opens work from another room the caller also belongs to', () => {
    // A link from a second team, followed while looking at the first: the
    // page should open rather than read as missing.
    const caller = principal({ activeWorkspaceId: 'ws-1', workspaceIds: ['ws-1', 'ws-2'] });
    expect(check(caller, { sessionId: null, userId: 'user-9', workspaceId: 'ws-2' })).not.toThrow();
  });

  it('refuses a room the caller does not belong to', () => {
    expect(check(principal(), { sessionId: null, userId: 'user-2', workspaceId: 'ws-other' })).toThrow(HttpError);
  });

  it('refuses work whose owner shares no room with the caller', () => {
    // Same person, different team: being able to name them is not access.
    const caller = principal({ userId: 'user-1', workspaceIds: ['ws-1'] });
    expect(check(caller, { sessionId: null, userId: 'user-1', workspaceId: 'ws-2' })).toThrow(HttpError);
  });

  it('refuses someone who has left the team', () => {
    // Nothing about the row changes when a person is removed — their
    // workspace list simply no longer contains it.
    const departed = principal({ userId: 'user-2', activeWorkspaceId: 'ws-own', workspaceIds: ['ws-own'] });
    expect(check(departed, { sessionId: null, userId: 'user-1', workspaceId: 'ws-1' })).toThrow(HttpError);
  });

  it('lets a person open pre-workspace work they made themselves', () => {
    // Rows the backfill could not place still answer to their maker.
    expect(check(principal(), { sessionId: null, userId: 'user-1', workspaceId: null })).not.toThrow();
    expect(check(principal(), { sessionId: null, userId: 'someone-else', workspaceId: null })).toThrow(HttpError);
  });

  it('answers 404, never 403, so an outsider learns nothing about the id', () => {
    try {
      check(principal(), { sessionId: null, userId: 'stranger', workspaceId: 'ws-other' })();
      throw new Error('expected a refusal');
    } catch (cause) {
      expect(cause).toBeInstanceOf(HttpError);
      expect((cause as HttpError).statusCode).toBe(404);
    }
  });

  it('still lets a guest see what their own session made', () => {
    const guest = principal({ userId: null, activeWorkspaceId: null, workspaceIds: [], sessionId: 'session-9' });
    expect(check(guest, { sessionId: 'session-9', userId: null })).not.toThrow();
    expect(check(guest, { sessionId: 'session-other', userId: null })).toThrow(HttpError);
  });

  it("refuses a guest someone else's owned work", () => {
    const guest = principal({ userId: null, activeWorkspaceId: null, workspaceIds: [], sessionId: 'session-9' });
    expect(check(guest, { sessionId: null, userId: 'user-1', workspaceId: 'ws-1' })).toThrow(HttpError);
  });

  it('refuses when there is no caller at all', () => {
    expect(check(null, { sessionId: 'session-1', userId: 'user-1', workspaceId: 'ws-1' })).toThrow(HttpError);
  });
});

/**
 * The scope every listing runs in. This exists as one helper for a reason
 * worth locking down: when each route assembled its own literal, the
 * workspace was added to ownership checks but forgotten in the listings, so
 * teammates could open each other's clips by id while the library still
 * showed one person's work.
 *
 * It carries the ACTIVE workspace alone — never the full membership list.
 * Widening it to every room would pour a person's other projects into
 * whichever team's library they happened to be looking at.
 */
describe('ownerScope', () => {
  it('carries the active workspace only, not every room', () => {
    const scope = ownerScope(requestWith(principal({ activeWorkspaceId: 'ws-1', workspaceIds: ['ws-1', 'ws-2'] })));
    expect(scope).toEqual({ sessionId: 'session-1', userId: 'user-1', workspaceId: 'ws-1' });
  });

  it('gives a guest a session and no workspace', () => {
    const scope = ownerScope(
      requestWith(principal({ userId: null, activeWorkspaceId: null, workspaceIds: [], sessionId: 'session-9' })),
    );
    expect(scope).toEqual({ sessionId: 'session-9', userId: null, workspaceId: null });
  });

  it('is all nulls when there is no principal', () => {
    expect(ownerScope(requestWith(null))).toEqual({ sessionId: null, userId: null, workspaceId: null });
  });
});
