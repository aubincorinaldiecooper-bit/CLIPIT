import { ExternalServiceError } from '../../lib/errors.js';
import { getStorage } from '../storage/s3.js';

/**
 * What the remote container is allowed to cache a downloaded video under.
 *
 * The obvious answer — the storage key — is wrong, and wrong in the worst
 * way. Clipit's derived keys are deterministic: an analysis proxy always
 * lives at `proxies/{videoId}/proxy.mp4`. Re-processing a video overwrites
 * that object and the key does not move. A warm Modal container holding the
 * previous file would go on embedding the OLD footage, and every vector it
 * produced would be well formed, correctly normalized, attached to real
 * timestamps, and about a video that no longer exists. Nothing downstream
 * could possibly notice.
 *
 * So the identity carries the store's own tag for the CONTENT as well. It
 * changes when the bytes change, which is exactly the property needed.
 *
 * The signed URL is deliberately NOT part of it — the opposite mistake, and
 * just as bad in the other direction. A fresh URL is minted for every request,
 * so a URL-keyed cache would miss every single time and re-download the same
 * file for every batch of windows.
 *
 * Over-invalidating is safe: the worst case is one extra download. Under-
 * invalidating silently indexes the wrong video. When the store offers no
 * tag, this refuses rather than falling back to the key alone.
 */
export async function sourceIdentity(storageKey: string): Promise<string> {
  const object = await getStorage().head(storageKey);
  if (!object) {
    throw new ExternalServiceError('storage', `Nothing in storage at ${storageKey}`, { retryable: false });
  }
  if (!object.etag) {
    // Refusing beats guessing. A cache identity that cannot tell two versions
    // of the same key apart is worse than no cache at all, because it fails
    // silently and produces answers about footage that has been replaced.
    throw new ExternalServiceError(
      'storage',
      `Storage returned no content tag for ${storageKey}, so a cached copy could not be told apart from a re-processed one`,
      { retryable: false },
    );
  }
  return `${storageKey}#${object.etag}`;
}
