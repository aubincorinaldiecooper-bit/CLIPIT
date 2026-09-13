from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise RuntimeError(f"missing {label}")
    return text.replace(old, new, 1)


def replace_between(text: str, start: str, end: str, replacement: str) -> str:
    a = text.find(start)
    if a < 0:
        raise RuntimeError(f"missing start marker: {start}")
    b = text.find(end, a)
    if b < 0:
        raise RuntimeError(f"missing end marker: {end}")
    return text[:a] + replacement.rstrip() + "\n\n" + text[b:]


def patch_repo() -> None:
    path = ROOT / "src/db/repositories/clipRequests.ts"
    text = path.read_text()
    text = replace_once(
        text,
        "import { queryOne, queryRows } from '../pool.js';",
        "import { queryOne, queryRows, withTransaction } from '../pool.js';",
        "pool import",
    )

    insert = r'''export async function insertMatches(
  requestId: string,
  matches: NewClipMatch[],
  deckAttemptId: string,
): Promise<ClipMatch[]> {
  if (matches.length === 0) return [];

  const values: string[] = [];
  const params: unknown[] = [requestId, deckAttemptId];

  for (const match of matches) {
    const base = params.length;
    params.push(
      match.chunkId,
      match.localStartSeconds,
      match.localEndSeconds,
      match.globalStartSeconds,
      match.globalEndSeconds,
      match.description,
      match.confidence,
      match.source,
      match.quote ?? null,
      match.provider ?? null,
      match.model ?? null,
      match.promptVersion ?? null,
    );
    values.push(
      `($1::uuid, $${base + 1}::uuid, $${base + 2}::numeric, $${base + 3}::numeric, ` +
      `$${base + 4}::numeric, $${base + 5}::numeric, $${base + 6}::text, $${base + 7}::numeric, ` +
      `$${base + 8}::text, $${base + 9}::text, $${base + 10}::text, $${base + 11}::text, $${base + 12}::text)`,
    );
  }

  return withTransaction(async (client) => {
    // The request row is the ownership mutex. A replacement claim is an UPDATE
    // on the same row, so whichever arrives second waits. After the lock is
    // acquired we re-check the attempt token in the current transaction: a
    // stale worker can therefore never commit rows after a newer claim.
    const owner = await client.query<{ id: string }>(
      `SELECT id
         FROM clip_requests
        WHERE id = $1::uuid
          AND deck_attempt_id = $2::uuid
          AND deck_completed_at IS NULL
        FOR UPDATE`,
      [requestId, deckAttemptId],
    );
    if (owner.rowCount !== 1) return [];

    const result = await client.query<ClipMatchRow>(
      `INSERT INTO clip_matches (
         clip_request_id, chunk_id, local_start_seconds, local_end_seconds,
         global_start_seconds, global_end_seconds, description, confidence, source, quote,
         provider, model, prompt_version
       ) VALUES ${values.join(', ')}
       RETURNING *`,
      params as never[],
    );
    return result.rows.map(mapMatch);
  });
}'''
    text = replace_between(
        text,
        "export async function insertMatches(",
        "/**\n * Attaches stills to matches",
        insert,
    )

    thumbs = r'''export async function setMatchThumbnails(
  thumbnails: Array<{ matchId: string; thumbnailKey: string }>,
  fence?: { requestId: string; deckAttemptId: string },
): Promise<string[]> {
  if (thumbnails.length === 0) return [];
  if (!fence) {
    const rows = await queryRows<{ thumbnail_key: string }>(
      `UPDATE clip_matches AS m
          SET thumbnail_key = v.thumbnail_key
         FROM (SELECT * FROM unnest($1::uuid[], $2::text[]) AS t(id, thumbnail_key)) AS v
        WHERE m.id = v.id
        RETURNING m.thumbnail_key`,
      [thumbnails.map((t) => t.matchId), thumbnails.map((t) => t.thumbnailKey)],
    );
    return rows.map((row) => row.thumbnail_key);
  }
  const rows = await queryRows<{ thumbnail_key: string }>(
    `UPDATE clip_matches AS m
        SET thumbnail_key = v.thumbnail_key
       FROM (SELECT * FROM unnest($1::uuid[], $2::text[]) AS t(id, thumbnail_key)) AS v,
            clip_requests AS r
      WHERE m.id = v.id
        AND r.id = m.clip_request_id
        AND r.id = $3::uuid
        AND r.deck_attempt_id = $4::uuid
        AND r.deck_completed_at IS NULL
      RETURNING m.thumbnail_key`,
    [
      thumbnails.map((t) => t.matchId),
      thumbnails.map((t) => t.thumbnailKey),
      fence.requestId,
      fence.deckAttemptId,
    ],
  );
  return rows.map((row) => row.thumbnail_key);
}'''
    text = replace_between(
        text,
        "export async function setMatchThumbnails(",
        "/**\n * Videos holding matches that were found before stills existed.",
        thumbs,
    )
    path.write_text(text)


