import { queryOne, queryRows } from '../pool.js';
import type {
  AnsweredFrom,
  ChunkDegradation,
  ChunkError,
  ClipMatch,
  ClipRequest,
  ClipRequestStatus,
  MatchFeedback,
  MatchFeedbackReason,
  MatchSource,
  ResolvedSearchMode,
  SearchMode,
  UncertainMatch,
} from '../../domain/types.js';

interface ClipRequestRow {
  id: string;
  video_id: string;
  session_id: string | null;
  user_id: string | null;
  workspace_id: string | null;
  instruction: string;
  mode: SearchMode;
  resolved_mode: ResolvedSearchMode | null;
  status: ClipRequestStatus;
  error_message: string | null;
  chunks_total: number;
  chunks_completed: number;
  chunks_failed: number;
  chunk_errors: ChunkError[];
  chunk_degradations: ChunkDegradation[] | null;
  answered_from: AnsweredFrom | null;
  uncertain_matches: UncertainMatch[] | null;
  presentation_target: 'original' | 'vertical' | null;
  requested_result_count: number | null;
  available_candidate_count: number | null;
  effective_deck_target: number | null;
  deck_completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function mapRequest(row: ClipRequestRow): ClipRequest {
  return {
    id: row.id,
    videoId: row.video_id,
    sessionId: row.session_id,
    userId: row.user_id,
    workspaceId: row.workspace_id,
    instruction: row.instruction,
    mode: row.mode,
    resolvedMode: row.resolved_mode,
    status: row.status,
    errorMessage: row.error_message,
    chunksTotal: row.chunks_total,
    chunksCompleted: row.chunks_completed,
    chunksFailed: row.chunks_failed,
    chunkDegradations: row.chunk_degradations ?? [],
    chunkErrors: row.chunk_errors ?? [],
    answeredFrom: row.answered_from ?? null,
    uncertainMatches: row.uncertain_matches ?? [],
    presentationTarget: row.presentation_target ?? null,
    requestedResultCount: row.requested_result_count ?? null,
    availableCandidateCount: row.available_candidate_count ?? null,
    effectiveDeckTarget: row.effective_deck_target ?? null,
    deckCompletedAt: row.deck_completed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createClipRequest(input: {
  videoId: string;
  sessionId: string | null;
  userId?: string | null;
  instruction: string;
  mode: SearchMode;
}): Promise<ClipRequest> {
  const row = await queryOne<ClipRequestRow>(
    // The workspace comes from the video, not the asker: a question about a
    // team's video belongs to that team, whichever room the asker is in.
    `INSERT INTO clip_requests (video_id, session_id, user_id, workspace_id, instruction, mode)
     VALUES ($1, $2, $3, (SELECT workspace_id FROM videos WHERE id = $1), $4, $5)
     RETURNING *`,
    [input.videoId, input.sessionId, input.userId ?? null, input.instruction, input.mode],
  );
  return mapRequest(row!);
}

export async function getClipRequest(requestId: string): Promise<ClipRequest | null> {
  const row = await queryOne<ClipRequestRow>('SELECT * FROM clip_requests WHERE id = $1', [requestId]);
  return row ? mapRequest(row) : null;
}

/**
 * Every question asked about one video, in the order it appeared in the chat.
 *
 * This is deliberately scoped by the video at the repository boundary. The
 * route checks ownership of that video before calling it, and callers never
 * have to reconstruct a conversation from request ids kept in browser memory.
 */
export async function listClipRequestsForVideo(videoId: string): Promise<ClipRequest[]> {
  const rows = await queryRows<ClipRequestRow>(
    `SELECT * FROM clip_requests
      WHERE video_id = $1
      ORDER BY created_at ASC, id ASC`,
    [videoId],
  );
  return rows.map(mapRequest);
}

export async function startClipRequest(
  requestId: string,
  input: { chunksTotal: number; resolvedMode: ResolvedSearchMode },
): Promise<void> {
  await queryOne(
    `UPDATE clip_requests
        SET status = 'searching',
            resolved_mode = $2,
            chunks_total = $3,
            chunks_completed = 0,
            chunks_failed = 0,
            chunk_errors = '[]'::jsonb,
            -- Cleared with everything else. A retry re-observes the same
            -- borderline moments, and without this they accumulate: the same
            -- maybe listed twice, eventually filling the cap and crowding out
            -- the distinct ones the successful attempt found.
            uncertain_matches = '[]'::jsonb,
            error_message = NULL,
            updated_at = now()
      WHERE id = $1`,
    [requestId, input.resolvedMode, input.chunksTotal],
  );
}

export async function recordChunkCompleted(requestId: string): Promise<void> {
  await queryOne(
    `UPDATE clip_requests SET chunks_completed = chunks_completed + 1, updated_at = now() WHERE id = $1`,
    [requestId],
  );
}

/** A failed chunk is recorded and skipped — it never fails the whole search. */
export async function recordChunkFailure(requestId: string, error: ChunkError): Promise<void> {
  await queryOne(
    `UPDATE clip_requests
        SET chunks_failed = chunks_failed + 1,
            chunk_errors = chunk_errors || $2::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [requestId, JSON.stringify([error])],
  );
}

/**
 * Records that a chunk was searched, but with less evidence than intended.
 *
 * Deliberately does not touch chunks_failed: the chunk completed and its
 * matches are real. What is lost is the ability to check a spoken condition
 * inside that window, which the response reports as a caveat rather than a
 * gap.
 */
export async function recordChunkDegraded(requestId: string, degradation: ChunkDegradation): Promise<void> {
  await queryOne(
    `UPDATE clip_requests
        SET chunk_degradations = chunk_degradations || $2::jsonb,
            updated_at = now()
      WHERE id = $1`,
    [requestId, JSON.stringify([degradation])],
  );
}

/**
 * Records moments the threshold discarded, so the answer can mention them.
 *
 * Capped, and the cap is deliberate: this is a footnote to an answer, not a
 * second result list. Five borderline moments is already more than anyone
 * reads, and the log carries the full count.
 */
export async function recordUncertainMatches(
  requestId: string,
  matches: UncertainMatch[],
): Promise<void> {
  if (matches.length === 0) return;
  await queryOne(
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
      WHERE id = $1`,
    [requestId, JSON.stringify(matches)],
  );
}

/**
 * Records what this question can teach us, before the footage goes.
 *
 * `notesConsulted` separates two answers that otherwise look identical: the
 * notes were read and had nothing, versus there were no notes to read. Only
 * the first says anything about whether reading at upload is working.
 */
export async function recordSearchApproach(
  requestId: string,
  input: { notesConsulted: boolean; correctionOf?: string | null },
): Promise<void> {
  await queryOne(
    `UPDATE clip_requests
        SET notes_consulted = $2,
            corrected_request_id = COALESCE($3, corrected_request_id),
            updated_at = now()
      WHERE id = $1`,
    [requestId, input.notesConsulted, input.correctionOf ?? null],
  );
}

/**
 * Declare that this request owes a post-ready deck — before a single
 * candidate is rendered.
 *
 * The ordering is the whole point. If the target were written after the first
 * clip finished, a client polling in that gap would see a request that does
 * not yet know it is a deck request, fall through to the legacy path, and be
 * handed one finished card. That is the progressive reveal the rule forbids,
 * and it would appear only under load, only sometimes.
 *
 * deck_completed_at is CLEARED here on purpose. A retrying job re-plans and
 * re-renders, and serving the previous run's finished deck while the new one
 * is mid-flight would show a set that no longer matches the clips underneath.
 */
export async function recordDeckPlan(
  requestId: string,
  plan: { presentationTarget: 'original' | 'vertical'; requestedResultCount: number },
): Promise<string> {
  // Returns a token identifying THIS planning. Only the run holding it may
  // later open the gate — see markDeckComplete.
  const row = await queryOne<{ deck_attempt_id: string }>(
    `UPDATE clip_requests
        SET presentation_target      = $2,
            requested_result_count   = $3,
            available_candidate_count = NULL,
            effective_deck_target    = NULL,
            deck_completed_at        = NULL,
            deck_attempt_id          = gen_random_uuid(),
            updated_at               = now()
      WHERE id = $1
      RETURNING deck_attempt_id`,
    [requestId, plan.presentationTarget, plan.requestedResultCount],
  );
  if (!row) throw new Error(`Clip request ${requestId} disappeared while planning its deck`);
  return row.deck_attempt_id;
}

/**
 * What the search actually turned up, and the deck size that follows from it.
 *
 * Recorded even when it is smaller than the ask: "you wanted three, your video
 * had two" is a fact about their footage and has to stay legible as that,
 * rather than being flattened into a failure or silently rounded away.
 */
export async function recordDeckAvailability(
  requestId: string,
  counts: { availableCandidateCount: number; effectiveDeckTarget: number },
  /** Fenced like the gate: a superseded attempt must not rewrite these. */
  attemptId: string | null,
): Promise<void> {
  await queryOne(
    `UPDATE clip_requests
        SET available_candidate_count = $2,
            effective_deck_target     = $3,
            updated_at                = now()
      WHERE id = $1
        AND ($4::uuid IS NULL OR deck_attempt_id = $4::uuid)`,
    [requestId, counts.availableCandidateCount, counts.effectiveDeckTarget, attemptId],
  );
}

/**
 * The gate opens. Called only once every moment in the effective deck is
 * finished AND persisted, so there is no instant in which this says yes and
 * the clips behind it are not there.
 */
export async function markDeckComplete(requestId: string, attemptId: string): Promise<boolean> {
  // Fenced to the attempt that planned this deck.
  //
  // A stalled job is redelivered while the first run is still assembling. The
  // second run re-plans — taking a new token — clears the first run's work and
  // renders its own deck. The first run, still executing and unaware it was
  // superseded, would otherwise reach this line and open the creator-facing
  // gate over the second run's half-built deck: the progressive reveal the
  // whole set-level rule exists to forbid.
  //
  // A superseded run matches no row and changes nothing, which is exactly
  // right. The caller is told, so it can say so rather than assume it won.
  const row = await queryOne<{ id: string }>(
    `UPDATE clip_requests
        SET deck_completed_at = now(), updated_at = now()
      WHERE id = $1 AND deck_attempt_id = $2
      RETURNING id`,
    [requestId, attemptId],
  );
  return row !== null;
}

export async function finishClipRequest(
  requestId: string,
  status: ClipRequestStatus,
  errorMessage: string | null = null,
  answeredFrom: AnsweredFrom | null = null,
  /**
   * The attempt allowed to write this final answer.
   *
   * Overlapping deliveries mean two runs can both reach a terminal write. A
   * superseded one finishing last would stamp its outcome over the run that
   * replaced it — most damagingly a stale FAILURE landing on a newer success,
   * which leaves a complete deck sitting behind a request marked failed and
   * a creator unable to Keep any of it.
   *
   * Null means the caller holds no claim — the paths that fail before any
   * deck is planned. Those are NOT simply unfenced: an older delivery that
   * dies early still carries a null token, and letting it write freely was
   * the same overwrite by another door. It marked a newer, finished answer
   * failed and hid its clips.
   *
   * So a claimless write may not land on a request that has already
   * completed. It stays allowed on one still searching or already failed,
   * because refusing there would strand a request in 'searching' forever when
   * the only run that could speak for it died before planning.
   */
  attemptId: string | null = null,
): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    `UPDATE clip_requests
        SET status = $2,
            error_message = $3,
            answered_from = COALESCE($4, answered_from),
            updated_at = now()
      WHERE id = $1
        AND ($5::uuid IS NOT NULL
             OR status <> 'completed')
        AND ($5::uuid IS NULL OR deck_attempt_id = $5::uuid)
      RETURNING id`,
    [requestId, status, errorMessage, answeredFrom, attemptId],
  );
  return row !== null;
}

/**
 * The question a correction refers to: the last one this person asked about
 * this video before the correction itself.
 *
 * Scoped to the session, not just the video, because "are you sure?" refers to
 * the answer THIS person was given — picking up someone else's question about
 * the same video would silently search for something they never asked.
 */
export async function getPreviousClipRequest(input: {
  videoId: string;
  sessionId: string | null;
  userId?: string | null;
  before: Date;
}): Promise<ClipRequest | null> {
  // A signed-in person's "are you sure?" refers to THEIR last question, even
  // from a new tab with a fresh session. A guest's can only mean this tab's.
  const row = input.userId
    ? await queryOne<ClipRequestRow>(
        `SELECT * FROM clip_requests
          WHERE video_id = $1 AND user_id = $2 AND created_at < $3
          ORDER BY created_at DESC
          LIMIT 1`,
        [input.videoId, input.userId, input.before],
      )
    : await queryOne<ClipRequestRow>(
        `SELECT * FROM clip_requests
          WHERE video_id = $1
            AND session_id IS NOT DISTINCT FROM $2
            AND created_at < $3
          ORDER BY created_at DESC
          LIMIT 1`,
        [input.videoId, input.sessionId, input.before],
      );
  return row ? mapRequest(row) : null;
}

interface ClipMatchRow {
  id: string;
  clip_request_id: string;
  chunk_id: string;
  local_start_seconds: number;
  local_end_seconds: number;
  global_start_seconds: number;
  global_end_seconds: number;
  description: string;
  confidence: number;
  source: MatchSource;
  quote: string | null;
  thumbnail_key: string | null;
  feedback: MatchFeedback | null;
  feedback_reason: MatchFeedbackReason | null;
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
  reclip_status: 'pending' | 'failed' | null;
  reclip_error: string | null;
  reclip_attempts: number | null;
  created_at: Date;
}

function mapMatch(row: ClipMatchRow): ClipMatch {
  return {
    id: row.id,
    clipRequestId: row.clip_request_id,
    chunkId: row.chunk_id,
    localStartSeconds: row.local_start_seconds,
    localEndSeconds: row.local_end_seconds,
    globalStartSeconds: row.global_start_seconds,
    globalEndSeconds: row.global_end_seconds,
    description: row.description,
    confidence: row.confidence,
    source: row.source,
    quote: row.quote,
    thumbnailKey: row.thumbnail_key ?? null,
    feedback: row.feedback ?? null,
    feedbackReason: row.feedback_reason ?? null,
    provider: row.provider ?? null,
    model: row.model ?? null,
    promptVersion: row.prompt_version ?? null,
    reclipStatus: row.reclip_status ?? null,
    reclipError: row.reclip_error ?? null,
    reclipAttempts: row.reclip_attempts ?? 0,
    createdAt: row.created_at,
  };
}

export interface NewClipMatch {
  chunkId: string;
  localStartSeconds: number;
  localEndSeconds: number;
  globalStartSeconds: number;
  globalEndSeconds: number;
  description: string;
  confidence: number;
  source: MatchSource;
  quote?: string | null;
  /**
   * Which call produced this moment. Optional so callers that predate the
   * evaluation layer still compile, but every live search path sets them —
   * feedback can only be pinned on a model when the row names one.
   */
  provider?: string | null;
  model?: string | null;
  promptVersion?: string | null;
}

export async function insertMatches(requestId: string, matches: NewClipMatch[]): Promise<ClipMatch[]> {
  if (matches.length === 0) return [];

  const values: string[] = [];
  const params: unknown[] = [requestId];

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
     ) VALUES ${values.join(', ')}
     RETURNING *`,
    params,
  );
  return rows.map(mapMatch);
}

/**
 * Attaches stills to matches, one statement rather than one per match.
 *
 * Thumbnails are decoration: a failure here must not disturb a search that has
 * already found and stored its results, so the caller treats this as
 * best-effort.
 */
export async function setMatchThumbnails(
  thumbnails: Array<{ matchId: string; thumbnailKey: string }>,
): Promise<void> {
  if (thumbnails.length === 0) return;
  await queryOne(
    `UPDATE clip_matches AS m
        SET thumbnail_key = v.thumbnail_key
       FROM (SELECT * FROM unnest($1::uuid[], $2::text[]) AS t(id, thumbnail_key)) AS v
      WHERE m.id = v.id`,
    [thumbnails.map((t) => t.matchId), thumbnails.map((t) => t.thumbnailKey)],
  );
}

/**
 * Videos holding matches that were found before stills existed.
 *
 * Grouped by video because the frames all come from one proxy: doing this per
 * match would download the same file once per row. Videos whose proxy is gone
 * are excluded — there is nothing left to extract from, and reporting them as
 * pending work would never converge.
 */
export async function listVideosMissingThumbnails(
  limit: number,
): Promise<Array<{ videoId: string; proxyStorageKey: string; missing: number }>> {
  const rows = await queryRows<{ video_id: string; proxy_storage_key: string; missing: number }>(
    `SELECT v.id AS video_id, v.proxy_storage_key, COUNT(m.id)::int AS missing
       FROM clip_matches m
       JOIN clip_requests r ON r.id = m.clip_request_id
       JOIN videos v ON v.id = r.video_id
      WHERE m.thumbnail_key IS NULL AND v.proxy_storage_key IS NOT NULL
      GROUP BY v.id, v.proxy_storage_key
      ORDER BY MAX(m.created_at) DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((row) => ({
    videoId: row.video_id,
    proxyStorageKey: row.proxy_storage_key,
    missing: row.missing,
  }));
}

