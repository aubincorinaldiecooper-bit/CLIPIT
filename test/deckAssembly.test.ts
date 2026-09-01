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

describe('what the deck cost — unique candidates versus render attempts', () => {
  const plan = planDeck(3, 1.7, 8);

  /**
   * The distinction the whole metric block exists for.
   *
   * A candidate that needed a second try cost an extra ATTEMPT. It did not
   * make the deck reach further down the ranked pool. Counting it as backfill
   * reads as "the search is running short of moments" when what happened was
   * "one encode needed another go" — opposite problems, opposite responses.
   */
  it('a retry is an extra attempt, never an extra candidate or a backfill', async () => {
    const outcome = await assembleDeck(
      pool(4),
      plan,
      // c1 fails a RETRYABLE stage once, then succeeds; c2 and c3 pass first time.
      async (cand, attempt) =>
        cand.matchId === 'c1' && attempt === 1
          ? failed(cand, 'smart_crop_render', attempt)
          : ready(cand, attempt),
      2,
    );

    expect(outcome.complete).toBe(true);
    expect(outcome.deck.map((d) => d.matchId)).toEqual(['c1', 'c2', 'c3']);
    expect(outcome.uniqueCandidatesAttempted).toBe(3);
    expect(outcome.renderAttempts).toBe(4);
    expect(outcome.backfillCount).toBe(0);

    const m = deckMetrics(outcome, 0, 500, { requestedResultCount: 3, internalCandidateCount: 4 });
    expect(m.uniqueCandidatesAttempted).toBe(3);
    expect(m.renderAttempts).toBe(4);
    expect(m.backfillCount).toBe(0);
  });

  /** A candidate reached ONLY because an earlier one died is the backfill. */
  it('counts a candidate reached only because an earlier one failed', async () => {
    const outcome = await assembleDeck(
      pool(4),
      plan,
      // c2 fails terminally — a stage no retry can change.
      async (cand, attempt) =>
        cand.matchId === 'c2' ? failed(cand, 'media_probe', attempt) : ready(cand, attempt),
      2,
    );

    expect(outcome.complete).toBe(true);
    expect(outcome.deck.map((d) => d.matchId)).toEqual(['c1', 'c3', 'c4']);
    expect(outcome.uniqueCandidatesAttempted).toBe(4);
    expect(outcome.backfillCount).toBe(1);
    expect(outcome.failed.map((f) => f.matchId)).toEqual(['c2']);
  });

  /**
   * requestedResultCount is what the CREATOR asked for. Deriving it from how
   * things turned out meant a failed deck reported having been asked for
   * however many happened to fail.
   */
  it('reports the request, not the outcome', async () => {
    const outcome = await assembleDeck(
      pool(2),
      planDeck(2, 1.7, 8),
      async (cand, attempt) => ready(cand, attempt),
      2,
    );
    const m = deckMetrics(outcome, 0, 100, { requestedResultCount: 3, internalCandidateCount: 2 });
    // Asked for three; the video had two; both were delivered.
    expect(m.requestedResultCount).toBe(3);
    expect(m.internalCandidateCount).toBe(2);
    expect(m.effectiveDeckTarget).toBe(2);
    expect(m.readyResultCount).toBe(2);
  });

  /**
   * Only media that actually exists can be "rendered but skipped". A failure
   * wasted GPU time; it did not leave a file behind, and counting it as
   * wasted storage overstates the bill in a way that would misdirect a fix.
   */
  it('counts only real media as rendered-but-skipped', async () => {
    const outcome = await assembleDeck(
      pool(3),
      plan,
      async (cand, attempt) =>
        cand.matchId === 'c3' ? failed(cand, 'media_probe', attempt) : ready(cand, attempt),
      2,
    );

    expect(outcome.complete).toBe(false);
    // c1 and c2 rendered real files that nobody will ever see.
    expect(outcome.readyButUnused.map((r) => r.matchId)).toEqual(['c1', 'c2']);
    expect(outcome.failed.map((f) => f.matchId)).toEqual(['c3']);

    const m = deckMetrics(outcome, 0, 100, { requestedResultCount: 3, internalCandidateCount: 3 });
    expect(m.renderedButSkippedCount).toBe(2);
    expect(m.failedCandidateCount).toBe(1);
    expect(m.suppressedFailureCount).toBe(1);
    // Both candidates that produced media went unseen.
    expect(m.renderedButSkippedRate).toBe(1);
  });

  it('measures time only to a deck that actually completed', async () => {
    const done = await assembleDeck(pool(1), planDeck(1, 1.7, 8), async (x, n) => ready(x, n), 2);
    expect(
      deckMetrics(done, 1_000, 3_500, { requestedResultCount: 1, internalCandidateCount: 1 }).timeToCompleteDeckMs,
    ).toBe(2_500);

    const never = await assembleDeck(
      pool(1), planDeck(1, 1.7, 8), async (x, n) => failed(x, 'media_probe', n), 2,
    );
    // Not zero — zero is a duration, and there was no complete deck to time.
    expect(
      deckMetrics(never, 1_000, 3_500, { requestedResultCount: 1, internalCandidateCount: 1 }).timeToCompleteDeckMs,
    ).toBeNull();
  });

  it('has nothing to report as a waste rate when nothing rendered', async () => {
    const outcome = await assembleDeck(
      pool(1), planDeck(1, 1.7, 8), async (x, n) => failed(x, 'media_probe', n), 2,
    );
    // Null, not 0 — "no waste" and "nothing to measure" are different answers.
    expect(
      deckMetrics(outcome, 0, 10, { requestedResultCount: 1, internalCandidateCount: 1 }).renderedButSkippedRate,
    ).toBeNull();
  });
});

