import { createHash, randomBytes } from 'node:crypto';
import { queryOne, queryRows } from '../pool.js';

/**
 * Rows for the Zernio-backed publishing plumbing (migration 016). Everything
 * here belongs to a signed-in user — never a guest session; see the
 * migration's header for why.
 */

export interface SocialProfileRow {
  user_id: string;
  zernio_profile_id: string;
}

export interface SocialAccountRow {
  id: string;
  user_id: string;
  platform: string;
  display_name: string | null;
  status: string;
  created_at: Date;
}

export interface ConnectionStateRow {
  id: string;
  user_id: string;
  platform: string;
  expires_at: Date;
}

export interface PublishedPostRow {
  id: string;
  user_id: string;
  clip_id: string | null;
  zernio_post_id: string | null;
  caption: string;
  targets: unknown;
  status: string;
  created_at: Date;
}

// --- profiles ---------------------------------------------------------------

export async function getSocialProfile(userId: string): Promise<SocialProfileRow | null> {
  return queryOne<SocialProfileRow>('SELECT user_id, zernio_profile_id FROM social_profiles WHERE user_id = $1', [
    userId,
  ]);
}

export async function insertSocialProfile(userId: string, zernioProfileId: string): Promise<SocialProfileRow> {
  // Two racing first-uses must converge on ONE Zernio profile per user; on
  // conflict the existing row wins and is returned unchanged.
  const row = await queryOne<SocialProfileRow>(
    `INSERT INTO social_profiles (user_id, zernio_profile_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET user_id = social_profiles.user_id
     RETURNING user_id, zernio_profile_id`,
    [userId, zernioProfileId],
  );
  return row!;
}

// --- accounts ---------------------------------------------------------------

export async function upsertSocialAccount(input: {
  id: string;
  userId: string;
  platform: string;
  displayName: string | null;
  status: string;
}): Promise<SocialAccountRow> {
  // Ownership follows the profile-scoped sync that produced this write: the
  // account id is Zernio's, and if it later shows up under a different user's
  // Zernio profile, the row moves to that user. Keeping the old user_id would
  // quietly reactivate the row for its previous owner while the new owner's
  // verification fails — the cross-user case this clause exists to prevent.
  const row = await queryOne<SocialAccountRow>(
    `INSERT INTO social_accounts (id, user_id, platform, display_name, status)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE
        SET user_id = EXCLUDED.user_id,
            platform = EXCLUDED.platform,
            display_name = EXCLUDED.display_name,
            status = EXCLUDED.status,
            updated_at = now()
     RETURNING id, user_id, platform, display_name, status, created_at`,
    [input.id, input.userId, input.platform, input.displayName, input.status],
  );
  return row!;
}

/**
 * The accounts a caller may publish to. `userIds` is the workspace: a team
 * shares its connected accounts, so a teammate's TikTok is one of ours. Given
 * a bare user id, it is a workspace of one.
 */
export async function listSocialAccounts(
  userIdOrIds: string | string[],
  filter: { platform?: string } = {},
): Promise<SocialAccountRow[]> {
  const owners = Array.isArray(userIdOrIds) ? userIdOrIds : [userIdOrIds];
  if (owners.length === 0) return [];
  if (filter.platform) {
    return queryRows<SocialAccountRow>(
      `SELECT id, user_id, platform, display_name, status, created_at
         FROM social_accounts WHERE user_id = ANY($1::text[]) AND platform = $2
        ORDER BY created_at DESC`,
      [owners, filter.platform],
    );
  }
  return queryRows<SocialAccountRow>(
    `SELECT id, user_id, platform, display_name, status, created_at
       FROM social_accounts WHERE user_id = ANY($1::text[])
      ORDER BY created_at DESC`,
    [owners],
  );
}

export async function getSocialAccount(id: string): Promise<SocialAccountRow | null> {
  return queryOne<SocialAccountRow>(
    'SELECT id, user_id, platform, display_name, status, created_at FROM social_accounts WHERE id = $1',
    [id],
  );
}

export async function setSocialAccountStatus(id: string, status: string): Promise<SocialAccountRow | null> {
  return queryOne<SocialAccountRow>(
    `UPDATE social_accounts SET status = $2, updated_at = now()
      WHERE id = $1
      RETURNING id, user_id, platform, display_name, status, created_at`,
    [id, status],
  );
}

