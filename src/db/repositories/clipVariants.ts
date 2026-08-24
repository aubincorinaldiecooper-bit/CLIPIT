import { queryOne, queryRows } from '../pool.js';
import type { ClipFormat } from '../../services/media/reframe.js';

/**
 * Clip variants: the same moment, cut to the shape a platform wants.
 *
 * They are made on demand — the first publish to a 9:16 platform renders
 * one — and kept, so every later post of that shape reuses the file. A
 * variant belongs to one (clip, aspect, framing) triple: move the framing
 * and the next publish renders afresh rather than posting a crop the user
 * has already rejected.
 */

export type VariantAspect = Exclude<ClipFormat['aspect'], 'source'>;
export type VariantStatus = 'pending' | 'rendering' | 'ready' | 'failed';

export interface ClipVariant {
  id: string;
  clipId: string;
  aspect: VariantAspect;
  focusPct: number;
  status: VariantStatus;
  errorMessage: string | null;
  storageKey: string | null;
  width: number | null;
  height: number | null;
  sizeBytes: number | null;
  createdAt: Date;
  updatedAt: Date;
}

interface VariantRow {
  id: string;
  clip_id: string;
  aspect: VariantAspect;
  focus_pct: number;
  status: VariantStatus;
  error_message: string | null;
  storage_key: string | null;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  created_at: Date;
  updated_at: Date;
}

function mapVariant(row: VariantRow): ClipVariant {
  return {
    id: row.id,
    clipId: row.clip_id,
    aspect: row.aspect,
    focusPct: Number(row.focus_pct),
    status: row.status,
    errorMessage: row.error_message,
    storageKey: row.storage_key,
    width: row.width,
    height: row.height,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The variant for exactly this shape and framing, if one has been made. */
export async function findVariant(
  clipId: string,
  aspect: VariantAspect,
  focusPct: number,
): Promise<ClipVariant | null> {
  const row = await queryOne<VariantRow>(
    `SELECT * FROM clip_variants WHERE clip_id = $1 AND aspect = $2 AND focus_pct = $3`,
    [clipId, aspect, focusPct],
  );
  return row ? mapVariant(row) : null;
}

/**
 * Claim the job of rendering one shape.
 *
 * Returns the row either way; `created` says whether THIS caller is the one
 * that must render it. Two publishes racing for the same shape both get the
 * row, only one renders, and neither ends up with a duplicate file.
 */
export async function claimVariant(
  clipId: string,
  aspect: VariantAspect,
  focusPct: number,
): Promise<{ variant: ClipVariant; created: boolean }> {
  const inserted = await queryOne<VariantRow>(
    `INSERT INTO clip_variants (clip_id, aspect, focus_pct, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (clip_id, aspect, focus_pct) DO NOTHING
     RETURNING *`,
    [clipId, aspect, focusPct],
  );
  if (inserted) return { variant: mapVariant(inserted), created: true };

  const existing = await findVariant(clipId, aspect, focusPct);
  // The conflict target guarantees a row exists; the throw is for the
  // impossible case rather than a silent null downstream.
  if (!existing) throw new Error('variant row vanished between insert and read');
  return { variant: existing, created: false };
}

export async function setVariantStatus(
  variantId: string,
  status: VariantStatus,
  options: {
    errorMessage?: string | null;
    storageKey?: string | null;
    width?: number | null;
    height?: number | null;
    sizeBytes?: number | null;
  } = {},
): Promise<void> {
  await queryOne(
    `UPDATE clip_variants
        SET status = $2,
            error_message = $3,
            storage_key = COALESCE($4, storage_key),
            width = COALESCE($5, width),
            height = COALESCE($6, height),
            size_bytes = COALESCE($7, size_bytes),
            updated_at = now()
      WHERE id = $1`,
    [
      variantId,
      status,
      options.errorMessage ?? null,
      options.storageKey ?? null,
      options.width ?? null,
      options.height ?? null,
      options.sizeBytes ?? null,
    ],
  );
}

/** Every shape made for one clip — what the library shows as "ready to post". */
export async function listVariantsForClip(clipId: string): Promise<ClipVariant[]> {
  const rows = await queryRows<VariantRow>(
    `SELECT * FROM clip_variants WHERE clip_id = $1 ORDER BY created_at ASC`,
    [clipId],
  );
  return rows.map(mapVariant);
}

/**
 * Forget the shapes of a clip whose own file changed.
 *
 * A replace re-renders the master from the source; every variant cut from
 * the OLD master is now a lie, and posting one would send footage the user
 * has already replaced.
 */
export async function discardVariants(clipId: string): Promise<void> {
  await queryOne('DELETE FROM clip_variants WHERE clip_id = $1', [clipId]);
}
