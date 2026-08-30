import { queryOne, queryRows } from '../pool.js';
import type { ClipMatch, MomentVersion } from '../../domain/types.js';

interface MomentVersionRow {
  id: string;
  match_id: string;
  version: number;
  trigger: 'initial' | 'reclip';
  start_seconds: string | number;
  end_seconds: string | number;
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
  created_at: Date;
}

function mapVersion(row: MomentVersionRow): MomentVersion {
  return {
    id: row.id,
    matchId: row.match_id,
    version: row.version,
    trigger: row.trigger,
    startSeconds: Number(row.start_seconds),
    endSeconds: Number(row.end_seconds),
    provider: row.provider,
    model: row.model,
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
  };
}

/**
 * Writes version 1 from the match's own first-pass prediction, exactly once.
 *
 * The match row is the original evidence and is never updated; this copies
 * it into the version history the first time anyone asks for a Re-clip, so
 * every later version has the thing it moved away from. ON CONFLICT DO
 * NOTHING makes a second ask (or a race) harmless.
 */
export async function ensureInitialVersion(match: ClipMatch): Promise<void> {
  await queryOne(
    `INSERT INTO moment_versions
        (match_id, version, trigger, start_seconds, end_seconds, provider, model, prompt_version)
     VALUES ($1, 1, 'initial', $2, $3, $4, $5, $6)
     ON CONFLICT (match_id, version) DO NOTHING`,
    [match.id, match.globalStartSeconds, match.globalEndSeconds, match.provider, match.model, match.promptVersion],
  );
}

/**
 * Appends the next version. The number is computed inside the INSERT and the
 * (match_id, version) uniqueness makes two racing appenders collide loudly
 * instead of writing the same version twice.
 */
export async function appendReclipVersion(input: {
  matchId: string;
  startSeconds: number;
  endSeconds: number;
  provider: string | null;
  model: string | null;
  promptVersion: string | null;
}): Promise<MomentVersion> {
  const row = await queryOne<MomentVersionRow>(
    `INSERT INTO moment_versions
        (match_id, version, trigger, start_seconds, end_seconds, provider, model, prompt_version)
     SELECT $1, COALESCE(MAX(version), 0) + 1, 'reclip', $2, $3, $4, $5, $6
       FROM moment_versions WHERE match_id = $1
     RETURNING *`,
    [input.matchId, input.startSeconds, input.endSeconds, input.provider, input.model, input.promptVersion],
  );
  if (!row) throw new Error('appendReclipVersion inserted no row');
  return mapVersion(row);
}

export async function listVersions(matchId: string): Promise<MomentVersion[]> {
  const rows = await queryRows<MomentVersionRow>(
    `SELECT * FROM moment_versions WHERE match_id = $1 ORDER BY version ASC`,
    [matchId],
  );
  return rows.map(mapVersion);
}

/** Latest version per match, for serializing many matches in one query. */
export async function latestVersionsForMatches(matchIds: string[]): Promise<Map<string, MomentVersion>> {
  if (matchIds.length === 0) return new Map();
  const rows = await queryRows<MomentVersionRow>(
    `SELECT DISTINCT ON (match_id) *
       FROM moment_versions
      WHERE match_id = ANY($1::uuid[])
      ORDER BY match_id, version DESC`,
    [matchIds],
  );
  return new Map(rows.map((row) => [row.match_id, mapVersion(row)]));
}

/** How many re-evaluations this moment has already spent. */
export async function countReclips(matchId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM moment_versions WHERE match_id = $1 AND trigger = 'reclip'`,
    [matchId],
  );
  return row ? Number(row.count) : 0;
}

/**
 * Claims the moment for one Re-clip run. The WHERE is the guard: only a
 * moment not already pending can be claimed, so a double-tap (or two tabs)
 * yields one job and one refusal instead of two GPU calls.
 */
export async function claimReclip(matchId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE clip_matches
        SET reclip_status = 'pending', reclip_error = NULL
      WHERE id = $1 AND (reclip_status IS NULL OR reclip_status = 'failed')
      RETURNING id`,
    [matchId],
  );
  return Boolean(row);
}

/** Success clears the lifecycle — the new version row is the record. */
export async function clearReclipPending(matchId: string): Promise<void> {
  await queryOne(`UPDATE clip_matches SET reclip_status = NULL, reclip_error = NULL WHERE id = $1`, [matchId]);
}

/**
 * A failure is a fact the person must be able to see after a reload, not a
 * toast that died with the tab. The message is chosen by the worker and must
 * already be safe to show.
 */
export async function markReclipFailed(matchId: string, message: string): Promise<void> {
  await queryOne(
    `UPDATE clip_matches SET reclip_status = 'failed', reclip_error = $2 WHERE id = $1`,
    [matchId, message.slice(0, 500)],
  );
}