describe('a video with fewer moments than the creator asked for', () => {
  /**
   * "Your video had two" and "we failed to make three" are different answers
   * and must never be returned as the same one.
   *
   * The effective deck is min(requested, available). Two moments delivered
   * together IS a complete answer when two is all there was — reporting it as
   * a render failure would tell the creator something false about their own
   * footage, and invite a retry that could only do the same thing again.
   */
  it('delivers the two it had, together, and calls that complete', async () => {
    const available = pool(2);
    const effectiveTarget = Math.min(3, available.length);

    const outcome = await assembleDeck(
      available,
      planDeck(effectiveTarget, 1.7, 8),
      async (cand, attempt) => ready(cand, attempt),
      2,
    );

    expect(outcome.complete).toBe(true);
    expect(outcome.deck).toHaveLength(2);
    expect(outcome.failed).toHaveLength(0);

    const m = deckMetrics(outcome, 0, 800, { requestedResultCount: 3, internalCandidateCount: 2 });
    // All four numbers stay distinct, so the shortfall is legible as what it
    // is rather than being flattened into a failure.
    expect(m.requestedResultCount).toBe(3);
    expect(m.internalCandidateCount).toBe(2);
    expect(m.effectiveDeckTarget).toBe(2);
    expect(m.readyResultCount).toBe(2);
    expect(m.failedCandidateCount).toBe(0);
    expect(m.timeToCompleteDeckMs).toBe(800);
  });

  /**
   * The other half of the distinction. Two were available and only one could
   * be rendered — that IS a media-pipeline failure, for the effective
   * two-result deck, and there is no third candidate to backfill from.
   */
  it('treats a render failure inside a short pool as a real failure', async () => {
    const available = pool(2);
    const outcome = await assembleDeck(
      available,
      planDeck(Math.min(3, available.length), 1.7, 8),
      async (cand, attempt) =>
        cand.matchId === 'c2' ? failed(cand, 'media_probe', attempt) : ready(cand, attempt),
      2,
    );

    expect(outcome.complete).toBe(false);
    // Nothing is released — not even the one that worked.
    expect(outcome.deck).toEqual([]);
    expect(outcome.failed.map((f) => f.matchId)).toEqual(['c2']);
    // The one that DID render is real media nobody will see.
    expect(outcome.readyButUnused.map((r) => r.matchId)).toEqual(['c1']);

    const m = deckMetrics(outcome, 0, 800, { requestedResultCount: 3, internalCandidateCount: 2 });
    expect(m.effectiveDeckTarget).toBe(2);
    expect(m.readyResultCount).toBe(0);
    expect(m.failedCandidateCount).toBe(1);
    expect(m.timeToCompleteDeckMs).toBeNull();
  });

  /** Nothing eligible at all is an empty answer, not a failed one. */
  it('has no deck to attempt when the search found nothing eligible', async () => {
    const outcome = await assembleDeck([], planDeck(0, 1.7, 8), async (cand, attempt) => ready(cand, attempt), 2);
    expect(outcome.complete).toBe(true);
    expect(outcome.deck).toEqual([]);
    expect(outcome.uniqueCandidatesAttempted).toBe(0);
    expect(outcome.renderAttempts).toBe(0);
  });
});
