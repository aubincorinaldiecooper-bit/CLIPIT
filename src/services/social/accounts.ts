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
    profileId = pickId(created, ['profileId', 'profile_id']);
    if (!profileId) {
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
    // Deliberately NOT scraped out of the refusal body. Codex caught what
    // that costs: a body like {error: {id: "request-123", message: "profile
    // exists"}} yields a REQUEST id, and this function's result is written to
    // social_profiles permanently — every later connect would then aim at an
    // id that is not a profile. That is the same permanent breakage this
    // whole change exists to end, reintroduced by a different route.
    //
    // The name lookup below is not a guess: it matches the exact label this
    // user's profile is created under. It was written as insurance against
    // GET /profiles perhaps not existing; populr uses that route against the
    // same API, so the insurance is not needed and the guess is not worth
    // its risk.
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

/** The id of the profile already carrying this exact label, if there is one. */
async function findExistingProfileId(label: string): Promise<string | null> {
  const profiles = await zernio.listProfiles();
  for (const profile of profiles) {
    const id = pickId(profile, ['profileId', 'profile_id']);
    if (id && profile?.name === label) return id;
  }
  return null;
}

/**
 * A Zernio id that can be safely placed in a request path.
 *
 * Trimmed and case-folded before the placeholder check. populr's equivalent
 * learned this the hard way — its comment records that a pre-fix
 * `String(account.id)` normalisation could persist the literal string
 * "undefined", and a case-sensitive comparison lets "Undefined" through to be
 * stored and then sent back as a request path.
 *
 * Exported for the same reason populr exports theirs: a caller acting on an
 * ALREADY-STORED id needs to refuse it too, not just guard what comes in.
 */
export function usableZernioId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim().toLowerCase();
  return trimmed !== '' && trimmed !== 'undefined' && trimmed !== 'null';
}

/**
 * The id off a Zernio record, whichever key it came under.
 *
 * THE bug, and it cost a working publishing flow: Zernio's ids are Mongo-style
 * `_id` on most payloads. This code read `.id`, got undefined, and pushed a
 * null into a NOT NULL column — while the profile it had just created sat
 * there upstream with nothing pointing at it. Every attempt afterwards was
 * refused as a duplicate, permanently.
 *
 * Confirmed against populr's client, which talks to the same API and has
 * always picked `_id` first:
 *
 *   "Zernio's profile id field is Mongo-style `_id` on most payloads; some
 *    hand-built fallback records and other Zernio endpoints use plain `id`."
 *
 * Numbers count: an id that arrives as 1234 is still an id.
 */
function pickId(record: unknown, extraKeys: string[] = []): string | null {
  if (!record || typeof record !== 'object') return null;
  const source = record as Record<string, unknown>;
  for (const key of ['_id', 'id', ...extraKeys]) {
    const value = source[key];
    if (typeof value === 'string' && value.trim() !== '') {
      const trimmed = value.trim();
      if (usableZernioId(trimmed)) return trimmed;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
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
    // The same `_id` bug lived here: an account whose id arrives as `_id`
    // was silently skipped, so a connection that genuinely succeeded upstream
    // mirrored as nothing and the flow reported "account_sync_failed".
    const id = pickId(account, ['accountId', 'account_id']);
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
): Promise<{ outcome: ConnectAttemptOutcome; account: SocialAccountRow | null }> {
  const after = await listSocialAccounts(workspaceId, { platform });
  const outcome = judgeConnectAttempt(before, after);
  // WHICH account this attempt connected, not merely that one did. A person
  // connects a page, not a platform — and with several accounts on the same
  // platform, "Instagram is connected" cannot tell them which one they just
  // added. Only reported for a real success; on any other outcome there is no
  // account to name and guessing one would be worse than saying nothing.
  return { outcome, account: outcome === 'connected' ? newlyConnected(before, after) : null };
}

/**
 * The account this attempt actually brought in, if it can be identified.
 *
 * Exported for the same reason judgeConnectAttempt is: the decision is pure,
 * and a decision worth making is worth testing without a database.
 */
export function newlyConnected(
  before: SocialAccountRow[],
  after: SocialAccountRow[],
): SocialAccountRow | null {
  const beforeStatusById = new Map(before.map((row) => [row.id, row.status]));
  // Prefer an account that did not exist before; fall back to one that came
  // back FROM a broken state, which is what a reconnect looks like.
  const fresh = after.find((row) => row.status === 'connected' && !beforeStatusById.has(row.id));
  if (fresh) return fresh;
  return (
    after.find(
      (row) => row.status === 'connected' && beforeStatusById.get(row.id) !== 'connected',
    ) ?? null
  );
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
