import { queryOne, withTransaction } from '../pool.js';
import type { ClipGenerationJob } from '../../queues/index.js';

/**
 * Renders whose outcome could not be learned on their job's last attempt —
 * the record the footage sweep settles once the database answers. See
 * migration 035 and settleUnknownRender.
 */

export interface UnknownRender {
  id: string;
  clipId: string;
  /** The file this render wrote; the row naming it proves the write landed — when the key is new to the row. */
  storageKey: string;
  /** The file the row named before this render, if any; the same key as `storageKey` for a retried first render. */
  previousStorageKey: string | null;
  job: ClipGenerationJob;
}

export async function recordUnknownRender(input: Omit<UnknownRender, 'id'>): Promise<void> {
  await queryOne(
    `INSERT INTO unknown_renders (clip_id, storage_key, previous_storage_key, job)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id`,
    [input.clipId, input.storageKey, input.previousStorageKey, JSON.stringify(input.job)],
  );
}

/**
 * Hands unknown renders over, oldest first, up to `limit`; each row is
 * deleted in the same transaction as its settling, so a settling that fails
 * leaves the row for the next sweep. Two sweeps at once take different rows.
 */
export async function drainUnknownRenders(
  limit: number,
  settle: (render: UnknownRender) => Promise<void>,
): Promise<number> {
  return withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string; clip_id: string; storage_key: string; previous_storage_key: string | null; job: ClipGenerationJob }>(
      `SELECT id, clip_id, storage_key, previous_storage_key, job
         FROM unknown_renders
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    let settled = 0;
    for (const row of rows) {
      await settle({ id: row.id, clipId: row.clip_id, storageKey: row.storage_key, previousStorageKey: row.previous_storage_key, job: row.job });
      await client.query('DELETE FROM unknown_renders WHERE id = $1', [row.id]);
      settled += 1;
    }
    return settled;
  });
}
