import { describe, expect, it } from 'vitest';
import { judgeConnectAttempt, newlyConnected } from '../src/services/social/accounts.js';

/**
 * The OAuth callback may only say "connected" for something THIS attempt
 * changed. These are the honesty cases: a canceled second-account flow must
 * not borrow an older account's connected status, and a reconnect that
 * flipped a lapsed account back counts as a real success.
 */
describe('judgeConnectAttempt', () => {
  it('reports connected when a new account appeared', () => {
    expect(judgeConnectAttempt([], [{ id: 'a1', status: 'connected' }])).toBe('connected');
  });

  it('reports connected when an existing account came back from reconnect_required', () => {
    expect(
      judgeConnectAttempt([{ id: 'a1', status: 'reconnect_required' }], [{ id: 'a1', status: 'connected' }]),
    ).toBe('connected');
  });

  it('reports connected when a disconnected account was reconnected', () => {
    expect(judgeConnectAttempt([{ id: 'a1', status: 'disconnected' }], [{ id: 'a1', status: 'connected' }])).toBe(
      'connected',
    );
  });

  it('does not let a canceled attempt ride an older connection', () => {
    // Same connected account before and after: nothing about this attempt
    // succeeded, and saying "connected" would report an absence of failure
    // that was never verified.
    expect(judgeConnectAttempt([{ id: 'a1', status: 'connected' }], [{ id: 'a1', status: 'connected' }])).toBe(
      'nothing_new',
    );
  });

  it('reports failed when nothing was connected before or after', () => {
    expect(judgeConnectAttempt([], [])).toBe('failed');
  });

  it('reports failed when the only account is still not connected', () => {
    expect(
      judgeConnectAttempt([{ id: 'a1', status: 'reconnect_required' }], [{ id: 'a1', status: 'reconnect_required' }]),
    ).toBe('failed');
  });

  it('spots a second account joining an already-connected platform', () => {
    expect(
      judgeConnectAttempt(
        [{ id: 'a1', status: 'connected' }],
        [
          { id: 'a1', status: 'connected' },
          { id: 'a2', status: 'connected' },
        ],
      ),
    ).toBe('connected');
  });
});

describe('newlyConnected', () => {
  // A person connects a page, not a platform. With two accounts on one
  // platform, "Instagram is connected" cannot say which was just added — so
  // the confirmation names the account, and this decides which one that is.
  const row = (id: string, status: string, display_name: string | null = null) =>
    ({ id, status, display_name }) as never;

  it('picks the account that did not exist before', () => {
    const before = [row('a1', 'connected', 'first')];
    const after = [row('a1', 'connected', 'first'), row('a2', 'connected', 'second')];
    expect(newlyConnected(before, after)?.id).toBe('a2');
  });

  it('picks the one that came back from a broken state — a reconnect', () => {
    const before = [row('a1', 'reconnect_required', 'mine')];
    const after = [row('a1', 'connected', 'mine')];
    expect(newlyConnected(before, after)?.id).toBe('a1');
  });

  it('prefers a genuinely new account over a reconnected one', () => {
    const before = [row('a1', 'reconnect_required')];
    const after = [row('a1', 'connected'), row('a2', 'connected')];
    expect(newlyConnected(before, after)?.id).toBe('a2');
  });

  it('names nobody when nothing changed', () => {
    const same = [row('a1', 'connected')];
    expect(newlyConnected(same, same)).toBeNull();
  });

  it('never names an account that is not connected', () => {
    const after = [row('a1', 'reconnect_required'), row('a2', 'disconnected')];
    expect(newlyConnected([], after)).toBeNull();
  });
});
