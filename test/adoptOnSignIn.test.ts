import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A sign-in may carry two claims on a guest's work: the guest token (same
 * tab) and a hand-over (the link opened elsewhere). All of it moves as one
 * transaction: the hand-over redeemed, the guest's session row locked, the
 * work adopted — so a failure leaves the claim usable, two sign-ins at once
 * cannot split one guest's work, an owned session is never taken, and a
 * claim that cannot be honoured never fails the sign-in.
 */

const client = { query: vi.fn() };
const withTransaction = vi.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(client));
const sessions = { findSessionByToken: vi.fn(), adoptSessionWork: vi.fn(), lockSessionForAdoption: vi.fn() };
const redeemHandoff = vi.fn();
const ensureWorkspace = vi.fn();
const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };

vi.mock('../src/db/pool.js', () => ({
  withTransaction: (fn: (c: unknown) => Promise<unknown>) => withTransaction(fn),
}));
vi.mock('../src/db/repositories/sessions.js', () => ({
  findSessionByToken: (...args: unknown[]) => sessions.findSessionByToken(...args),
  adoptSessionWork: (...args: unknown[]) => sessions.adoptSessionWork(...args),
  lockSessionForAdoption: (...args: unknown[]) => sessions.lockSessionForAdoption(...args),
}));
vi.mock('../src/db/repositories/sessionHandoffs.js', () => ({
  redeemHandoff: (...args: unknown[]) => redeemHandoff(...args),
}));
vi.mock('../src/services/workspace/membership.js', () => ({
  ensureWorkspace: (...args: unknown[]) => ensureWorkspace(...args),
}));
vi.mock('../src/lib/logger.js', () => ({ logger }));

const { adoptOnSignIn } = await import('../src/services/session/adoptOnSignIn.js');

const person = { userId: 'user-1', email: 'a@b.c' };

beforeEach(() => {
  vi.clearAllMocks();
  ensureWorkspace.mockResolvedValue({ id: 'ws-1' });
  sessions.lockSessionForAdoption.mockResolvedValue({ userId: null });
  sessions.adoptSessionWork.mockResolvedValue({ videos: 1, clipRequests: 2, clips: 3 });
});

