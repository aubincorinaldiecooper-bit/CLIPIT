import { query, queryOne, queryRows } from '../pool.js';
import type { CompositionMode } from '../../services/media/composition.js';

/**
 * The post-ready state of a clip: its vertical derivative, its poster, and
 * whether anyone has actually chosen it.
 *
 * Kept apart from clips.ts on purpose. That file owns what a clip IS — the
 * moment, its boundaries, the person's corrections to them. This owns how the
 * moment is PRESENTED, and presentation must never be able to reach in and
 * change the moment. Separate functions, separate columns, one direction.
 */

export interface VerticalMediaInput {
  compositionMode: CompositionMode;
  focalX: number | null;
  focalY: number | null;
  derivativeStorageKey: string;
  posterStorageKey: string;
  posterTimestampSeconds: number;
  sourceWidth: number;
  sourceHeight: number;
  outputWidth: number;
  outputHeight: number;
  canonicalGenerationMs: number | null;
  compositionDecisionMs: number | null;
  derivativeGenerationMs: number | null;
  posterGenerationMs: number | null;
  /** 'temporary' until someone keeps it. See retentionClassFor. */
  retentionClass: 'temporary' | 'owned';
}

/**
 * Write READY.
 *
 * This is the moment a candidate becomes something a creator may see, so it
 * is a single statement: the derivative key, the poster and the status land
 * together or not at all. A half-written row — status 'ready', no poster —
 * is precisely the state isCreatorVisible exists to catch, and there is no
 * reason to create one and rely on being caught.
 */
export async function setVerticalMedia(clipId: string, input: VerticalMediaInput): Promise<void> {
  await query(
    `UPDATE clips
        SET derivative_storage_key   = $2,
            derivative_status        = 'ready',
            derivative_error         = NULL,
            composition_mode         = $3,
            focal_x                  = $4,
            focal_y                  = $5,
            poster_storage_key       = $6,
            poster_timestamp_seconds = $7,
            source_width             = $8,
            source_height            = $9,
            output_width             = $10,
            output_height            = $11,
            canonical_generation_ms  = $12,
            composition_decision_ms  = $13,
            derivative_generation_ms = $14,
            poster_generation_ms     = $15,
            pre_rendered             = TRUE,
            -- Never demotes: a clip already kept stays 'owned' even if its
            -- media is re-derived, because the person's choice outlives the
            -- file it was made about.
            retention_class          = CASE WHEN clips.approved_at IS NOT NULL THEN 'owned' ELSE $16 END,
            updated_at               = now()
      WHERE id = $1`,
    [
      clipId,
      input.derivativeStorageKey,
      input.compositionMode,
      input.focalX,
      input.focalY,
      input.posterStorageKey,
      input.posterTimestampSeconds,
      input.sourceWidth,
      input.sourceHeight,
      input.outputWidth,
      input.outputHeight,
      input.canonicalGenerationMs,
      input.compositionDecisionMs,
      input.derivativeGenerationMs,
      input.posterGenerationMs,
      input.retentionClass,
    ],
  );
}

/**
 * Record that the vertical work failed.
 *
 * The canonical clip's STATUS is deliberately untouched. It may well be
 * perfectly good — the failure was in cropping it — and marking the clip
 * itself failed would delete a working clip from the library over a
 * presentation problem.
 *
 * Its retention is not untouched, though, and that distinction matters. A
 * pre-rendered moment whose vertical render failed is never shown to anyone,
 * so its canonical file is an object in storage that no creator will ever
 * see. Left at the column default of 'owned' it would sit there being paid
 * for forever; marked temporary, the sweep collects it like any other moment
 * nobody kept. An already-approved clip is never demoted.
 */
export async function markVerticalFailed(clipId: string, message: string): Promise<void> {
  await query(
    `UPDATE clips
        SET derivative_status = 'failed',
            derivative_error  = $2,
            pre_rendered      = TRUE,
            retention_class   = CASE WHEN clips.approved_at IS NOT NULL THEN 'owned' ELSE 'temporary' END,
            updated_at        = now()
      WHERE id = $1`,
    [clipId, message.slice(0, 500)],
  );
}

/**
 * Keep, as an approval.
 *
 * Conditional on the media actually being there. If a card somehow reaches a
 * creator without its files, approving it would mint an 'owned' row pointing
 * at nothing, and the sweep below would then protect that nothing forever.
 * Returns whether the approval took, so the route can answer honestly.
 */
export async function approveClip(clipId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE clips
        SET approved_at     = COALESCE(approved_at, now()),
            retention_class = 'owned',
            updated_at      = now()
      WHERE id = $1
        AND status = 'ready'
        AND (pre_rendered = FALSE
             OR (derivative_status = 'ready'
                 AND derivative_storage_key IS NOT NULL
                 AND poster_storage_key IS NOT NULL))
      RETURNING id`,
    [clipId],
  );
  return row !== null;
}

export interface ExpiredMediaRow {
  clipId: string;
  videoId: string;
  derivativeStorageKey: string | null;
  posterStorageKey: string | null;
  storageKey: string | null;
}

/**
 * Pre-rendered moments nobody kept, old enough to stop paying for.
 *
 * Making media before Keep is a latency decision, and it has a bill attached:
 * asking for three moments renders at least three, and only the ones somebody
 * presses Keep on were ever wanted. Without this sweep that bill is permanent
 * and grows with every question asked.
 *
 * Narrow by construction. Only rows this pipeline itself created
 * (pre_rendered), only ones never approved (retention_class 'temporary'), and
 * only after an idle period. Anything cut the old way is untouched.
 */
export async function listUnkeptPreRenderedMedia(
  idleSeconds: number,
  limit: number,
): Promise<ExpiredMediaRow[]> {
  const rows = await queryRows<{
    id: string;
    video_id: string;
    derivative_storage_key: string | null;
    poster_storage_key: string | null;
    storage_key: string | null;
  }>(
    `SELECT id, video_id, derivative_storage_key, poster_storage_key, storage_key
       FROM clips
      WHERE retention_class = 'temporary'
        AND pre_rendered = TRUE
        AND approved_at IS NULL
        AND created_at < now() - make_interval(secs => $1)
      ORDER BY created_at
      LIMIT $2`,
    [idleSeconds, limit],
  );
  return rows.map((row) => ({
    clipId: row.id,
    videoId: row.video_id,
    derivativeStorageKey: row.derivative_storage_key,
    posterStorageKey: row.poster_storage_key,
    storageKey: row.storage_key,
  }));
}

/**
 * Forget media that has been deleted.
 *
 * The clip ROW stays. It is the record that this moment was found and offered
 * and nobody wanted it — which is evidence about the search, and survives the
 * bytes it describes. Only the pointers to files that no longer exist are
 * cleared, so nothing downstream can hand out a key to a deleted object.
 *
 * The status column is left alone, exactly as clearClipKeysForVideo leaves it
 * for expired footage. A cleared key already makes the clip unplayable and
 * unshowable everywhere that reads one; inventing a new status would mean
 * teaching every existing reader about a state it has never seen.
 */
export async function clearExpiredMedia(clipIds: string[]): Promise<void> {
  if (clipIds.length === 0) return;
  await query(
    `UPDATE clips
        SET derivative_storage_key = NULL,
            derivative_status      = NULL,
            poster_storage_key     = NULL,
            storage_key            = NULL,
            updated_at             = now()
      WHERE id = ANY($1::uuid[])
        AND approved_at IS NULL`,
    [clipIds],
  );
}
