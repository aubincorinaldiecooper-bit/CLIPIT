import { queryOne, withTransaction } from '../pool.js';

/**
 * The record of objects to release that does not depend on the queue.
 *
 * A render whose outcome is unknown queues both renders' objects for the
 * ownership-checked release (see enqueueObjectRelease). When the queue
 * cannot be reached at that moment, the keys are written here instead, and
 * the footage sweep — which runs from the queue, so the queue is back by
 * then — hands each row to it. A row is deleted only once handed over.
 */

export interface ObjectReleaseContext {
  videoId: string;
  clipId: string;
  reason: string;
}

export interface RecordedObjectRelease {
  id: string;
  keys: string[];
  context: ObjectReleaseContext;
}

export async function recordObjectRelease(keys: string[], context: ObjectReleaseContext): Promise<void> {
  if (keys.length === 0) return;
  await queryOne(
    `INSERT INTO object_releases (keys, video_id, clip_id, reason)
     VALUES ($1::text[], $2, $3, $4)
     RETURNING id`,
    [keys, context.videoId || null, context.clipId || null, context.reason],
  );
}

/**
 * Hands recorded releases over, oldest first, up to `limit`; each row is
 * deleted in the same transaction as its hand-over, so a hand-over that
 * fails leaves the row for the next sweep. Two sweeps at once take
 * different rows.
 */
export async function drainObjectReleases(
  limit: number,
  handOver: (release: RecordedObjectRelease) => Promise<void>,
): Promise<number> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      id: string;
      keys: string[];
      video_id: string | null;
      clip_id: string | null;
      reason: string;
    }>(
      `SELECT id, keys, video_id, clip_id, reason
         FROM object_releases
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    let handed = 0;
    for (const row of rows) {
      await handOver({
        id: row.id,
        keys: row.keys,
        context: { videoId: row.video_id ?? '', clipId: row.clip_id ?? '', reason: row.reason },
      });
      await client.query('DELETE FROM object_releases WHERE id = $1', [row.id]);
      handed += 1;
    }
    return handed;
  });
}