/** Every match of a video still waiting for a still, across all its searches. */
export async function listMatchesMissingThumbnails(videoId: string): Promise<ClipMatch[]> {
  const rows = await queryRows<ClipMatchRow>(
    `SELECT m.* FROM clip_matches m
       JOIN clip_requests r ON r.id = m.clip_request_id
      WHERE r.video_id = $1 AND m.thumbnail_key IS NULL
      ORDER BY m.global_start_seconds ASC`,
    [videoId],
  );
  return rows.map(mapMatch);
}

/**
 * Records what a person thought of a match, or clears it.
 *
 * Scoped to the request as well as the match so a guessed match id cannot be
 * marked from another user's search. The row is never deleted: a rejected
 * moment is the only record of the model being wrong, which is the evidence
 * this column exists to collect.
 */
export async function setMatchFeedback(
  requestId: string,
  matchId: string,
  feedback: MatchFeedback | null,
  reason: MatchFeedbackReason | null = null,
): Promise<ClipMatch | null> {
  // A reason only ever accompanies a rejection. Clearing the verdict clears
  // the reason with it, and approving does too — "approved, because the
  // timing was off" is not a state this table should be able to describe.
  const storedReason = feedback === 'rejected' ? reason : null;
  const row = await queryOne<ClipMatchRow>(
    `UPDATE clip_matches
        SET feedback = $3,
            feedback_reason = $4,
            feedback_at = CASE WHEN $3::text IS NULL THEN NULL ELSE now() END
      WHERE clip_request_id = $1 AND id = $2
      RETURNING *`,
    [requestId, matchId, feedback, storedReason],
  );
  return row ? mapMatch(row) : null;
}

