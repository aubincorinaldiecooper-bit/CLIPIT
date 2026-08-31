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
 * CLAIM pre-rendered moments nobody kept, and hand back their file keys.
 *
 * Making media before Keep is a latency decision with a bill attached: asking
 * for three moments renders at least three, and only the ones somebody
 * pressed Keep on were ever wanted. Without this sweep that bill is permanent
 * and grows with every question asked.
 *
 * Claiming and clearing in ONE statement, rather than listing now and
 * clearing after the deletes, closes a race that ends badly for a person.
 * Keep landing between a plain list and the object deletion would promote the
 * row to owned while the sweep deleted its files anyway — and the creator
 * would be left holding a clip they had just chosen that no longer plays.
 * Clearing the pointers first makes approveClip refuse (it requires a
 * derivative key), so a Keep in that window is told the moment is not
 * available instead of silently handing over a broken one.
 *
 * The cost of that ordering, stated plainly: if an object delete then fails,
 * the row no longer names it and it is orphaned in storage. That is a bill we
 * can find in the logs. A kept clip that does not play is not recoverable at
 * all, so this is the right way round.
 *
 * Narrow by construction: only rows this pipeline made, only ones never
 * approved, only after an idle period. Anything cut the old way is invisible
 * to it.
 */
export async function claimUnkeptPreRenderedMedia(
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
    `WITH claimed AS (
       SELECT id, video_id, derivative_storage_key, poster_storage_key, storage_key
         FROM clips
        WHERE retention_class = 'temporary'
          AND pre_rendered = TRUE
          AND approved_at IS NULL
          AND created_at < now() - make_interval(secs => $1)
        ORDER BY created_at
        LIMIT $2
        -- Two sweeps running at once must not both claim the same row and
        -- both try to delete the same objects.
        FOR UPDATE SKIP LOCKED
     ), cleared AS (
       UPDATE clips
          SET derivative_storage_key = NULL,
              derivative_status      = NULL,
              poster_storage_key     = NULL,
              storage_key            = NULL,
              updated_at             = now()
         FROM claimed
        WHERE clips.id = claimed.id
     )
     SELECT id, video_id, derivative_storage_key, poster_storage_key, storage_key
       FROM claimed`,
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
 * Clear a previous attempt's matches and hand back the files they held —
 * in ONE statement, and never touching a moment the creator kept.
 *
 * Three things have to be true together, and getting any one of them alone is
 * worse than useless:
 *
 *  - The keys must be read BEFORE the rows go. clips.clip_match_id is
 *    ON DELETE CASCADE, and every collector in this system finds objects by
 *    reading keys off a clip row, so a row deleted while its files exist
 *    takes the only map to them.
 *  - Kept moments must keep their ROWS, not just their files. Sparing the
 *    files while the cascade still took the rows was my own first attempt at
 *    this: the clip vanished from the creator's library and the files I had
 *    carefully preserved became unreachable. Worse than deleting both.
 *  - The read and the delete must not be two round trips. An approval landing
 *    between them would be read as unkept and then cascaded away.
 *
 * The NOT EXISTS keeps a match whose clip somebody approved, so the cascade
 * never reaches it. One statement narrows the approval race to the width of
 * a single snapshot rather than a network gap — it does not eliminate it, and
 * closing it entirely would need SERIALIZABLE or an explicit lock ordering
 * shared with approveClip.
 */
export async function clearUnkeptMatchesForRequest(clipRequestId: string): Promise<string[]> {
  const rows = await queryRows<{
    storage_key: string | null;
    derivative_storage_key: string | null;
    poster_storage_key: string | null;
  }>(
    `WITH doomed AS (
       SELECT m.id AS match_id
         FROM clip_matches m
        WHERE m.clip_request_id = $1
          AND NOT EXISTS (
            SELECT 1 FROM clips k
             WHERE k.clip_match_id = m.id AND k.approved_at IS NOT NULL
          )
     ), files AS (
       SELECT c.storage_key, c.derivative_storage_key, c.poster_storage_key
         FROM clips c
         JOIN doomed d ON d.match_id = c.clip_match_id
     ), removed AS (
       DELETE FROM clip_matches WHERE id IN (SELECT match_id FROM doomed)
     )
     SELECT storage_key, derivative_storage_key, poster_storage_key FROM files`,
    [clipRequestId],
  );
  return rows.flatMap((row) =>
    [row.storage_key, row.derivative_storage_key, row.poster_storage_key]
      .filter((key): key is string => typeof key === 'string' && key.length > 0),
  );
}
