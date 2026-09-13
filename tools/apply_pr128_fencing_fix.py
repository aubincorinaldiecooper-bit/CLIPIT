from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_between(text: str, start: str, end: str, replacement: str) -> str:
    a = text.find(start)
    if a < 0:
        if replacement.strip() in text:
            return text
        raise RuntimeError(f"start marker not found: {start}")
    b = text.find(end, a)
    if b < 0:
        raise RuntimeError(f"end marker not found after {start}: {end}")
    return text[:a] + replacement.rstrip() + "\n\n" + text[b:]


def replace_all_required(text: str, old: str, new: str, minimum: int = 1) -> str:
    count = text.count(old)
    if count == 0 and new in text:
        return text
    if count < minimum:
        raise RuntimeError(f"expected at least {minimum} occurrences of {old!r}, found {count}")
    return text.replace(old, new)


def patch_repo() -> None:
    path = ROOT / "src/db/repositories/clipRequests.ts"
    text = path.read_text()

    text = replace_between(
        text,
        "export async function recordChunkCompleted",
        "/** A failed chunk is recorded",
        """export async function recordChunkCompleted(requestId: string, deckAttemptId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE clip_requests
        SET chunks_completed = chunks_completed + 1, updated_at = now()
      WHERE id = $1 AND deck_attempt_id = $2::uuid AND deck_completed_at IS NULL
      RETURNING id`,
    [requestId, deckAttemptId],
  );
  return Boolean(row);
}""",
    )

    text = replace_between(
        text,
        "export async function recordChunkDegraded",
        "/**\n * Records moments the threshold discarded",
        """export async function recordChunkDegraded(
  requestId: string,
  degradation: ChunkDegradation,
  deckAttemptId: string,
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE clip_requests
        SET chunk_degradations = chunk_degradations || $2::jsonb,
            updated_at = now()
      WHERE id = $1 AND deck_attempt_id = $3::uuid AND deck_completed_at IS NULL
      RETURNING id`,
    [requestId, JSON.stringify([degradation]), deckAttemptId],
  );
  return Boolean(row);
}""",
    )

    text = replace_between(
        text,
        "export async function recordUncertainMatches",
        "/** Records the request a correction refers to.",
        """export async function recordUncertainMatches(
  requestId: string,
  matches: UncertainMatch[],
  deckAttemptId: string,
): Promise<boolean> {
  if (matches.length === 0) return true;
  const row = await queryOne<{ id: string }>(
    `UPDATE clip_requests
        SET uncertain_matches = (
              SELECT jsonb_agg(entry)
                FROM (
                  SELECT entry
                    FROM jsonb_array_elements(uncertain_matches || $2::jsonb) AS entry
                   ORDER BY (entry->>'confidence')::numeric DESC
                   LIMIT 5
                ) AS kept
            ),
            updated_at = now()
      WHERE id = $1 AND deck_attempt_id = $3::uuid AND deck_completed_at IS NULL
      RETURNING id`,
    [requestId, JSON.stringify(matches), deckAttemptId],
  );
  return Boolean(row);
}""",
    )

    text = replace_between(
        text,
        "export async function recordCorrection",
        "/**\n * Records which system answered",
        """export async function recordCorrection(
  requestId: string,
  correctionOf: string,
  deckAttemptId: string,
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE clip_requests
        SET corrected_request_id = $2, updated_at = now()
      WHERE id = $1 AND deck_attempt_id = $3::uuid AND deck_completed_at IS NULL
      RETURNING id`,
    [requestId, correctionOf, deckAttemptId],
  );
  return Boolean(row);
}""",
    )

    text = replace_between(
        text,
        "export async function recordRetrievalOutcome",
        "/**\n * Declare that this request owes a post-ready deck",
        """export async function recordRetrievalOutcome(
  requestId: string,
  input: {
    primary: RetrievalSystem;
    /**
     * Null until a system has actually answered.
     *
     * Naming one at the moment the primary stands aside would claim the
     * fallback succeeded before it has run — and it can still fail, leaving a
     * row that says a question was answered when nothing answered it.
     */
    system: RetrievalSystem | null;
    fallbackReason: FallbackReason | null;
    primaryOutcome: Record<string, unknown> | null;
  },
  deckAttemptId: string,
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE clip_requests
        SET retrieval_primary = $2,
            retrieval_system  = $3,
            fallback_reason   = $4,
            primary_outcome   = $5::jsonb,
            updated_at        = now()
      WHERE id = $1 AND deck_attempt_id = $6::uuid
      RETURNING id`,
    [
      requestId,
      input.primary,
      input.system,
      input.fallbackReason,
      input.primaryOutcome === null ? null : JSON.stringify(input.primaryOutcome),
      deckAttemptId,
    ],
  );
  return Boolean(row);
}""",
    )

    text = replace_between(
        text,
        "export async function insertMatches",
        "/**\n * Attaches stills to matches",
        """export async function insertMatches(
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
      `($1, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, $${base + 12})`,
    );
  }

  const rows = await queryRows<ClipMatchRow>(
    `INSERT INTO clip_matches (
       clip_request_id, chunk_id, local_start_seconds, local_end_seconds,
       global_start_seconds, global_end_seconds, description, confidence, source, quote,
       provider, model, prompt_version
     )
     SELECT candidate.*
       FROM (VALUES ${values.join(', ')}) AS candidate(
         clip_request_id, chunk_id, local_start_seconds, local_end_seconds,
         global_start_seconds, global_end_seconds, description, confidence, source, quote,
         provider, model, prompt_version
       )
      WHERE EXISTS (
        SELECT 1 FROM clip_requests r
         WHERE r.id = $1
           AND r.deck_attempt_id = $2::uuid
           AND r.deck_completed_at IS NULL
      )
     RETURNING *`,
    params,
  );
  return rows.map(mapMatch);
}""",
    )

    text = replace_between(
        text,
        "export async function setMatchThumbnails",
        "/**\n * Videos holding matches that were found before stills existed.",
        """export async function setMatchThumbnails(
  thumbnails: Array<{ matchId: string; thumbnailKey: string }>,
  fence?: { requestId: string; deckAttemptId: string },
): Promise<void> {
  if (thumbnails.length === 0) return;
  if (!fence) {
    await queryOne(
      `UPDATE clip_matches AS m
          SET thumbnail_key = v.thumbnail_key
         FROM (SELECT * FROM unnest($1::uuid[], $2::text[]) AS t(id, thumbnail_key)) AS v
        WHERE m.id = v.id`,
      [thumbnails.map((t) => t.matchId), thumbnails.map((t) => t.thumbnailKey)],
    );
    return;
  }
  await queryOne(
    `UPDATE clip_matches AS m
        SET thumbnail_key = v.thumbnail_key
       FROM (SELECT * FROM unnest($1::uuid[], $2::text[]) AS t(id, thumbnail_key)) AS v,
            clip_requests AS r
      WHERE m.id = v.id
        AND r.id = m.clip_request_id
        AND r.id = $3::uuid
        AND r.deck_attempt_id = $4::uuid
        AND r.deck_completed_at IS NULL`,
    [
      thumbnails.map((t) => t.matchId),
      thumbnails.map((t) => t.thumbnailKey),
      fence.requestId,
      fence.deckAttemptId,
    ],
  );
}""",
    )

    path.write_text(text)


