import { describe, expect, it } from 'vitest';
import { judgeConnectAttempt } from '../src/services/social/accounts.js';

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
