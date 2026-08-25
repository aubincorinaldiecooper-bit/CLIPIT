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


  // The root cause, found in populr's client against the same API:
  // "Zernio's profile id field is Mongo-style `_id` on most payloads."
  it('reads a Mongo-style _id from the create', async () => {
    createProfile.mockResolvedValue({ _id: 'p-mongo', name: 'clipit-u1' });

    await expect(getOrCreateZernioProfile('u1', 'clipit-u1')).resolves.toBe('p-mongo');
    expect(insertSocialProfile).toHaveBeenCalledWith('u1', 'p-mongo');
    // This is the whole bug: reading `.id` here got undefined and the null
    // reached a NOT NULL column, while the profile existed upstream.
    expect(listProfiles).not.toHaveBeenCalled();
  });

  it('prefers _id over id when a payload carries both', async () => {
    createProfile.mockResolvedValue({ _id: 'p-canonical', id: 'p-legacy' });
    await expect(getOrCreateZernioProfile('u1', 'clipit-u1')).resolves.toBe('p-canonical');
  });

  it('accepts an id that arrives as a number', async () => {
    createProfile.mockResolvedValue({ _id: 4711 });
    await expect(getOrCreateZernioProfile('u1', 'clipit-u1')).resolves.toBe('4711');
  });

  it('matches a listed profile by _id too', async () => {
    createProfile.mockRejectedValue(new ZernioApiError('conflict', 409, null));
    listProfiles.mockResolvedValue([{ _id: 'p-listed', name: 'clipit-u1' }]);

    await expect(getOrCreateZernioProfile('u1', 'clipit-u1')).resolves.toBe('p-listed');
  });

  // Codex, P2 on this PR: an id inside an error body is a REQUEST id, not a
  // profile. Trusting it would persist a non-profile id and aim every later
  // connect at it — the same permanent breakage, by a different route.
  it('never trusts an id found in a refusal body', async () => {
    createProfile.mockRejectedValue(
      new ZernioApiError('Zernio POST /profiles failed with 409', 409, {
        error: { id: 'request-123', message: 'profile exists' },
      }),
    );
    listProfiles.mockResolvedValue([{ _id: 'p-real', name: 'clipit-u1' }]);

    // The name match decides, because it is the only unambiguous evidence.
    await expect(getOrCreateZernioProfile('u1', 'clipit-u1')).resolves.toBe('p-real');
    expect(listProfiles).toHaveBeenCalled();
    expect(insertSocialProfile).toHaveBeenCalledWith('u1', 'p-real');
  });

  it('would rather fail than store an id it cannot vouch for', async () => {
    // A refusal body full of plausible-looking ids, and no matching profile.
    // Failing is correct: a wrong id here is written down forever.
    createProfile.mockRejectedValue(
      new ZernioApiError('conflict', 409, { id: 'req-9', data: { id: 'trace-4' } }),
    );
    listProfiles.mockResolvedValue([{ _id: 'p-other', name: 'clipit-someone-else' }]);

    await expect(getOrCreateZernioProfile('u1', 'clipit-u1')).rejects.toThrow(/usable profile id/);
    expect(insertSocialProfile).not.toHaveBeenCalled();
  });
});