// --- connection states (single-use OAuth round-trip tokens) -----------------

/** SHA-256 hex — deterministic so a callback's raw token can be looked up by
 *  hash, one-way so a DB read can't be replayed as a valid token. */
function hashStateToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Mint a state row and return the RAW token, shown to no one but Zernio via
 * the redirect URL. Never stored raw — only its hash goes in the table.
 */
export async function createConnectionState(input: {
  userId: string;
  platform: string;
  ttlSeconds: number;
}): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await queryOne(
    `INSERT INTO social_connection_states (token_hash, user_id, platform, expires_at)
     VALUES ($1, $2, $3, now() + ($4 || ' seconds')::interval)
     RETURNING id`,
    [hashStateToken(token), input.userId, input.platform, String(input.ttlSeconds)],
  );
  return token;
}

/**
 * Atomically consume a state token: one UPDATE makes "check and spend" a
 * single indivisible step, so two callbacks racing on the same token cannot
 * both succeed, and an expired or reused token returns null rather than a
 * usable row.
 */
export async function consumeConnectionState(token: string): Promise<ConnectionStateRow | null> {
  return queryOne<ConnectionStateRow>(
    `UPDATE social_connection_states
        SET consumed_at = now()
      WHERE token_hash = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING id, user_id, platform, expires_at`,
    [hashStateToken(token)],
  );
}

// --- published posts --------------------------------------------------------

export async function insertPublishedPost(input: {
  userId: string;
  clipId: string;
  zernioPostId: string | null;
  caption: string;
  targets: unknown;
  status: string;
}): Promise<PublishedPostRow> {
  const row = await queryOne<PublishedPostRow>(
    `INSERT INTO published_posts (user_id, clip_id, zernio_post_id, caption, targets, status)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING id, user_id, clip_id, zernio_post_id, caption, targets, status, created_at`,
    [input.userId, input.clipId, input.zernioPostId, input.caption, JSON.stringify(input.targets), input.status],
  );
  return row!;
}

export async function updatePublishedPost(
  id: string,
  input: { zernioPostId: string | null; status: string },
): Promise<PublishedPostRow | null> {
  return queryOne<PublishedPostRow>(
    `UPDATE published_posts SET zernio_post_id = $2, status = $3
      WHERE id = $1
      RETURNING id, user_id, clip_id, zernio_post_id, caption, targets, status, created_at`,
    [id, input.zernioPostId, input.status],
  );
}

/**
 * The most recent record still in 'submitting' for this clip, if it is fresh
 * enough to be the same publish attempt. This is the retry guard: a client
 * that lost the response and tries again gets a conflict, not a second
 * public post on every account.
 */
export async function findInFlightPublish(
  userId: string,
  clipId: string,
  withinSeconds: number,
): Promise<PublishedPostRow | null> {
  return queryOne<PublishedPostRow>(
    `SELECT id, user_id, clip_id, zernio_post_id, caption, targets, status, created_at
       FROM published_posts
      WHERE user_id = $1 AND clip_id = $2 AND status = 'submitting'
        AND created_at > now() - ($3 || ' seconds')::interval
      ORDER BY created_at DESC LIMIT 1`,
    [userId, clipId, String(withinSeconds)],
  );
}

/**
 * Webhook-driven status update: Zernio only knows its own post id, so the
 * lookup is by zernio_post_id (no user in a webhook to scope by — trust
 * rests entirely on the verified signature). Returns the updated row count.
 */
export async function updatePublishedPostStatusByZernioId(zernioPostId: string, status: string): Promise<number> {
  const rows = await queryRows<{ id: string }>(
    `UPDATE published_posts SET status = $2
      WHERE zernio_post_id = $1
      RETURNING id`,
    [zernioPostId, status],
  );
  return rows.length;
}

export async function listPublishedPosts(userId: string, limit = 50): Promise<PublishedPostRow[]> {
  return queryRows<PublishedPostRow>(
    `SELECT id, user_id, clip_id, zernio_post_id, caption, targets, status, created_at
       FROM published_posts WHERE user_id = $1
      ORDER BY created_at DESC LIMIT $2`,
    [userId, limit],
  );
}