def patch_thumbnails() -> None:
    path = ROOT / "src/services/media/thumbnails.ts"
    text = path.read_text()
    old = '''    await setMatchThumbnails(attached, input.attemptFence);\n\n    log.info('match thumbnails attached', {\n      videoId,\n      attached: attached.length,'''
    new = '''    const persistedKeys = new Set(await setMatchThumbnails(attached, input.attemptFence));
    const rejected = input.attemptFence
      ? attached.filter((item) => !persistedKeys.has(item.thumbnailKey))
      : [];
    if (rejected.length > 0) {
      const cleanup = await Promise.allSettled(rejected.map((item) => getStorage().remove(item.thumbnailKey)));
      const orphanedKeys = rejected.flatMap((item, index) => cleanup[index]?.status === 'rejected' ? [item.thumbnailKey] : []);
      if (orphanedKeys.length > 0) {
        log.warn('could not clean superseded thumbnail uploads', { videoId, orphanedKeys });
      }
    }

    log.info('match thumbnails attached', {
      videoId,
      attached: persistedKeys.size,'''
    text = replace_once(text, old, new, "thumbnail persistence cleanup")
    text = replace_once(
        text,
        "    return attached.length;",
        "    return persistedKeys.size;",
        "thumbnail return count",
    )
    path.write_text(text)


def patch_contract_test() -> None:
    path = ROOT / "test/evidenceContract.test.ts"
    text = path.read_text()
    text = replace_once(
        text,
        "    expect(recordRetrievalOutcome).toHaveBeenCalledWith('request-1', expect.objectContaining({ primary: 'videochat3', system: 'videochat3' }));",
        "    expect(recordRetrievalOutcome).toHaveBeenCalledWith('request-1', expect.objectContaining({ primary: 'videochat3', system: 'videochat3' }), 'attempt-1');",
        "retrieval outcome attempt assertion",
    )
    path.write_text(text)


def patch_fencing_test() -> None:
    path = ROOT / "test/searchFencing.test.ts"
    text = path.read_text()
    old = """    const inserts = between(repo, 'export async function insertMatches', '/**\\n * Attaches stills to matches');
    expect(inserts).toContain('r.deck_attempt_id = $2::uuid');
    expect(inserts).toContain('r.deck_completed_at IS NULL');"""
    new = """    const inserts = between(repo, 'export async function insertMatches', '/**\\n * Attaches stills to matches');
    expect(inserts).toContain('withTransaction(async (client) =>');
    expect(inserts).toContain('FOR UPDATE');
    expect(inserts).toContain('deck_attempt_id = $2::uuid');
    expect(inserts).toContain('$1::uuid');
    expect(inserts).toContain('::numeric');
    expect(inserts).toContain('::text');"""
    text = replace_once(text, old, new, "insert fencing assertions")

    old2 = """    expect(thumbnails).toContain('setMatchThumbnails(attached, input.attemptFence)');
    expect(handler).toContain('attemptFence: { requestId: clipRequestId, deckAttemptId }');"""
    new2 = """    expect(thumbnails).toContain('new Set(await setMatchThumbnails(attached, input.attemptFence))');
    expect(thumbnails).toContain('getStorage().remove(item.thumbnailKey)');
    expect(thumbnails).toContain("log.warn('could not clean superseded thumbnail uploads'");
    expect(handler).toContain('attemptFence: { requestId: clipRequestId, deckAttemptId }');"""
    text = replace_once(text, old2, new2, "thumbnail cleanup assertions")
    path.write_text(text)


if __name__ == '__main__':
    patch_repo()
    patch_thumbnails()
    patch_contract_test()
    patch_fencing_test()
