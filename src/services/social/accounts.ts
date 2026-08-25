import { logger } from '../../lib/logger.js';
import { zernio, ZernioApiError } from '../zernio/client.js';
import {
  getSocialProfile,
  insertSocialProfile,
  listSocialAccounts,
  upsertSocialAccount,
  type SocialAccountRow,
} from '../../db/repositories/social.js';
import type { ZernioAccount } from '../zernio/types.js';

/**
 * The platforms CLIPIT publishes to — exactly what the Publishing page
 * promises, no more. Zernio supports others; widening this list is a product
 * decision, not a config change.
 */
export const PUBLISH_PLATFORMS = ['tiktok', 'youtube', 'instagram'] as const;
export type PublishPlatform = (typeof PUBLISH_PLATFORMS)[number];

export function isPublishPlatform(value: string): value is PublishPlatform {
  return (PUBLISH_PLATFORMS as readonly string[]).includes(value);
}

/**
 * One Zernio workspace per signed-in user, created on first use. Two racing
 * first-uses converge on one row (see insertSocialProfile); the loser's
 * Zernio profile is orphaned upstream, which is harmless.
 *
 * The local row and the upstream profile can disagree, and when they did this
 * used to be unrecoverable — connecting any account failed forever with a
 * 500. The label is deterministic (`clipit-<user>`), so once a profile exists
 * upstream without a local row pointing at it, every later create is refused
 * as a duplicate. Two real production failures, minutes apart on one account:
 *
 *   GET /api/connect/youtube    → null value in column "zernio_profile_id"
 *                                 violates not-null constraint
 *   GET /api/connect/instagram  → Zernio POST /profiles failed with 409
 *
 * They are one story. The first create SUCCEEDED upstream but returned a body
 * with no id where we look for one; the unchecked `created.id` went into the
 * insert as null and threw, so nothing was saved locally while the profile
 * now existed remotely. Every attempt after that hit 409.
 *
 * So: the id is validated before it is trusted, and a create that cannot
 * produce one — refused as a duplicate, or answered in an unexpected shape —
 * falls back to finding the profile that is already there. Adopting an
 * existing profile is right rather than merely convenient: it is this user's
 * own profile, under a name derived from their own id.
 */
export async function getOrCreateZernioProfile(userId: string, label: string): Promise<string> {
  const existing = await getSocialProfile(userId);
  if (existing) return existing.zernio_profile_id;

  let profileId: string | null = null;
  /** What the create actually said, kept so a failed RECOVERY cannot replace it. */
  let createFailure: unknown = null;

  try {
    const created = await zernio.createProfile({ name: label });
    // Never trust the id straight into the column: an unusable one used to
    // surface as a not-null constraint violation, which reads as a database
    // fault when it is really an unexpected response shape.
    if (usableZernioId(created?.id)) {
      profileId = created.id;
    } else {
      // The original bug, and the one branch here that could still pass in
      // silence: the create SUCCEEDED and we could not find an id in what it
      // said. Worth a line, because it means a profile now exists upstream
      // that nothing local points at. Keys only — never the values, which is
      // where a token would be.
      logger.warn('profile create returned no usable id', {
        keys: created && typeof created === 'object' ? Object.keys(created).slice(0, 12) : [],
      });
    }
  } catch (cause) {
    // Only the STATUS decides control flow. The body is never logged or
    // forwarded — but reading an id out of it is not the same as exposing it,
    // and a duplicate refusal is exactly where the id we need tends to be.
    const duplicate = cause instanceof ZernioApiError && (cause.status === 409 || cause.status === 422);
    if (!duplicate) throw cause;
    createFailure = cause;
    profileId = idFromBody((cause as ZernioApiError).body);
  }

  // Still nothing: ask for the profile by name. This is a SECOND recovery,
  // and it leans on GET /profiles — a route this client did not previously
  // use, so it cannot be assumed to behave.
  if (!profileId) {
    try {
      profileId = await findExistingProfileId(label);
    } catch (lookupFailure) {
      // A recovery that fails must not become the story. Reporting the lookup's
      // error would tell someone the service is down when the truth is that
      // their profile already exists and we could not look it up — a different
      // problem with a different fix.
      logger.warn('profile lookup failed while recovering from a duplicate', {
        status: lookupFailure instanceof ZernioApiError ? lookupFailure.status : null,
        name: lookupFailure instanceof Error ? lookupFailure.name : 'unknown',
      });
      throw createFailure ?? lookupFailure;
    }
  }

  if (!profileId) {
    throw new ZernioApiError(
      'Zernio did not return a usable profile id, and no existing profile matched',
      502,
      null,
    );
  }

  const row = await insertSocialProfile(userId, profileId);
  return row.zernio_profile_id;
}