/** Every still cut from this video, across all its searches. */
export async function listThumbnailKeysForVideo(videoId: string): Promise<string[]> {
  const rows = await queryRows<{ thumbnail_key: string }>(
    `SELECT m.thumbnail_key
       FROM clip_matches m
       JOIN clip_requests r ON r.id = m.clip_request_id
      WHERE r.video_id = $1 AND m.thumbnail_key IS NOT NULL`,
    [videoId],
  );
  return rows.map((row) => row.thumbnail_key);
}

/**
 * Forgets the stills while keeping the matches.
 *
 * The matches carry the human verdict on each moment, which is the whole point
 * of keeping anything after the footage goes.
 */
export async function clearThumbnailsForVideo(videoId: string): Promise<void> {
  await queryOne(
    `UPDATE clip_matches AS m
        SET thumbnail_key = NULL
       FROM clip_requests r
      WHERE r.id = m.clip_request_id AND r.video_id = $1`,
    [videoId],
  );
}

export async function listMatches(requestId: string): Promise<ClipMatch[]> {
  const rows = await queryRows<ClipMatchRow>(
    'SELECT * FROM clip_matches WHERE clip_request_id = $1 ORDER BY global_start_seconds ASC',
    [requestId],
  );
  return rows.map(mapMatch);
}

