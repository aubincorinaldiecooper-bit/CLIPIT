import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Connecting an account could fail forever.
 *
 * Both cases here are taken from real production failures on one account,
 * thirty seconds apart, and they are the same story told twice: the profile
 * exists upstream, nothing local points at it, and every attempt to make one
 * is refused. Before the fix that state was terminal — the Publishing page
 * showed "Something went wrong handling this request" and no amount of
 * retrying could ever clear it.
 */

const createProfile = vi.fn();
const listProfiles = vi.fn();
const getSocialProfile = vi.fn();
const insertSocialProfile = vi.fn();

vi.mock('../src/services/zernio/client.js', async () => {
  // The real error class: the code under test branches on `instanceof`, so a
  // stand-in would let a broken check pass.
  const actual = await vi.importActual<typeof import('../src/services/zernio/client.js')>(
    '../src/services/zernio/client.js',
  );
  return {
    ...actual,
    zernio: {
      createProfile: (...args: unknown[]) => createProfile(...args),
      listProfiles: (...args: unknown[]) => listProfiles(...args),
    },
  };
});

vi.mock('../src/db/repositories/social.js', () => ({
  getSocialProfile: (...args: unknown[]) => getSocialProfile(...args),
  insertSocialProfile: (...args: unknown[]) => insertSocialProfile(...args),
  listSocialAccounts: vi.fn(),
  upsertSocialAccount: vi.fn(),
}));

const { getOrCreateZernioProfile } = await import('../src/services/social/accounts.js');
const { ZernioApiError } = await import('../src/services/zernio/client.js');