describe('adoptOnSignIn', () => {
  it('adopts through a hand-over alone — the link opened where no guest token exists — for the address it was sent to', async () => {
    redeemHandoff.mockResolvedValueOnce({ sessionId: 'guest-1', userId: null });

    const adopted = await adoptOnSignIn({ ...person, handoff: 'h' });

    expect(redeemHandoff).toHaveBeenCalledWith('h', 'a@b.c', client);
    expect(sessions.lockSessionForAdoption).toHaveBeenCalledWith('guest-1', client);
    expect(sessions.adoptSessionWork).toHaveBeenCalledTimes(1);
    expect(sessions.adoptSessionWork).toHaveBeenCalledWith(
      { sessionId: 'guest-1', userId: 'user-1', workspaceId: 'ws-1' },
      client,
    );
    expect(adopted).toEqual({ videos: 1, clipRequests: 2, clips: 3 });
  });

  it('cannot spend a hand-over without the address the link went to', async () => {
    await adoptOnSignIn({ userId: 'user-1', email: null, handoff: 'h' });
    expect(redeemHandoff).not.toHaveBeenCalled();
    expect(sessions.adoptSessionWork).not.toHaveBeenCalled();
  });

  it('adopts through the guest token alone — the same tab, as before', async () => {
    sessions.findSessionByToken.mockResolvedValueOnce({ id: 'guest-1', userId: null });

    await adoptOnSignIn({ ...person, guestToken: 't' });

    expect(sessions.adoptSessionWork).toHaveBeenCalledTimes(1);
    expect(sessions.adoptSessionWork).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'guest-1' }), client);
    expect(redeemHandoff).not.toHaveBeenCalled();
  });

  it('adopts once when the token and the hand-over name the same session, and still spends the hand-over', async () => {
    sessions.findSessionByToken.mockResolvedValueOnce({ id: 'guest-1', userId: null });
    redeemHandoff.mockResolvedValueOnce({ sessionId: 'guest-1', userId: null });

    const adopted = await adoptOnSignIn({ ...person, guestToken: 't', handoff: 'h' });

    expect(redeemHandoff).toHaveBeenCalledWith('h', 'a@b.c', client);
    expect(sessions.adoptSessionWork).toHaveBeenCalledTimes(1);
    expect(adopted).toEqual({ videos: 1, clipRequests: 2, clips: 3 });
  });

  it('adds up two different guest sessions', async () => {
    sessions.findSessionByToken.mockResolvedValueOnce({ id: 'guest-1', userId: null });
    redeemHandoff.mockResolvedValueOnce({ sessionId: 'guest-2', userId: null });

    const adopted = await adoptOnSignIn({ ...person, guestToken: 't', handoff: 'h' });

    expect(sessions.adoptSessionWork).toHaveBeenCalledTimes(2);
    expect(adopted).toEqual({ videos: 2, clipRequests: 4, clips: 6 });
  });

  it('locks the guest’s session row before moving anything, so two sign-ins at once queue instead of splitting the work', async () => {
    redeemHandoff.mockResolvedValueOnce({ sessionId: 'guest-1', userId: null });
    const order: string[] = [];
    sessions.lockSessionForAdoption.mockImplementationOnce(async () => {
      order.push('lock');
      return { userId: null };
    });
    sessions.adoptSessionWork.mockImplementationOnce(async () => {
      order.push('adopt');
      return { videos: 0, clipRequests: 0, clips: 0 };
    });

    await adoptOnSignIn({ ...person, handoff: 'h' });

    expect(order).toEqual(['lock', 'adopt']);
    expect(withTransaction).toHaveBeenCalledTimes(1);
  });

  it('never takes a session that already belongs to somebody, whichever way it was named', async () => {
    sessions.findSessionByToken.mockResolvedValueOnce({ id: 'owned-1', userId: 'someone-else' });
    redeemHandoff.mockResolvedValueOnce({ sessionId: 'owned-2', userId: 'someone-else' });

    const adopted = await adoptOnSignIn({ ...person, guestToken: 't', handoff: 'h' });

    expect(sessions.adoptSessionWork).not.toHaveBeenCalled();
    expect(ensureWorkspace).not.toHaveBeenCalled();
    expect(adopted).toBeNull();
  });

  it('takes nothing when the locked row turns out owned, or gone, by the time the lock is held', async () => {
    redeemHandoff.mockResolvedValueOnce({ sessionId: 'guest-1', userId: null });
    sessions.lockSessionForAdoption.mockResolvedValueOnce({ userId: 'the-other-sign-in' });

    expect(await adoptOnSignIn({ ...person, handoff: 'h' })).toBeNull();
    expect(sessions.adoptSessionWork).not.toHaveBeenCalled();

    redeemHandoff.mockResolvedValueOnce({ sessionId: 'guest-1', userId: null });
    sessions.lockSessionForAdoption.mockResolvedValueOnce(null);

    expect(await adoptOnSignIn({ ...person, handoff: 'h' })).toBeNull();
    expect(sessions.adoptSessionWork).not.toHaveBeenCalled();
  });

  it('takes nothing on an unknown, spent, expired, or misaddressed hand-over', async () => {
    redeemHandoff.mockResolvedValueOnce(null);
    expect(await adoptOnSignIn({ ...person, handoff: 'stale' })).toBeNull();
    expect(sessions.adoptSessionWork).not.toHaveBeenCalled();
  });

  it('has nothing to do with no claim at all', async () => {
    expect(await adoptOnSignIn(person)).toBeNull();
    expect(sessions.findSessionByToken).not.toHaveBeenCalled();
    expect(redeemHandoff).not.toHaveBeenCalled();
  });

  it('never fails the sign-in: an adoption error escapes the transaction — undoing the redemption with it — and is logged without its details', async () => {
    redeemHandoff.mockResolvedValueOnce({ sessionId: 'guest-1', userId: null });
    sessions.adoptSessionWork.mockRejectedValueOnce(new Error('connection reset: token=secret'));

    const adopted = await adoptOnSignIn({ ...person, handoff: 'h' });

    expect(adopted).toBeNull();
    // The error left the transaction callback, which is what makes
    // withTransaction roll the redemption back.
    await expect(withTransaction.mock.results[0]!.value).rejects.toThrow('connection reset');
    expect(logger.error).toHaveBeenCalledWith('could not adopt guest work on sign-in', { name: 'Error' });
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
  });
});
