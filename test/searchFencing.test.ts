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
  it('fences the release to the attempt that planned it, and releases and completes in one statement', () => {
    const release = between(repo, 'export async function releaseDeckAndComplete', 'export async function recordDeckAvailability');
    expect(release).toContain('deck_attempt_id = $2');
    expect(release).toContain('RETURNING id');
    expect(release).toContain('deck_completed_at = now()');
    expect(release).toContain("status            = 'completed'");
  });

  it('fences every terminal status write to the owning attempt', () => {
    const finish = between(repo, 'export async function finishClipRequest', 'export async function getPreviousClipRequest');
    expect(finish).toContain('deck_attempt_id = $5::uuid');
    expect(finish).toContain('$5::uuid IS NULL');
    expect(finish).toContain('deck_attempt_id IS NULL');
    expect(finish).not.toContain("status <> 'completed'");
    expect(finish).toContain('RETURNING id');
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
    expect(handler).toContain('preparationWait(video.status, waitedMs, env.PREPARATION_WAIT_TIMEOUT_MS)');
    expect(handler).toContain('waitedMs: waitedMs + env.PREPARATION_WAIT_POLL_MS');
    // The wait comes BEFORE the segment list is read — there is nothing to
    // read until the video is prepared.
    expect(handler.indexOf('preparationWait(video.status')).toBeLessThan(handler.indexOf('const chunks = await listChunks(video.id)'));
  });
});