describe('getOrCreateZernioProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSocialProfile.mockResolvedValue(null);
    insertSocialProfile.mockImplementation(async (_userId: string, id: string) => ({
      user_id: 'u1',
      zernio_profile_id: id,
    }));
  });

  it('uses the local row and never calls the provider when one already exists', async () => {
    getSocialProfile.mockResolvedValue({ user_id: 'u1', zernio_profile_id: 'p-known' });

    await expect(getOrCreateZernioProfile('u1', 'clipit-u1')).resolves.toBe('p-known');
    expect(createProfile).not.toHaveBeenCalled();
    expect(listProfiles).not.toHaveBeenCalled();
  });

  it('stores the id from a normal create', async () => {
    createProfile.mockResolvedValue({ id: 'p-new', name: 'clipit-u1' });

    await expect(getOrCreateZernioProfile('u1', 'clipit-u1')).resolves.toBe('p-new');
    expect(insertSocialProfile).toHaveBeenCalledWith('u1', 'p-new');
    expect(listProfiles).not.toHaveBeenCalled();
  });

  // Production: GET /api/connect/instagram → "Zernio POST /profiles failed with 409"
  it('adopts the existing profile when the create is refused as a duplicate', async () => {
    createProfile.mockRejectedValue(new ZernioApiError('Zernio POST /profiles failed with 409', 409, null));
    listProfiles.mockResolvedValue([
      { id: 'p-other', name: 'clipit-someone-else' },
      { id: 'p-mine', name: 'clipit-u1' },
    ]);

    await expect(getOrCreateZernioProfile('u1', 'clipit-u1')).resolves.toBe('p-mine');
    expect(insertSocialProfile).toHaveBeenCalledWith('u1', 'p-mine');
  });

  // Production: GET /api/connect/youtube → null value in column "zernio_profile_id"
  it('never puts an unusable id into the column', async () => {
    // The create succeeded upstream but answered in a shape with no id where
    // we look — which is how the profile came to exist with no local row.
    createProfile.mockResolvedValue({ created: true });
    listProfiles.mockResolvedValue([{ id: 'p-recovered', name: 'clipit-u1' }]);

    await expect(getOrCreateZernioProfile('u1', 'clipit-u1')).resolves.toBe('p-recovered');
    expect(insertSocialProfile).toHaveBeenCalledWith('u1', 'p-recovered');
    // The specific crash: insert must never be reached with a null/undefined id.
    for (const call of insertSocialProfile.mock.calls) {
      expect(typeof call[1]).toBe('string');
      expect(call[1]).not.toBe('');
    }
  });

  it('rejects the string "undefined" as an id rather than storing it', async () => {
    createProfile.mockResolvedValue({ id: 'undefined' });
    listProfiles.mockResolvedValue([{ id: 'p-real', name: 'clipit-u1' }]);

    await expect(getOrCreateZernioProfile('u1', 'clipit-u1')).resolves.toBe('p-real');
  });

  it('fails clearly when no id can be had, rather than writing a null', async () => {
    createProfile.mockResolvedValue({});
    listProfiles.mockResolvedValue([{ id: 'p-someone', name: 'clipit-not-me' }]);

    await expect(getOrCreateZernioProfile('u1', 'clipit-u1')).rejects.toThrow(/usable profile id/);
    expect(insertSocialProfile).not.toHaveBeenCalled();
  });

  it('does not swallow a real provider failure as a duplicate', async () => {
    // A 500 upstream is not "the profile already exists" — retrying against a
    // profile list would hide a genuine outage behind a confusing error.
    createProfile.mockRejectedValue(new ZernioApiError('Zernio POST /profiles failed with 500', 500, null));

    await expect(getOrCreateZernioProfile('u1', 'clipit-u1')).rejects.toThrow(/500/);
    expect(listProfiles).not.toHaveBeenCalled();
    expect(insertSocialProfile).not.toHaveBeenCalled();
  });

  it('matches the label exactly, never a prefix of someone else', async () => {
    createProfile.mockRejectedValue(new ZernioApiError('Zernio POST /profiles failed with 409', 409, null));
    listProfiles.mockResolvedValue([{ id: 'p-longer', name: 'clipit-u1-extra' }]);

    await expect(getOrCreateZernioProfile('u1', 'clipit-u1')).rejects.toThrow(/usable profile id/);
    expect(insertSocialProfile).not.toHaveBeenCalled();
  });

  // The failure that sent me looking: a friendly message with no log behind
  // it, and a recovery whose own error replaced the one that mattered.
  it('reads the id out of a duplicate refusal, without a second call', async () => {
    // A 409 usually names what it collided with. If the id is right there,
    // the profile-list lookup should never happen.
    createProfile.mockRejectedValue(
      new ZernioApiError('Zernio POST /profiles failed with 409', 409, {
        error: { message: 'profile already exists', profileId: 'p-from-conflict' },
      }),
    );

    await expect(getOrCreateZernioProfile('u1', 'clipit-u1')).resolves.toBe('p-from-conflict');
    expect(listProfiles).not.toHaveBeenCalled();
  });

  it('finds a nested id in a duplicate refusal', async () => {
    createProfile.mockRejectedValue(
      new ZernioApiError('conflict', 409, { data: { profile: { id: 'p-nested' } } }),
    );
    await expect(getOrCreateZernioProfile('u1', 'clipit-u1')).resolves.toBe('p-nested');
  });

  it('reports the DUPLICATE, not the lookup failure, when recovery cannot run', async () => {
    // This is the live bug: create said 409 (recoverable, and informative),
    // the profile-list lookup then failed, and the lookup's error became the
    // message. Someone was told the service was down when in fact their
    // profile existed and we could not look it up.
    createProfile.mockRejectedValue(new ZernioApiError('Zernio POST /profiles failed with 409', 409, null));
    listProfiles.mockRejectedValue(new ZernioApiError('Zernio GET /profiles failed with 500', 500, null));

    await expect(getOrCreateZernioProfile('u1', 'clipit-u1')).rejects.toThrow(/409/);
    expect(insertSocialProfile).not.toHaveBeenCalled();
  });

  it('reports the lookup failure when there was no duplicate to report', async () => {
    // Create succeeded with an unreadable body, so there is no earlier error
    // to prefer — here the lookup's own failure IS the story.
    createProfile.mockResolvedValue({ created: true });
    listProfiles.mockRejectedValue(new ZernioApiError('Zernio GET /profiles failed with 503', 503, null));

    await expect(getOrCreateZernioProfile('u1', 'clipit-u1')).rejects.toThrow(/503/);
  });

  it('never returns a secret pulled out of an error body', async () => {
    // idFromBody walks the body looking for an id. It must not come back with
    // a token because the provider put one on the same object.
    createProfile.mockRejectedValue(
      new ZernioApiError('conflict', 409, { access_token: 'sk-live-SECRET', id: 'p-ok' }),
    );
    const result = await getOrCreateZernioProfile('u1', 'clipit-u1');
    expect(result).toBe('p-ok');
    expect(result).not.toContain('SECRET');
  });
});
