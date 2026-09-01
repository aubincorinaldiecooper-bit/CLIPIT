import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleDeck, deckCompletion, planDeck, type PreparedCandidate } from '../src/services/media/deckAssembly.js';
import { keepAction, retentionClassFor } from '../src/services/media/keepApproval.js';
import { clipMediaContract } from '../src/api/mediaContract.js';
import { creatorVisibleDeck } from '../src/api/serializers.js';
import { exceedsPlatformHardMax, resolvePlatformIntent, needsVerticalDerivative } from '../src/services/search/platformIntent.js';
import type { VerticalCandidate } from '../src/services/media/verticalVisibility.js';

/**
 * The runtime path, end to end, with the expensive middle replaced.
 *
 * These are the decisions the orchestrator makes on the way from "Find me 3
 * moments I can post on TikTok" to three finished files. Cutting video and
 * calling a GPU are not decisions, so they are stubbed; everything that IS a
 * decision runs for real.
 */

function candidate(id: string, confidence: number): VerticalCandidate {
  return {
    matchId: id,
    confidence,
    derivativeStatus: 'pending',
    derivativeStorageKey: null,
    posterStorageKey: null,
  };
}

function ready(c: VerticalCandidate, attempt = 1): PreparedCandidate {
  return {
    ...c,
    derivativeStatus: 'ready',
    derivativeStorageKey: `vertical/${c.matchId}.mp4`,
    posterStorageKey: `poster/${c.matchId}.jpg`,
    attempts: attempt,
    failureStage: null,
  };
}

function failed(c: VerticalCandidate, attempt = 1, stage = 'smart_crop_render' as const): PreparedCandidate {
  return { ...c, derivativeStatus: 'failed', attempts: attempt, failureStage: stage };
}

describe('the request that started this: "Find me 3 moments I can post on TikTok"', () => {
  it('is read as a vertical ask for three', () => {
    const intent = resolvePlatformIntent('Find me 3 moments I can post on TikTok', 90);
    expect(needsVerticalDerivative(intent)).toBe(true);
    expect(intent.requestedCount).toBe(3);
  });

  it('renders the top three and stops', async () => {
    const pool = [candidate('a', 0.9), candidate('b', 0.8), candidate('c', 0.7), candidate('d', 0.6)];
    const touched: string[] = [];

    const outcome = await assembleDeck(
      pool,
      planDeck(3, 1.7, 8),
      async (c) => { touched.push(c.matchId); return ready(c); },
      2,
    );

    expect(outcome.complete).toBe(true);
    expect(outcome.deck.map((d) => d.matchId)).toEqual(['a', 'b', 'c']);
    // The fourth candidate is a real cut, a real GPU call and a real encode.
    // Nothing touches it while three are succeeding.
    expect(touched).toEqual(['a', 'b', 'c']);
  });

  it('backfills from the pool when one fails, and still shows three', async () => {
    const pool = [candidate('a', 0.9), candidate('b', 0.8), candidate('c', 0.7), candidate('d', 0.6)];

    const outcome = await assembleDeck(
      pool,
      planDeck(3, 1.7, 8),
      // 'b' fails both attempts; 'd' is reached because of it.
      async (c, attempt) => (c.matchId === 'b' ? failed(c, attempt) : ready(c, attempt)),
      2,
    );

    expect(outcome.complete).toBe(true);
    expect(outcome.deck.map((d) => d.matchId)).toEqual(['a', 'c', 'd']);
    expect(outcome.failed.map((d) => d.matchId)).toEqual(['b']);
    expect(outcome.backfillCount).toBe(1);
  });

  /**
   * The rule the whole design exists for. Two finished cards when three were
   * asked for is a partial reveal, and the creator gets nothing instead —
   * with the request reported as our failure, not as an empty video.
   */
  it('returns an EMPTY deck rather than a short one', async () => {
    const pool = [candidate('a', 0.9), candidate('b', 0.8)];

    const outcome = await assembleDeck(
      pool,
      planDeck(3, 1.7, 8),
      async (c, attempt) => (c.matchId === 'a' ? ready(c, attempt) : failed(c, attempt)),
      2,
    );

    expect(outcome.complete).toBe(false);
    expect(outcome.deck).toEqual([]);
  });
});