def patch_handler() -> None:
    path = ROOT / "src/worker/handlers/clipSearch.ts"
    text = path.read_text()

    text = replace_all_required(
        text,
        "await recordCorrection(clipRequestId, previous.id);",
        "await recordCorrection(clipRequestId, previous.id, deckAttemptId);",
    )

    # All retrieval-outcome writes belong to the request-level attempt in this handler.
    text = text.replace("        primaryOutcome: fromSimpleMem.outcome,\n      });", "        primaryOutcome: fromSimpleMem.outcome,\n      }, deckAttemptId);")
    text = text.replace("          primaryOutcome,\n        });", "          primaryOutcome,\n        }, deckAttemptId);")
    text = text.replace("        primaryOutcome,\n      });", "        primaryOutcome,\n      }, deckAttemptId);")
    text = text.replace("        primaryOutcome: fromSimpleMem.outcome,\n      });", "        primaryOutcome: fromSimpleMem.outcome,\n      }, deckAttemptId);")

    text = replace_all_required(
        text,
        "            clipRequestId,\n            workDir: dir,",
        "            clipRequestId,\n            deckAttemptId,\n            workDir: dir,",
    )
    text = replace_all_required(
        text,
        "          clipRequestId,\n          workDir: dir,",
        "          clipRequestId,\n          deckAttemptId,\n          workDir: dir,",
    )

    text = replace_all_required(
        text,
        "await recordChunkDegraded(clipRequestId, degradation);",
        "await recordChunkDegraded(clipRequestId, degradation, deckAttemptId);",
    )
    text = replace_all_required(
        text,
        "await insertMatches(clipRequestId, found);",
        "await insertMatches(clipRequestId, found, deckAttemptId);",
    )
    text = replace_all_required(
        text,
        "await recordChunkCompleted(clipRequestId);",
        "await recordChunkCompleted(clipRequestId, deckAttemptId);",
    )
    text = replace_all_required(
        text,
        "await insertMatches(clipRequestId, rows);",
        "await insertMatches(clipRequestId, rows, deckAttemptId!);",
    )
    text = replace_all_required(
        text,
        "await insertMatches(input.clipRequestId, found);",
        "await insertMatches(input.clipRequestId, found, input.deckAttemptId!);",
        minimum=2,
    )

    text = replace_all_required(
        text,
        "  clipRequestId: string;\n  workDir: string;",
        "  clipRequestId: string;\n  deckAttemptId: string;\n  workDir: string;",
    )

    # One uncertain-match write lives inside searchSingleChunk.
    marker = "    await recordUncertainMatches(\n      input.clipRequestId,"
    if marker in text and "input.deckAttemptId," not in text[text.index(marker): text.index(marker) + 1200]:
        start = text.index(marker)
        close = text.index("    );", start)
        text = text[:close] + "      input.deckAttemptId,\n" + text[close:]

    text = replace_all_required(
        text,
        "async function attachSearchThumbnails(input: {\n  clipRequestId: string;\n  video: Video;",
        "async function attachSearchThumbnails(input: {\n  clipRequestId: string;\n  deckAttemptId: string;\n  video: Video;",
    )
    text = replace_all_required(
        text,
        "  const { clipRequestId, video, workDir, log } = input;",
        "  const { clipRequestId, deckAttemptId, video, workDir, log } = input;",
    )
    text = replace_all_required(
        text,
        "    log,\n  });\n}",
        "    log,\n    attemptFence: { requestId: clipRequestId, deckAttemptId },\n  });\n}",
    )
    text = replace_all_required(
        text,
        "await attachSearchThumbnails({ clipRequestId, video, workDir: dir, log });",
        "await attachSearchThumbnails({ clipRequestId, deckAttemptId, video, workDir: dir, log });",
    )
    text = replace_all_required(
        text,
        "await attachSearchThumbnails({ clipRequestId: input.clipRequestId, video: input.video, workDir: dir, log: input.log });",
        "await attachSearchThumbnails({ clipRequestId: input.clipRequestId, deckAttemptId: input.deckAttemptId!, video: input.video, workDir: dir, log: input.log });",
        minimum=2,
    )

    path.write_text(text)


