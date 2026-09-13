import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards over the SQL that keep a retried or superseded search from doing
 * damage. They lived in the deck orchestration's test file, which went with
 * the orchestration; the rules they pin did not go anywhere.
 */

const repo = readFileSync(path.join(__dirname, '..', 'src/db/repositories/clipRequests.ts'), 'utf8');
const media = readFileSync(path.join(__dirname, '..', 'src/db/repositories/verticalMedia.ts'), 'utf8');
const handler = readFileSync(path.join(__dirname, '..', 'src/worker/handlers/clipSearch.ts'), 'utf8');

const between = (src: string, from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to));

describe('a retry must never reach into the library', () => {
  /**
   * clips.clip_match_id is ON DELETE CASCADE. A stalled search job can be
   * redelivered AFTER the request completed and after somebody pressed Keep,
   * and the retry clears the previous attempt's matches. Only keeping the
   * MATCH keeps the clip, and only keeping the clip keeps its files
   * reachable: one decision, not three. With production on Keep this
   * matters more, not less — the approval is written before the file
   * exists, and this is what protects a kept-but-uncut moment.
   */
  it('is one decision: keep the match, keep the clip, keep its files', () => {
    const clear = media.slice(media.indexOf('export async function clearUnkeptMatchesForRequest'));
    expect(clear).toContain('NOT EXISTS');
    expect(clear).toContain('approved_at IS NOT NULL');
    // One statement: a separate read and delete lets an approval land between.
    expect(clear).toContain('WITH doomed AS');
    expect(clear).toContain('DELETE FROM clip_matches');
  });

  it('Keep records the approval unconditionally and first, so the protection exists before the render does', () => {
    const approve = between(media, 'export async function approveClipOnKeep', 'export async function undoKeepNotQueued');
    expect(approve).toContain('approved_at     = COALESCE(approved_at, now())');
    expect(approve).not.toContain("status = 'ready'");
  });
});

describe('a superseded attempt must not release an answer', () => {
  it('cannot add stale coverage gaps after a newer delivery takes ownership', () => {
    const failure = between(repo, 'export async function recordChunkFailure', '/**\n * Records that a chunk was searched');
    expect(failure).toContain('deck_attempt_id = $3::uuid');
    expect(failure).toContain('RETURNING id');

    const simpleMem = between(handler, 'async function answerFromSimpleMem', 'async function answerFromVideoChat3');
    expect(simpleMem).toContain('recordChunkFailure(input.clipRequestId');
    expect(simpleMem).toContain('input.deckAttemptId!');
    expect(simpleMem).toContain('discarding stale SimpleMem coverage');

    const videoChat3 = between(handler, 'async function answerFromVideoChat3', 'async function searchSingleChunk');
    expect(videoChat3).toContain('recordChunkFailure(input.clipRequestId');
    expect(videoChat3).toContain('input.deckAttemptId!');
    expect(videoChat3).toContain('discarding stale VideoChat3 coverage');
  });

  it('fences the release to the attempt that planned it, and releases and completes in one statement', () => {
    const release = between(repo, 'export async function releaseDeckAndComplete', 'export async function recordDeckAvailability');
    expect(release).toContain('deck_attempt_id = $2');
    expect(release).toContain('RETURNING id');
    expect(release).toContain('deck_completed_at = now()');
    expect(release).toContain("status            = 'completed'");
    expect(release).not.toContain('retrieval_primary IS NOT NULL');
  });

  it('does not serialize an answer until its fenced release completes', () => {
    const serializers = readFileSync(path.join(__dirname, '..', 'src/api/serializers.ts'), 'utf8');
    expect(serializers).toContain("request.status === 'completed' && request.conversationalAnswer");
  });

  it('fences every terminal status write to the owning attempt', () => {
    const finish = between(repo, 'export async function finishClipRequest', 'export async function getPreviousClipRequest');
    expect(finish).toContain('deck_attempt_id = $5::uuid');
    expect(finish).toContain('$5::uuid IS NULL');
    expect(finish).toContain('deck_attempt_id IS NULL');
    expect(finish).not.toContain("status <> 'completed'");
    expect(finish).toContain('RETURNING id');
    expect(finish).toContain("answer_text = CASE WHEN $2 = 'failed' THEN NULL");
  });

  it('claims on entry, before the first thing that can fail, and plans against that claim', () => {
    const claim = between(repo, 'export async function claimClipRequestAttempt', 'export async function recordDeckPlan');
    expect(claim).toContain('gen_random_uuid()');
    // Never over a finished answer.
    expect(claim).toContain("status <> 'completed'");
    expect(claim).toContain('deck_completed_at IS NULL');

    const plan = between(repo, 'export async function recordDeckPlan', 'export async function releaseDeckAndComplete');
    expect(plan).not.toContain('gen_random_uuid()');
    expect(plan).toContain('deck_attempt_id = $4');

    expect(handler.indexOf('claimClipRequestAttempt(clipRequestId)'))
      .toBeLessThan(handler.indexOf('const video = await getVideo(request.videoId)'));
  });
});