describe('what is filtered before anything is paid for', () => {
  it('drops candidates the platform would refuse', () => {
    const intent = resolvePlatformIntent('clip this for tiktok', 90);
    // 85 seconds against TikTok's 60-second ceiling.
    expect(exceedsPlatformHardMax({ startSeconds: 10, endSeconds: 95 }, intent)).toBe(true);
    expect(exceedsPlatformHardMax({ startSeconds: 10, endSeconds: 50 }, intent)).toBe(false);
  });

  it('leaves non-platform requests entirely alone', () => {
    const intent = resolvePlatformIntent('find the bit where the dog barks', 90);
    expect(needsVerticalDerivative(intent)).toBe(false);
    expect(exceedsPlatformHardMax({ startSeconds: 0, endSeconds: 89 }, intent)).toBe(false);
  });

  it('honours "keep the original framing" over the platform word', () => {
    const intent = resolvePlatformIntent('post a 30 second clip to tiktok but keep the original framing', 90);
    expect(intent.platform).toBe('tiktok');
    // Duration rules still apply; the crop does not.
    expect(needsVerticalDerivative(intent)).toBe(false);
    expect(intent.hardMaxSeconds).toBe(30);
  });
});

describe('Keep, on a moment that was already made', () => {
  const finished = {
    preRendered: true,
    derivativeStatus: 'ready' as const,
    derivativeStorageKey: 'vertical/a.mp4',
    posterStorageKey: 'poster/a.jpg',
    clipStatus: 'ready' as const,
  };

  it('approves without re-rendering anything', () => {
    expect(keepAction(finished)).toEqual({ kind: 'approve', regenerate: false });
  });

  it('turns a temporary file into an owned one', () => {
    expect(retentionClassFor({ approved: false, preRendered: true })).toBe('temporary');
    expect(retentionClassFor({ approved: true, preRendered: true })).toBe('owned');
    // A clip cut the old way was cut because someone asked for it.
    expect(retentionClassFor({ approved: false, preRendered: false })).toBe('owned');
  });

  it('still cuts the clip on the path that never pre-rendered', () => {
    expect(keepAction({ ...finished, preRendered: false }).kind).toBe('generate');
  });

  it('refuses rather than quietly repairing an unfinished card', () => {
    expect(keepAction({ ...finished, posterStorageKey: null }).kind).toBe('reject');
    expect(keepAction({ ...finished, derivativeStatus: 'failed' }).kind).toBe('reject');
  });
});

describe('what a client is told', () => {
  const base = {
    canonicalUrl: 'https://example/canonical.mp4',
    derivativeUrl: 'https://example/vertical.mp4',
    derivativeStorageKey: 'vertical/a.mp4',
    derivativeStatus: 'ready' as const,
    posterUrl: 'https://example/poster.jpg',
    posterStorageKey: 'poster/a.jpg',
    posterTimestampSeconds: 3.5,
    sourceWidth: 1920,
    sourceHeight: 1080,
    outputWidth: 1080,
    outputHeight: 1920,
    compositionMode: 'smart_crop' as const,
  };

  it('plays the vertical file for a vertical moment', () => {
    const media = clipMediaContract(base, true);
    expect(media.url).toBe('https://example/vertical.mp4');
    expect(media.outputAspectRatio).toBe('9:16');
    // The original framing is still reachable, deliberately, never by accident.
    expect(media.canonicalUrl).toBe('https://example/canonical.mp4');
  });

  /**
   * The substitution the product rule forbids by name: a failed vertical
   * render must not quietly hand back the landscape file dressed as the
   * finished result.
   */
  it('never dresses the landscape file up as the finished vertical one', () => {
    const media = clipMediaContract(
      { ...base, derivativeStatus: 'failed', derivativeStorageKey: null, derivativeUrl: null },
      true,
    );
    // Null, not the landscape file. There is no finished vertical result, and
    // saying so is the honest answer; handing back 16:9 in the slot a client
    // plays from is the substitution the rule forbids.
    expect(media.url).toBeNull();
    expect(media.canonicalUrl).toBe('https://example/canonical.mp4');
    expect(media.outputAspectRatio).toBe('16:9');
    expect(media.compositionMode).not.toBe('smart_crop');
  });
});

