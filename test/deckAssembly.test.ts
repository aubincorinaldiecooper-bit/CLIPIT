import { describe, expect, it, vi } from 'vitest';
import { assembleDeck, deckMetrics, planDeck, type PreparedCandidate } from '../src/services/media/deckAssembly.js';
import type { VerticalCandidate } from '../src/services/media/verticalVisibility.js';

/**
 * The deck is complete product output. A creator asks for three and receives
 * three, together, once — never one card now and another later, never a short
 * deck passed off as the answer. These tests hold that promise, and hold the
 * bound that keeps it from costing the whole candidate pool.
 */

const candidate = (id: string, confidence: number): VerticalCandidate => ({
  matchId: id,
  derivativeStatus: 'pending',
  derivativeStorageKey: null,
  posterStorageKey: null,
  confidence,
});

const ready = (c: VerticalCandidate, attempts = 1): PreparedCandidate => ({
  ...c,
  derivativeStatus: 'ready',
  derivativeStorageKey: `clips/${c.matchId}-vertical.mp4`,
  posterStorageKey: `posters/${c.matchId}.jpg`,
  attempts,
  failureStage: null,
});

const failed = (c: VerticalCandidate, stage: PreparedCandidate['failureStage'], attempts = 1): PreparedCandidate => ({
  ...c,
  derivativeStatus: 'failed',
  derivativeStorageKey: null,
  posterStorageKey: null,
  attempts,
  failureStage: stage,
});

const pool = (n: number) => Array.from({ length: n }, (_, i) => candidate(`c${i + 1}`, 1 - i * 0.05));

describe('atomic reveal — the whole set, or nothing', () => {
  it('returns nothing when only one of three finished', async () => {
    const prepare = vi.fn(async (c: VerticalCandidate) =>
      c.matchId === 'c1' ? ready(c) : failed(c, 'smart_crop_render'),
    );
    const outcome = await assembleDeck(pool(3), planDeck(3, 1, 3), prepare, 1);
    expect(outcome.complete).toBe(false);
    // The one that DID finish is not handed over on its own.
    expect(outcome.deck).toEqual([]);
  });

  it('returns nothing when only two of three finished', async () => {
    const prepare = vi.fn(async (c: VerticalCandidate) =>
      c.matchId === 'c3' ? failed(c, 'poster_generation') : ready(c),
    );
    const outcome = await assembleDeck(pool(3), planDeck(3, 1, 3), prepare, 1);
    expect(outcome.complete).toBe(false);
    expect(outcome.deck).toEqual([]);
  });

  it('returns all three together once three are ready', async () => {
    const prepare = vi.fn(async (c: VerticalCandidate) => ready(c));
    const outcome = await assembleDeck(pool(5), planDeck(3, 1.7, 8), prepare, 2);
    expect(outcome.complete).toBe(true);
    expect(outcome.deck.map((d) => d.matchId)).toEqual(['c1', 'c2', 'c3']);
  });

  it('renders lazily — a fourth candidate is only touched because one failed', async () => {
    const prepare = vi.fn(async (c: VerticalCandidate) =>
      c.matchId === 'c2' ? failed(c, 'media_probe') : ready(c),
    );
    const outcome = await assembleDeck(pool(8), planDeck(3, 1.7, 8), prepare, 2);

    expect(outcome.complete).toBe(true);
    expect(outcome.deck.map((d) => d.matchId)).toEqual(['c1', 'c3', 'c4']);
    // c5..c8 were never prepared: the work stops the moment three stand.
    expect(prepare.mock.calls.map((call) => (call[0] as VerticalCandidate).matchId))
      .toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(outcome.backfillCount).toBe(1);
  });

  it('never renders the whole pool — the ceiling bounds the work', async () => {
    const prepare = vi.fn(async (c: VerticalCandidate) => failed(c, 'media_probe'));
    const outcome = await assembleDeck(pool(50), planDeck(3, 1.7, 6), prepare, 1);
    expect(outcome.complete).toBe(false);
    expect(prepare).toHaveBeenCalledTimes(6);
  });
});

describe('retry — bounded, automatic, invisible to the creator', () => {
  it('recovers a transient failure on the second attempt', async () => {
    const seen = new Map<string, number>();
    const prepare = vi.fn(async (c: VerticalCandidate, attempt: number) => {
      seen.set(c.matchId, attempt);
      // c1 fails once transiently, then succeeds.
      if (c.matchId === 'c1' && attempt === 1) return failed(c, 'storage_upload', 1);
      return ready(c, attempt);
    });
    const outcome = await assembleDeck(pool(3), planDeck(3, 1, 3), prepare, 2);

    expect(outcome.complete).toBe(true);
    expect(outcome.deck.map((d) => d.matchId)).toEqual(['c1', 'c2', 'c3']);
    expect(seen.get('c1')).toBe(2);
  });

  it('does not retry a failure that would fail identically', async () => {
    const prepare = vi.fn(async (c: VerticalCandidate) => failed(c, 'composition_validation'));
    await assembleDeck([candidate('only', 1)], planDeck(1, 1, 1), prepare, 3);
    // A malformed answer re-parses the same way; one attempt, not three.
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});

describe('what the deck cost', () => {
  it('counts rendered-but-skipped: surplus we prepared plus everything suppressed', async () => {
    const prepare = vi.fn(async (c: VerticalCandidate) =>
      c.matchId === 'c2' ? failed(c, 'blurred_background_render') : ready(c),
    );
    const outcome = await assembleDeck(pool(8), planDeck(2, 1.7, 8), prepare, 1);
    const metrics = deckMetrics(outcome, 1_000, 4_500);

    expect(outcome.complete).toBe(true);
    // c1 and c3 shown; c2 suppressed. Three prepared, two used.
    expect(metrics.readyResultCount).toBe(2);
    expect(metrics.candidatesRendered).toBe(3);
    expect(metrics.failedCandidateCount).toBe(1);
    expect(metrics.renderedButSkippedCount).toBe(1);
    expect(metrics.renderedButSkippedRate).toBeCloseTo(1 / 3, 4);
  });

  it('measures time to the COMPLETE deck, which is the milestone anyone sees', async () => {
    const prepare = vi.fn(async (c: VerticalCandidate) => ready(c));
    const outcome = await assembleDeck(pool(2), planDeck(2, 1, 2), prepare, 1);
    expect(deckMetrics(outcome, 1_000, 3_400).timeToCompleteDeckMs).toBe(2_400);
  });

  it('reports no completion time when the deck never completed', async () => {
    const prepare = vi.fn(async (c: VerticalCandidate) => failed(c, 'media_probe'));
    const outcome = await assembleDeck(pool(2), planDeck(2, 1, 2), prepare, 1);
    // Null, not zero and not a partial timing — the milestone never happened.
    expect(deckMetrics(outcome, 1_000, 9_000).timeToCompleteDeckMs).toBeNull();
  });

  it('an incomplete deck still counts what it rendered — the cost was real', async () => {
    const prepare = vi.fn(async (c: VerticalCandidate) =>
      c.matchId === 'c1' ? ready(c) : failed(c, 'media_probe'),
    );
    const outcome = await assembleDeck(pool(3), planDeck(3, 1, 3), prepare, 1);
    const metrics = deckMetrics(outcome, 0, 500);
    expect(outcome.deck).toEqual([]);
    // The one that finished was still rendered and still went unseen.
    expect(metrics.renderedButSkippedCount).toBe(3);
  });
});
