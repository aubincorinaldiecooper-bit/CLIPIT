import { describe, expect, it } from 'vitest';
import { assembleDeck, planDeck, type PreparedCandidate } from '../src/services/media/deckAssembly.js';
import { keepAction, retentionClassFor } from '../src/services/media/keepApproval.js';
import { clipMediaContract } from '../src/api/mediaContract.js';
import { creatorVisibleMatches } from '../src/api/serializers.js';
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
    expect(outcome.suppressed.map((d) => d.matchId)).toEqual(['b']);
    expect(outcome.backfillCount).toBeGreaterThan(0);
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
    expect(media.url).not.toBe('https://example/vertical.mp4');
    expect(media.outputAspectRatio).toBe('16:9');
    expect(media.compositionMode).not.toBe('smart_crop');
  });
});

describe('the gate between what was made and what is shown', () => {
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

  const clip = (matchId: string, over: Record<string, unknown> = {}) => ({
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

  /**
   * The failure this exists to prevent: a request that over-fetched six
   * candidates to guarantee three cards returns all six, and the creator sees
   * three finished moments next to three that play nothing.
   */
  it('shows only the moments that were actually finished', () => {
    const matches = [match('a', 0.9), match('b', 0.8), match('c', 0.7), match('d', 0.6)];
    const clips = new Map<string, any>([
      ['a', clip('a')],
      // Rendered and failed — suppressed, never shown.
      ['b', clip('b', { derivativeStatus: 'failed', derivativeStorageKey: null })],
      ['c', clip('c')],
      // 'd' was never touched: the deck filled before it was reached.
    ]);

    const visible = creatorVisibleMatches(matches as any, clips);
    expect(visible.matches.map((m) => m.id)).toEqual(['a', 'c']);
    expect(visible.clips).toHaveLength(2);
    expect(visible.withheld).toBe(2);
  });

  /** A row marked ready with no file is a bug, and must not reach anyone. */
  it('trusts the file, not the status column', () => {
    const clips = new Map<string, any>([['a', clip('a', { posterStorageKey: null })]]);
    expect(creatorVisibleMatches([match('a', 0.9)] as any, clips).matches).toEqual([]);
  });

  /**
   * Everything that is not the post-ready path must behave exactly as it did
   * before this pipeline existed — including a request whose clips are still
   * being cut, where a pending clip is a normal, visible state.
   */
  it('leaves the legacy path completely untouched', () => {
    const matches = [match('a', 0.9), match('b', 0.8)];
    const clips = new Map<string, any>([
      ['a', clip('a', {
        preRendered: false, derivativeStatus: null, derivativeStorageKey: null,
        posterStorageKey: null, status: 'pending', storageKey: null,
      })],
    ]);
    const visible = creatorVisibleMatches(matches as any, clips);
    expect(visible.matches.map((m) => m.id)).toEqual(['a', 'b']);
    expect(visible.withheld).toBe(0);
  });
});
