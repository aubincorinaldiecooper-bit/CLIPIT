import { zernio } from '../zernio/client.js';
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
 */
export async function getOrCreateZernioProfile(userId: string, label: string): Promise<string> {
  const existing = await getSocialProfile(userId);
  if (existing) return existing.zernio_profile_id;
  const created = await zernio.createProfile({ name: label });
  const row = await insertSocialProfile(userId, created.id);
  return row.zernio_profile_id;
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
export async function syncAccounts(userId: string, zernioProfileId: string): Promise<SocialAccountRow[]> {
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

/**
 * The post-sync verification borrowed from populr: the upsert above is
 * in-memory proof of a write, not proof the user can see it. Re-reading
 * through the exact user-scoped path the API serves is what lets a callback
 * say "connected" and mean it.
 */
export async function verifyConnected(userId: string, platform: string): Promise<boolean> {
  const rows = await listSocialAccounts(userId, { platform });
  return rows.some((row) => row.status === 'connected');
}