describe('atomic reveal at the API boundary — a polling client sees 0, then all', () => {
  const match = (id: string, confidence: number) => ({
    id, confidence,
    clipRequestId: 'r1', chunkId: 'c1', videoId: 'v1',
    globalStartSeconds: 0, globalEndSeconds: 20,
    localStartSeconds: 0, localEndSeconds: 20,
    description: 'a moment', quote: null, source: 'visual' as const,
    thumbnailKey: null, feedback: null, feedbackReason: null,
    provider: null, model: null, promptVersion: null,
    title: null, postIds: null,
    createdAt: new Date(), updatedAt: new Date(),
  });

  const readyClip = (matchId: string, over: Record<string, unknown> = {}) => ({
    id: `clip-${matchId}`, clipMatchId: matchId, videoId: 'v1',
    sessionId: null, userId: null, workspaceId: null,
    captions: null, derivedFromClipId: null, focusPct: 50,
    startSeconds: 0, endSeconds: 20,
    predictedStartSeconds: 0, predictedEndSeconds: 20, boundariesEditedAt: null,
    storageKey: `clips/${matchId}.mp4`, status: 'ready' as const, errorMessage: null,
    durationSeconds: 20, sizeBytes: 100,
    derivativeStorageKey: `vertical/${matchId}.mp4`,
    derivativeStatus: 'ready' as const,
    posterStorageKey: `poster/${matchId}.jpg`,
    posterTimestampSeconds: 5,
    compositionMode: 'smart_crop',
    sourceWidth: 1920, sourceHeight: 1080, outputWidth: 1080, outputHeight: 1920,
    preRendered: true, approvedAt: null, retentionClass: 'temporary' as const,
    createdAt: new Date(), updatedAt: new Date(),
    ...over,
  });

  /** The request row as the API reads it while a deck is being built. */
  const assembling = {
    presentationTarget: 'vertical' as const,
    deckCompletedAt: null,
    effectiveDeckTarget: 3,
  };
  const completed = { ...assembling, deckCompletedAt: new Date() };

  const matches = [match('a', 0.9), match('b', 0.8), match('c', 0.7)];

  /**
   * The exact sequence a frontend produces by polling every second while the
   * deck renders. Card-level filtering would return 1, then 2, then 3 — the
   * deck assembling itself in public, which is the thing the rule forbids.
   */
  it('returns nothing while the deck is still being assembled', () => {
    // Clip 1 finished. Two still rendering.
    let clips = new Map<string, any>([['a', readyClip('a')]]);
    expect(creatorVisibleDeck(assembling, matches as any, clips).matches).toEqual([]);
    expect(creatorVisibleDeck(assembling, matches as any, clips).clips).toEqual([]);

    // Clip 2 finished. Still not the set.
    clips = new Map<string, any>([['a', readyClip('a')], ['b', readyClip('b')]]);
    expect(creatorVisibleDeck(assembling, matches as any, clips).matches).toEqual([]);

    // Clip 3 finished, but the request has not been marked complete yet —
    // the media exists and the gate has not opened, so still nothing.
    clips = new Map<string, any>([
      ['a', readyClip('a')], ['b', readyClip('b')], ['c', readyClip('c')],
    ]);
    expect(creatorVisibleDeck(assembling, matches as any, clips).matches).toEqual([]);
  });

  it('returns the complete deck together the moment the gate opens', () => {
    const clips = new Map<string, any>([
      ['a', readyClip('a')], ['b', readyClip('b')], ['c', readyClip('c')],
    ]);
    const visible = creatorVisibleDeck(completed, matches as any, clips);
    expect(visible.matches.map((m) => m.id)).toEqual(['a', 'b', 'c']);
    expect(visible.clips).toHaveLength(3);
    expect(visible.withheld).toBe(0);
  });

  /**
   * Two finished, the deck failed. The creator gets nothing — not the two
   * that happened to work. A partial deck is never an answer.
   */
  it('returns nothing when the deck failed, even with finished clips behind it', () => {
    const clips = new Map<string, any>([['a', readyClip('a')], ['b', readyClip('b')]]);
    // deckCompletedAt stays null on failure — same state as still assembling.
    const visible = creatorVisibleDeck(assembling, matches as any, clips);
    expect(visible.matches).toEqual([]);
    expect(visible.clips).toEqual([]);
  });

  /**
   * A released deck ages, and that is not corruption.
   *
   * The creator Keeps one moment; a day later the retention sweep collects
   * the two they did not keep — exactly what makes rendering before Keep
   * affordable. Measuring what is left against the original target would read
   * that normal lifecycle as media vanishing from under a finished request
   * and hide the whole conversation, including the moment they chose, which
   * still plays perfectly from their library.
   */
  it('still shows the moment the creator kept after the others were swept', () => {
    const clips = new Map<string, any>([
      // Kept: approved, owned, files intact.
      ['a', readyClip('a', { approvedAt: new Date(), retentionClass: 'owned' })],
      // Swept: never kept, keys cleared by the retention sweep.
      ['b', readyClip('b', { derivativeStorageKey: null, derivativeStatus: null, posterStorageKey: null, storageKey: null })],
      ['c', readyClip('c', { derivativeStorageKey: null, derivativeStatus: null, posterStorageKey: null, storageKey: null })],
    ]);
    const visible = creatorVisibleDeck(completed, matches as any, clips);
    expect(visible.matches.map((m) => m.id)).toEqual(['a']);
  });

  /** A short pool is a complete deck at its own size. */
  it('releases a two-moment deck together when two was all the video had', () => {
    const shortDeck = { presentationTarget: 'vertical' as const, deckCompletedAt: new Date(), effectiveDeckTarget: 2 };
    const twoMatches = [match('a', 0.9), match('b', 0.8)];
    const clips = new Map<string, any>([['a', readyClip('a')], ['b', readyClip('b')]]);
    const visible = creatorVisibleDeck(shortDeck, twoMatches as any, clips);
    expect(visible.matches.map((m) => m.id)).toEqual(['a', 'b']);
  });

  /**
   * Everything that is not the post-ready path must behave exactly as it did
   * before this pipeline existed — including a request whose clips are still
   * being cut, where a pending clip is a normal, visible state.
   */
  /**
   * Rows that predate set-level tracking.
   *
   * Migration 030 adds its columns nullable and does not backfill, so a
   * vertical request created while 028/029 were live carries a null target
   * with real pre-rendered clips behind it — overfetch and failures included.
   * Read as "owes no deck" it would hand every one of them back, which is a
   * regression against the gate this replaced, on rows that will genuinely
   * exist the moment 030 ships.
   */
  it('still filters a pre-migration vertical request with a null target', () => {
    const preMigration = { presentationTarget: null, deckCompletedAt: null, effectiveDeckTarget: null };
    const clips = new Map<string, any>([
      ['a', readyClip('a')],
      // Rendered and failed — must not reappear just because the row is old.
      ['b', readyClip('b', { derivativeStatus: 'failed', derivativeStorageKey: null })],
      // 'c' was never prepared at all.
    ]);
    const visible = creatorVisibleDeck(preMigration, matches as any, clips);
    expect(visible.matches.map((m) => m.id)).toEqual(['a']);
    expect(visible.withheld).toBe(2);
  });

  it('leaves the legacy path completely untouched', () => {
    const legacy = { presentationTarget: null, deckCompletedAt: null, effectiveDeckTarget: null };
    const clips = new Map<string, any>([
      ['a', readyClip('a', {
        preRendered: false, derivativeStatus: null, derivativeStorageKey: null,
        posterStorageKey: null, status: 'pending', storageKey: null,
      })],
    ]);
    const visible = creatorVisibleDeck(legacy, [match('a', 0.9), match('b', 0.8)] as any, clips);
    expect(visible.matches.map((m) => m.id)).toEqual(['a', 'b']);
    expect(visible.withheld).toBe(0);
  });
});

