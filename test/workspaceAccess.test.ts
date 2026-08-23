import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/lib/errors.js';
import { assertOwnership, ownerScope } from '../src/api/auth.js';
import type { Principal } from '../src/domain/types.js';

/**
 * Who may see whose work, once a workspace shares everything.
 *
 * This is the boundary that matters most in the team feature: a mistake here
 * either hides a teammate's clip from the person it belongs to, or shows a
 * stranger footage that is not theirs. The second is the one worth being
 * paranoid about, so most of these cases are refusals.
 */

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    sessionId: 'session-1',
    userId: 'user-1',
    userIds: ['user-1'],
    email: null,
    ...overrides,
  };
}

/** assertOwnership reads request.principal; this is the smallest stand-in. */
function requestWith(value: Principal | null): Parameters<typeof assertOwnership>[0] {
  return { principal: value } as Parameters<typeof assertOwnership>[0];
}

function check(caller: Principal | null, resource: { sessionId: string | null; userId: string | null }) {
  return () => assertOwnership(requestWith(caller), resource, 'Video');
}

describe('assertOwnership with workspaces', () => {
  it('lets a person see their own work', () => {
    expect(check(principal(), { sessionId: null, userId: 'user-1' })).not.toThrow();
  });

  it("lets a teammate see a workspace-mate's work", () => {
    const caller = principal({ userId: 'user-1', userIds: ['user-1', 'user-2'] });
    expect(check(caller, { sessionId: null, userId: 'user-2' })).not.toThrow();
  });

  it('refuses someone outside the workspace', () => {
    const caller = principal({ userId: 'user-1', userIds: ['user-1', 'user-2'] });
    expect(check(caller, { sessionId: null, userId: 'stranger' })).toThrow(HttpError);
  });

  it('refuses a removed teammate: the member list is the whole answer', () => {
    // user-2 was in this workspace yesterday. Their id is simply no longer in
    // the caller's list, and nothing else needs to change for access to end.
    const caller = principal({ userId: 'user-2', userIds: ['user-2'] });
    expect(check(caller, { sessionId: null, userId: 'user-1' })).toThrow(HttpError);
  });

  it('answers 404, never 403, so an outsider learns nothing about the id', () => {
    try {
      check(principal(), { sessionId: null, userId: 'stranger' })();
      throw new Error('expected a refusal');
    } catch (cause) {
      expect(cause).toBeInstanceOf(HttpError);
      expect((cause as HttpError).statusCode).toBe(404);
    }
  });

  it('still lets a guest see what their own session made', () => {
    const guest = principal({ userId: null, userIds: [], sessionId: 'session-9' });
    expect(check(guest, { sessionId: 'session-9', userId: null })).not.toThrow();
    expect(check(guest, { sessionId: 'session-other', userId: null })).toThrow(HttpError);
  });

  it("refuses a guest someone else's owned work", () => {
    const guest = principal({ userId: null, userIds: [], sessionId: 'session-9' });
    expect(check(guest, { sessionId: null, userId: 'user-1' })).toThrow(HttpError);
  });

  it('refuses when there is no caller at all', () => {
    expect(check(null, { sessionId: 'session-1', userId: 'user-1' })).toThrow(HttpError);
  });
});

/**
 * The scope every listing query runs in. This exists as one helper for a
 * reason worth locking down: when each route assembled its own literal, the
 * workspace was added to ownership checks but forgotten in the listings, so
 * teammates could open each other's clips by id while the library still
 * showed one person's work. Ownership and listing must widen together.
 */
describe('ownerScope', () => {
  it('carries the workspace, not just the caller', () => {
    const scope = ownerScope(requestWith(principal({ userIds: ['user-1', 'user-2'] })));
    expect(scope).toEqual({ sessionId: 'session-1', userId: 'user-1', userIds: ['user-1', 'user-2'] });
  });

  it('gives a guest a session and no owners', () => {
    const scope = ownerScope(requestWith(principal({ userId: null, userIds: [], sessionId: 'session-9' })));
    expect(scope).toEqual({ sessionId: 'session-9', userId: null, userIds: [] });
  });

  it('is all nulls when there is no principal', () => {
    expect(ownerScope(requestWith(null))).toEqual({ sessionId: null, userId: null, userIds: [] });
  });
});