/**
 * An id out of a response body, wherever the provider chose to put it.
 *
 * A duplicate refusal usually names the thing it collided with, and that is
 * the id we need. The body is READ here and never logged or returned — the
 * error class exists precisely so callers can inspect it.
 */
function idFromBody(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  for (const key of ['id', 'profileId', 'profile_id', 'existingId', 'existing_id']) {
    if (usableZernioId(record[key])) return record[key] as string;
  }
  // One level down, for {profile: {...}} / {data: {...}} / {error: {...}}.
  for (const key of ['profile', 'data', 'error', 'details']) {
    const nested = record[key];
    if (nested && typeof nested === 'object') {
      const found = idFromBody(nested);
      if (found) return found;
    }
  }
  return null;
}

/** The id of the profile already carrying this exact label, if there is one. */
async function findExistingProfileId(label: string): Promise<string | null> {
  const profiles = await zernio.listProfiles();
  for (const profile of profiles) {
    if (profile?.name === label && usableZernioId(profile.id)) return profile.id;
  }
  return null;
}

/** A Zernio id that can be safely placed in a request path. */
function usableZernioId(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value !== 'undefined' && value !== 'null';
}

/**
 * Fetch the user's connected accounts from Zernio, keep the platforms CLIPIT
 * publishes to, and mirror them locally. A malformed remote record is
 * skipped, never persisted, and never allowed to abort the rest of the sync.
 */
export async function syncAccounts(
  userId: string,
  zernioProfileId: string,
  workspaceId: string | null,
): Promise<SocialAccountRow[]> {
  const remote = await zernio.listAccounts({ profileId: zernioProfileId });
  const stored: SocialAccountRow[] = [];
  for (const raw of remote) {
    const account = raw as ZernioAccount;
    const id = usableZernioId(account.id) ? account.id : usableZernioId(account.accountId) ? account.accountId : null;
    const platform = typeof account.platform === 'string' ? account.platform.toLowerCase() : null;
    if (!id || !platform || !isPublishPlatform(platform)) continue;
    stored.push(
      await upsertSocialAccount({
        id,
        userId,
        // The room the connect flow was started from, carried on the state
        // token — not wherever the person happens to be standing now.
        workspaceId,
        platform,
        displayName:
          (typeof account.displayName === 'string' && account.displayName) ||
          (typeof account.name === 'string' && account.name) ||
          (typeof account.username === 'string' && account.username) ||
          null,
        status: 'connected',
      }),
    );
  }
  return stored;
}

export type ConnectAttemptOutcome = 'connected' | 'nothing_new' | 'failed';

/**
 * The post-sync verification borrowed from populr, sharpened to judge THIS
 * attempt rather than the platform in general: re-read through the exact
 * user-scoped path the API serves and compare against a snapshot taken
 * before the sync. "Connected" means this attempt visibly changed something
 * — a new account appeared, or an existing one came back to connected. An
 * attempt that changed nothing while an old account was already connected is
 * 'nothing_new', never a fresh success: a canceled OAuth must not ride an
 * earlier connection's coattails.
 */
export async function verifyConnectAttempt(
  workspaceId: string,
  platform: string,
  before: SocialAccountRow[],
): Promise<ConnectAttemptOutcome> {
  const after = await listSocialAccounts(workspaceId, { platform });
  return judgeConnectAttempt(before, after);
}

/** The pure decision, separated so it can be tested without a database. */
export function judgeConnectAttempt(
  before: Pick<SocialAccountRow, 'id' | 'status'>[],
  after: Pick<SocialAccountRow, 'id' | 'status'>[],
): ConnectAttemptOutcome {
  const beforeStatusById = new Map(before.map((row) => [row.id, row.status]));

  const changed = after.some((row) => {
    if (row.status !== 'connected') return false;
    const previous = beforeStatusById.get(row.id);
    return previous === undefined || previous !== 'connected';
  });
  if (changed) return 'connected';

  const alreadyConnected = before.some((row) => row.status === 'connected');
  return alreadyConnected ? 'nothing_new' : 'failed';
}