describe('a question may be sent before the video is prepared', () => {
  it('the search parks the question and looks again, rather than refusing it', () => {
    expect(handler).toContain('preparationWait(video.status, preparationWaitedMs, env.PREPARATION_WAIT_TIMEOUT_MS)');
    // Its own allowance: preparation waiting is tracked separately from
    // the transcript wait, so a slow upload cannot consume speech-evidence
    // time once the video is ready.
    expect(handler).toContain('{ clipRequestId, waitedMs, preparationWaitedMs: preparationWaitedMs + env.PREPARATION_WAIT_POLL_MS }');
    // The wait comes BEFORE the segment list is read — there is nothing to
    // read until the video is prepared.
    expect(handler.indexOf('preparationWait(video.status')).toBeLessThan(handler.indexOf('const chunks = await listChunks(video.id)'));
  });
});

describe('an uploaded video is read by VideoChat3 before anything re-reads it per chunk', () => {
  /**
   * The order is the product: memory is asked first (a hit is verified
   * against the footage), the footage is then watched the way an internet
   * video is, and the per-chunk search — many model calls over the same
   * video — runs only for a question about speech or when the watch itself
   * failed. A watch that verified nothing completes the request: it read
   * every second, so its silence is a finding, not a memory's blank.
   */
  it('asks memory, then watches, and only then falls back to the per-chunk search', () => {
    const memory = handler.indexOf('const fromSimpleMem = await answerFromSimpleMem(');
    const watch = handler.indexOf('const fromVideoChat3 = await answerFromVideoChat3(');
    const perChunk = handler.indexOf('mapWithConcurrency(chunks, env.OPENROUTER_VIDEO_CONCURRENCY');
    expect(memory).toBeGreaterThan(-1);
    expect(watch).toBeGreaterThan(memory);
    expect(perChunk).toBeGreaterThan(watch);
  });

  it('completes on the watch\'s own answer, and hands on speech only — never a failure', () => {
    const videoChat3 = between(handler, 'async function answerFromVideoChat3', 'async function searchSingleChunk');
    expect(videoChat3).toContain("if (input.mode === 'transcript') {");
    expect(videoChat3).toContain("fallback: 'unsupported_mode'");
    // A failed watch is a whole-video coverage gap; a failed signing is a
    // failed delivery the queue retries. Neither is a reason to read the
    // video with the retired per-chunk watcher.
    expect(videoChat3).not.toContain("fallback: 'primary_failed'");
    expect(videoChat3).not.toContain("fallback: 'no_candidates'");
    expect(videoChat3).toContain("answeredFrom: 'footage'");
    expect(videoChat3).toContain("retrievalSystem: 'videochat3'");
    // A memory miss is consulted, then watched; both hand-offs are recorded.
    expect(handler).toContain("primary: 'videochat3',\n          system: 'videochat3',");
    expect(handler).toContain("fallbackReason: fromVideoChat3.fallback,");
  });

  it('never reports the seconds after the watch cap as empty', () => {
    const videoChat3 = between(handler, 'async function answerFromVideoChat3', 'async function searchSingleChunk');
    expect(videoChat3).toContain('if (analysis.unwatched) {');
    expect(videoChat3).toContain("code: 'not_read_yet'");
    expect(videoChat3).toContain('coverageFailuresDescribed: unread || analysis.unwatched ? 1 : 0');
  });

  it('memory stays a memory: consulted under the VideoChat3 primary only when uploads are indexed', () => {
    const simpleMem = between(handler, 'async function answerFromSimpleMem', 'async function answerFromVideoChat3');
    expect(simpleMem).toContain("(env.RETRIEVAL_PRIMARY === 'videochat3' && env.SIMPLEMEM_INDEX_ENABLED)");
  });
});