describe('an absence we never verified', () => {
  /**
   * The distinction this holds open, in the creator's own terms:
   *
   *   "We looked, and this platform could take none of what your video has."
   *   "Your video's footage is gone, so we could not look at all."
   *
   * Both end with zero finished moments and an effective target of zero. Only
   * one is a statement about their video. Reporting the second as the first
   * tells someone their footage has nothing postable in it on the strength of
   * an examination that never happened — the failure this codebase keeps
   * circling, and the reason these are separate outcomes rather than one
   * empty count.
   */
  const empty = { complete: false, effectiveDeckTarget: 0, sourceUnavailable: false };

  it('calls missing footage what it is, not an empty video', () => {
    expect(deckCompletion({ ...empty, sourceUnavailable: true }).kind).toBe('source_unavailable');
  });

  /**
   * Why the flag has to exist at all.
   *
   * A missing source produces a zero effective target, and the render-failure
   * branch only fires above zero — so with nothing else to catch it, a
   * request whose footage vanished falls straight through to "complete" and
   * is reported as a finished, empty answer. Deleting the check makes this
   * test fail, which is the point of it.
   */
  it('is not swallowed by the zero-target path into a finished empty answer', () => {
    const gone = { ...empty, sourceUnavailable: true };
    // The branch that catches our own render failures cannot see this one.
    expect(gone.effectiveDeckTarget > 0).toBe(false);
    // And yet it must not be reported as a finished answer.
    expect(deckCompletion(gone).kind).not.toBe('complete');
  });

  it('an empty pool we actually examined is a finished answer', () => {
    expect(deckCompletion(empty).kind).toBe('complete');
  });

  it('moments found and not finished is our failure', () => {
    expect(deckCompletion({ complete: false, effectiveDeckTarget: 3, sourceUnavailable: false }).kind)
      .toBe('render_failed');
  });

  it('a deck that stands is complete', () => {
    expect(deckCompletion({ complete: true, effectiveDeckTarget: 3, sourceUnavailable: false }).kind)
      .toBe('complete');
  });

  /** A short deck that stands is complete too — two, when two was all there was. */
  it('a short deck that stands is complete', () => {
    expect(deckCompletion({ complete: true, effectiveDeckTarget: 2, sourceUnavailable: false }).kind)
      .toBe('complete');
  });
});

