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
  // The row count is checked, not discarded.
  //
  // The clip can be gone by the time this runs — the video deleted mid-render,
  // or a concurrent retry having cleared the matches this clip hung from. The
  // UPDATE then matches nothing and returns perfectly happily, and the deck
  // records a candidate as READY whose media is referenced by no row at all:
  // a card that cannot be served, and two orphaned objects.
  const result = await query(
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
            presentation             = 'vertical',
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

  if (result.rowCount === 0) {
    throw new Error(`Clip ${clipId} no longer exists — its finished media has nowhere to be recorded`);
  }
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
            presentation      = 'vertical',
            retention_class   = CASE WHEN clips.approved_at IS NOT NULL THEN 'owned' ELSE 'temporary' END,
            updated_at        = now()
      WHERE id = $1`,
    [clipId, message.slice(0, 500)],
  );
}

export interface OriginalMediaInput {
  posterStorageKey: string;
  posterTimestampSeconds: number;
  sourceWidth: number;
  sourceHeight: number;
  canonicalGenerationMs: number | null;
  posterGenerationMs: number | null;
  /** 'temporary' until someone keeps it. See retentionClassFor. */
  retentionClass: 'temporary' | 'owned';
}

/**
 * Write READY for a moment whose deliverable is the canonical cut itself.
 *
 * The owner's rule (2026-09-02): every moment is cut when it is found, and
 * the review shows finished clips whatever framing was asked for. For an
 * original-framing deck the file the creator will receive is the canonical
 * cut, so "finished" means that cut plus a poster taken from inside it — no
 * derivative is owed, and the derivative columns are cleared rather than left
 * saying 'pending' about work that will never happen.
 *
 * One statement, for the same reason setVerticalMedia is: the poster and the
 * pre-rendered flag land together or not at all.
 */
export async function setOriginalMedia(clipId: string, input: OriginalMediaInput): Promise<void> {
  const result = await query(
    `UPDATE clips
        SET poster_storage_key       = $2,
            poster_timestamp_seconds = $3,
            source_width             = $4,
            source_height            = $5,
            -- The deliverable IS the canonical file, so its size is the output.
            output_width             = $4,
            output_height            = $5,
            composition_mode         = 'original',
            derivative_storage_key   = NULL,
            derivative_status        = NULL,
            derivative_error         = NULL,
            canonical_generation_ms  = $6,
            composition_decision_ms  = NULL,
            derivative_generation_ms = NULL,
            poster_generation_ms     = $7,
            pre_rendered             = TRUE,
            presentation             = 'original',
            retention_class          = CASE WHEN clips.approved_at IS NOT NULL THEN 'owned' ELSE $8 END,
            updated_at               = now()
      WHERE id = $1`,
    [
      clipId,
      input.posterStorageKey,
      input.posterTimestampSeconds,
      input.sourceWidth,
      input.sourceHeight,
      input.canonicalGenerationMs,
      input.posterGenerationMs,
      input.retentionClass,
    ],
  );

  if (result.rowCount === 0) {
    throw new Error(`Clip ${clipId} no longer exists — its finished media has nowhere to be recorded`);
  }
}

/**
 * Record that an original-framing pre-render failed.
 *
 * Unlike a vertical failure, there is no separate presentation to blame: the
 * cut itself, or the poster from it, is what did not finish, so the clip's
 * own status says failed. The row is marked pre-rendered and temporary for
 * the same reason markVerticalFailed does it — a canonical file that reached
 * storage before the poster gave way is an object nobody will ever see, and
 * the sweep must be able to find it.
 */
export async function markOriginalFailed(clipId: string, message: string): Promise<void> {
  await query(
    `UPDATE clips
        SET status          = 'failed',
            error_message   = $2,
            pre_rendered    = TRUE,
            presentation    = 'original',
            retention_class = CASE WHEN clips.approved_at IS NOT NULL THEN 'owned' ELSE 'temporary' END,
            updated_at      = now()
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
 *
 * The sweep clears storage_key along with the other pointers, so a Keep that
 * lands after it is refused here for an original-framing moment exactly as
 * it is for a vertical one.
 */
export async function approveClip(clipId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE clips
        SET approved_at     = COALESCE(approved_at, now()),
            retention_class = 'owned',
            updated_at      = now()
      WHERE id = $1
        AND status = 'ready'
        AND storage_key IS NOT NULL
        -- A pre-rendered moment is finished when its poster and its
        -- deliverable both exist: the canonical file for an original-framing
        -- deck, the 9:16 derivative as well for a vertical one.
        AND (pre_rendered = FALSE
             OR (poster_storage_key IS NOT NULL
                 AND (presentation = 'original'
                      OR (derivative_status = 'ready'
                          AND derivative_storage_key IS NOT NULL))))
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
export async function clearUnkeptMatchesForRequest(
  clipRequestId: string,
  /**
   * The attempt that planned this deck. Null skips the fence, for callers
   * that run before any planning.
   *
   * Without it, a stalled worker resuming after its replacement had already
   * planned and rendered would clear the NEWER run's matches and delete its
   * media — the token fenced only the release, so everything before it stayed
   * open to a run that had already lost.
   */
  attemptId: string | null,
): Promise<string[]> {
  const rows = await queryRows<{
    storage_key: string | null;
    derivative_storage_key: string | null;
    poster_storage_key: string | null;
  }>(
    `WITH doomed AS (
       SELECT m.id AS match_id
         FROM clip_matches m
        WHERE m.clip_request_id = $1
          -- Only the attempt that currently owns this request may clear it.
          AND ($2::uuid IS NULL OR EXISTS (
            SELECT 1 FROM clip_requests r
             WHERE r.id = $1 AND r.deck_attempt_id = $2::uuid
          ))
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
    [clipRequestId, attemptId],
  );
  return rows.flatMap((row) =>
    [row.storage_key, row.derivative_storage_key, row.poster_storage_key]
      .filter((key): key is string => typeof key === 'string' && key.length > 0),
  );
}