def patch_thumbnails() -> None:
    path = ROOT / "src/services/media/thumbnails.ts"
    text = path.read_text()
    text = replace_all_required(
        text,
        "  log: Logger;\n}): Promise<number> {",
        "  log: Logger;\n  /** Optional search-attempt fence; background thumbnail backfills omit it. */\n  attemptFence?: { requestId: string; deckAttemptId: string };\n}): Promise<number> {",
    )
    text = replace_all_required(
        text,
        "    await setMatchThumbnails(attached);",
        "    await setMatchThumbnails(attached, input.attemptFence);",
    )
    path.write_text(text)


def patch_tests() -> None:
    path = ROOT / "test/searchFencing.test.ts"
    text = path.read_text()
    text = replace_all_required(
        text,
        "const handler = readFileSync(path.join(__dirname, '..', 'src/worker/handlers/clipSearch.ts'), 'utf8');",
        "const handler = readFileSync(path.join(__dirname, '..', 'src/worker/handlers/clipSearch.ts'), 'utf8');\nconst thumbnails = readFileSync(path.join(__dirname, '..', 'src/services/media/thumbnails.ts'), 'utf8');",
    )

    anchor = "  it('fences the release to the attempt that planned it, and releases and completes in one statement', () => {"
    test_block = """  it('fences every interim search write, not only start and completion', () => {
    const completed = between(repo, 'export async function recordChunkCompleted', '/** A failed chunk');
    expect(completed).toContain('deck_attempt_id = $2::uuid');
    expect(completed).toContain('RETURNING id');

    const degraded = between(repo, 'export async function recordChunkDegraded', '/**\\n * Records moments the threshold discarded');
    expect(degraded).toContain('deck_attempt_id = $3::uuid');

    const uncertain = between(repo, 'export async function recordUncertainMatches', '/** Records the request a correction refers to.');
    expect(uncertain).toContain('deck_attempt_id = $3::uuid');

    const retrieval = between(repo, 'export async function recordRetrievalOutcome', '/**\\n * Declare that this request owes a post-ready deck');
    expect(retrieval).toContain('deck_attempt_id = $6::uuid');

    const inserts = between(repo, 'export async function insertMatches', '/**\\n * Attaches stills to matches');
    expect(inserts).toContain('r.deck_attempt_id = $2::uuid');
    expect(inserts).toContain('r.deck_completed_at IS NULL');
    expect(handler).toContain('insertMatches(clipRequestId, found, deckAttemptId)');
    expect(handler).toContain('insertMatches(input.clipRequestId, found, input.deckAttemptId!)');

    const thumbnailWrite = between(repo, 'export async function setMatchThumbnails', '/**\\n * Videos holding matches');
    expect(thumbnailWrite).toContain('r.deck_attempt_id = $4::uuid');
    expect(thumbnails).toContain('setMatchThumbnails(attached, input.attemptFence)');
    expect(handler).toContain('attemptFence: { requestId: clipRequestId, deckAttemptId }');
  });

"""
    if test_block.strip() not in text:
        if anchor not in text:
            raise RuntimeError("test insertion anchor not found")
        text = text.replace(anchor, test_block + anchor, 1)
    path.write_text(text)


if __name__ == "__main__":
    patch_repo()
    patch_handler()
    patch_thumbnails()
    patch_tests()