export async function listMatchesByIds(requestId: string, matchIds: string[]): Promise<ClipMatch[]> {
  if (matchIds.length === 0) return [];
  const rows = await queryRows<ClipMatchRow>(
    `SELECT * FROM clip_matches
      WHERE clip_request_id = $1 AND id = ANY($2::uuid[])
      ORDER BY global_start_seconds ASC`,
    [requestId, matchIds],
  );
  return rows.map(mapMatch);
}


/**
 * What the last day of use taught us. See docs/learning-loop.md.
 *
 * Deliberately an aggregate plus a verbatim list. The numbers say whether
 * reading at upload is paying off; the list of questions the notes could not
 * answer is the part worth actually reading, because each one is something a
 * person wanted from their video that nobody thought to write down.
 */
export interface LearningSummary {
  answeredFromNotes: number;
  answeredFromFootage: number;
  corrections: number;
  notesSilent: number;
  approved: number;
  rejected: number;
  averageConfidenceApproved: number | null;
  averageConfidenceRejected: number | null;
  questionsNotesCouldNotAnswer: string[];
}

export async function summariseLearning(sinceHours: number): Promise<LearningSummary> {
  const interval = `${Math.max(1, Math.floor(sinceHours))} hours`;

  const requests = await queryOne<{
    from_notes: number;
    from_footage: number;
    corrections: number;
    notes_silent: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE answered_from = 'notes')::int AS from_notes,
       count(*) FILTER (WHERE answered_from = 'footage')::int AS from_footage,
       count(*) FILTER (WHERE corrected_request_id IS NOT NULL)::int AS corrections,
       -- The notes were read and had nothing. Not the same as having no notes.
       count(*) FILTER (
         WHERE notes_consulted AND answered_from = 'footage' AND corrected_request_id IS NULL
       )::int AS notes_silent
     FROM clip_requests
     WHERE status = 'completed' AND created_at >= now() - $1::interval`,
    [interval],
  );

  const verdicts = await queryOne<{
    approved: number;
    rejected: number;
    avg_approved: number | null;
    avg_rejected: number | null;
  }>(
    `SELECT
       count(*) FILTER (WHERE feedback = 'approved')::int AS approved,
       count(*) FILTER (WHERE feedback = 'rejected')::int AS rejected,
       avg(confidence) FILTER (WHERE feedback = 'approved') AS avg_approved,
       avg(confidence) FILTER (WHERE feedback = 'rejected') AS avg_rejected
     FROM clip_matches
     WHERE feedback IS NOT NULL AND feedback_at >= now() - $1::interval`,
    [interval],
  );

  const silent = await queryRows<{ instruction: string }>(
    `SELECT instruction
       FROM clip_requests
      WHERE status = 'completed'
        AND notes_consulted
        AND answered_from = 'footage'
        AND corrected_request_id IS NULL
        AND created_at >= now() - $1::interval
      ORDER BY created_at DESC
      LIMIT 20`,
    [interval],
  );

  return {
    answeredFromNotes: requests?.from_notes ?? 0,
    answeredFromFootage: requests?.from_footage ?? 0,
    corrections: requests?.corrections ?? 0,
    notesSilent: requests?.notes_silent ?? 0,
    approved: verdicts?.approved ?? 0,
    rejected: verdicts?.rejected ?? 0,
    averageConfidenceApproved: verdicts?.avg_approved === null || verdicts?.avg_approved === undefined
      ? null
      : Number(Number(verdicts.avg_approved).toFixed(3)),
    averageConfidenceRejected: verdicts?.avg_rejected === null || verdicts?.avg_rejected === undefined
      ? null
      : Number(Number(verdicts.avg_rejected).toFixed(3)),
    questionsNotesCouldNotAnswer: silent.map((row) => row.instruction),
  };
}
