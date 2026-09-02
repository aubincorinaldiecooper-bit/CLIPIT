import { queryRows } from '../pool.js';

/**
 * Which of these storage keys some row still names, right now.
 *
 * A key queued for release is deleted LATER (see enqueueObjectRelease), and
 * in the meantime a row can come to name it again — a platform shape made
 * afresh after a discard, or a render whose write landed although its reply
 * was lost. Deleting on the strength of a decision taken an hour ago would
 * pull a working file from under a row that points at it, so the release
 * asks this question at the moment it acts, across every column that can
 * name an object: the clips' own three, the platform shapes, the footage
 * and its proxies, the analysis chunks and the moment stills. A key a row
 * names is kept, whatever it was queued for.
 */
export async function storageKeysInUse(keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await queryRows<{ key: string }>(
    `SELECT storage_key AS key FROM clips WHERE storage_key = ANY($1::text[])
     UNION SELECT poster_storage_key FROM clips WHERE poster_storage_key = ANY($1::text[])
     UNION SELECT derivative_storage_key FROM clips WHERE derivative_storage_key = ANY($1::text[])
     UNION SELECT storage_key FROM clip_variants WHERE storage_key = ANY($1::text[])
     UNION SELECT original_storage_key FROM videos WHERE original_storage_key = ANY($1::text[])
     UNION SELECT proxy_storage_key FROM videos WHERE proxy_storage_key = ANY($1::text[])
     UNION SELECT playback_storage_key FROM videos WHERE playback_storage_key = ANY($1::text[])
     UNION SELECT captions_storage_key FROM videos WHERE captions_storage_key = ANY($1::text[])
     UNION SELECT poster_storage_key FROM videos WHERE poster_storage_key = ANY($1::text[])
     UNION SELECT storage_key FROM video_chunks WHERE storage_key = ANY($1::text[])
     UNION SELECT thumbnail_key FROM clip_matches WHERE thumbnail_key = ANY($1::text[])`,
    [keys],
  );
  return new Set(rows.map((row) => row.key).filter((key): key is string => typeof key === 'string' && key.length > 0));
}