describe('a retry must never reach into the library', () => {
  /**
   * The shape of the bug this replaced, stated as the rule it broke.
   *
   * clips.clip_match_id is ON DELETE CASCADE. A stalled search job can be
   * redelivered AFTER the request completed and after somebody pressed Keep,
   * and the retry clears the previous attempt's matches. Two wrong answers
   * were tried before the right one:
   *
   *   1. delete every match  → the kept clip's row cascades away. Their
   *      library entry is gone.
   *   2. spare the kept FILES but still delete the match → the row still
   *      cascades, the clip still vanishes, and the files that were carefully
   *      preserved are now referenced by nothing. Worse than (1).
   *
   * Only keeping the MATCH keeps the clip, and only keeping the clip keeps
   * its files reachable. They are one decision, not three.
   */
  it('is one decision: keep the match, keep the clip, keep its files', () => {
    // A guard test over the SQL itself — the NOT EXISTS is what makes all
    // three true, and deleting it silently reintroduces the library loss.
    const sql = readFileSync(
      path.join(__dirname, '..', 'src/db/repositories/verticalMedia.ts'),
      'utf8',
    );
    const clear = sql.slice(sql.indexOf('export async function clearUnkeptMatchesForRequest'));
    expect(clear).toContain('NOT EXISTS');
    expect(clear).toContain('approved_at IS NOT NULL');
    // And it must be one statement: a separate read and delete lets an
    // approval land between them.
    expect(clear).toContain('WITH doomed AS');
    expect(clear).toContain('DELETE FROM clip_matches');
  });
});

describe('a superseded attempt must not open the gate', () => {
  /**
   * BullMQ redelivers a stalled search while the first run is still
   * assembling. The second run re-plans, clears the first run's work and
   * renders its own deck. The first run — still executing, unaware it was
   * replaced — reaches the gate and, unfenced, opens it over the second run's
   * half-built deck. That is the progressive reveal the whole set-level rule
   * exists to forbid, arriving through the one door left unlocked.
   *
   * A guard over the SQL, because the fence lives there: dropping the
   * deck_attempt_id predicate silently reopens it.
   */
  it('fences the gate to the attempt that planned the deck', () => {
    const src = readFileSync(
      path.join(__dirname, '..', 'src/db/repositories/clipRequests.ts'),
      'utf8',
    );
    const mark = src.slice(src.indexOf('export async function markDeckComplete'));
    expect(mark).toContain('deck_attempt_id = $2');
    // And it must report whether it won, so a superseded run can stand down
    // rather than assume it completed the request.
    expect(mark).toContain('RETURNING id');

    const plan = src.slice(src.indexOf('export async function recordDeckPlan'));
    expect(plan).toContain('gen_random_uuid()');
  });

  /**
   * The retry path must no longer be able to cascade every match away: the
   * one function that did is gone, and its replacement spares kept moments.
   */
  it('no longer ships a function that deletes every match unconditionally', () => {
    const src = readFileSync(
      path.join(__dirname, '..', 'src/db/repositories/clipRequests.ts'),
      'utf8',
    );
    expect(src).not.toContain('export async function deleteMatches');
  });
});
