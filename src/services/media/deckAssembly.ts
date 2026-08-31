import {
  candidateTargetFor,
  isCreatorVisible,
  shouldRetry,
  type FailureStage,
  type VerticalCandidate,
} from './verticalVisibility.js';

/**
 * Assembling a complete deck, or none at all.
 *
 * The owner's rule (2026-08-31): the review deck is COMPLETE PRODUCT OUTPUT.
 * A creator asks for three TikTok moments and receives three finished
 * moments, together, once. They never watch the deck build itself, never see
 * a card appear and another arrive later, and never see a placeholder become
 * real.
 *
 * That is a stricter promise than "hide what is not ready", and the
 * difference is the reason this file exists. Per-candidate gating would still
 * let the first finished moment appear alone — which is precisely the
 * assembling-in-public experience the rule forbids. So readiness is decided
 * for the SET, not the card: nothing is released until the whole requested
 * count is standing.
 *
 * Rendering is bounded and lazy. Candidates are prepared in rank order and
 * the work STOPS the moment enough are ready — a fourth candidate is only
 * touched because an earlier one failed. Every extra is a real clip cut, a
 * real GPU call and a real encode, so "render the pool" is never the plan.
 */

/** A candidate plus what it cost to find out. */
export interface PreparedCandidate extends VerticalCandidate {
  /** Attempts spent on this candidate, including the one that succeeded. */
  attempts: number;
  /** Set when every attempt failed. Null while pending or on success. */
  failureStage: FailureStage | null;
}

export interface DeckPlan {
  /** How many the creator asked for. */
  requested: number;
  /** How many candidates may be prepared before giving up. */
  candidateTarget: number;
}

export function planDeck(
  requested: number,
  overfetchRatio: number,
  ceiling: number,
): DeckPlan {
  return { requested, candidateTarget: candidateTargetFor(requested, overfetchRatio, ceiling) };
}

export interface DeckOutcome {
  /** The released set, or empty. Never a partial deck. */
  deck: PreparedCandidate[];
  /** True only when the full effective target was assembled. */
  complete: boolean;
  /**
   * Candidates that produced real media nobody will see — surplus beyond the
   * target, plus everything rendered for a deck that then failed. This is the
   * wasted-render cost, and it deliberately excludes failures: a candidate
   * that never rendered wasted GPU time, not storage.
   */
  readyButUnused: PreparedCandidate[];
  /** Unique candidates that never became creator-visible. */
  failed: PreparedCandidate[];
  /** Distinct candidates prepare() was invoked for. */
  uniqueCandidatesAttempted: number;
  /** Total preparation attempts, retries included. */
  renderAttempts: number;
  /**
   * Unique candidates attempted beyond the first `target` rank positions —
   * i.e. reached ONLY because an earlier candidate failed outright.
   *
   * Position, not attempt count. A candidate that needed two tries and then
   * succeeded costs an extra attempt, not an extra candidate, and counting it
   * as backfill would report the deck reaching deeper into the pool than it
   * did.
   */
  backfillCount: number;
  /** The effective target this assembly worked to. */
  target: number;
}

/**
 * Prepare candidates in rank order until the target number are READY.
 *
 * `prepare` does the expensive work for one candidate and reports what came
 * back. It is injected rather than imported so the ordering rules here can be
 * tested without cutting a single frame of video — the sequencing IS the
 * product rule, and it deserves tests that run in milliseconds.
 *
 * Stops early on success. Stops at the candidate ceiling on failure, and
 * returns an INCOMPLETE outcome rather than a short deck: a deck of two when
 * the target was three is the partial reveal this whole file exists to
 * prevent, and the caller decides what to tell the creator instead.
 */
export async function assembleDeck(
  ranked: VerticalCandidate[],
  plan: DeckPlan,
  prepare: (candidate: VerticalCandidate, attempt: number) => Promise<PreparedCandidate>,
  maxAttempts: number,
): Promise<DeckOutcome> {
  const ready: PreparedCandidate[] = [];
  const failed: PreparedCandidate[] = [];
  let uniqueCandidatesAttempted = 0;
  let renderAttempts = 0;
  let backfillCount = 0;

  const pool = ranked.slice(0, plan.candidateTarget);
  for (let position = 0; position < pool.length; position += 1) {
    if (ready.length >= plan.requested) break;
    const candidate = pool[position]!;

    uniqueCandidatesAttempted += 1;
    // Reached only because an earlier candidate failed outright. Measured by
    // rank position so retries on an earlier candidate never inflate it.
    if (position >= plan.requested) backfillCount += 1;

    let prepared: PreparedCandidate | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      renderAttempts += 1;
      prepared = await prepare(candidate, attempt);
      if (isCreatorVisible(prepared)) break;
      // Bounded, automatic, and only where another go could genuinely differ.
      // The creator never presses anything to recover from our faults.
      if (!prepared.failureStage || !shouldRetry(prepared.failureStage, attempt, maxAttempts)) break;
    }

    if (prepared && isCreatorVisible(prepared)) ready.push(prepared);
    else if (prepared) failed.push(prepared);
  }

  const complete = ready.length >= plan.requested;
  return {
    // Nothing is released unless the whole set stands. An incomplete deck is
    // returned empty so no caller can accidentally reveal a partial one.
    deck: complete ? ready.slice(0, plan.requested) : [],
    complete,
    // On an incomplete outcome every ready candidate was still rendered and
    // still goes unseen, so it belongs in the wasted cost rather than
    // silently nowhere.
    readyButUnused: complete ? ready.slice(plan.requested) : [...ready],
    failed,
    uniqueCandidatesAttempted,
    renderAttempts,
    backfillCount,
    target: plan.requested,
  };
}

/**
 * What the deck cost, in numbers that mean exactly what they are called.
 *
 * The distinction this exists to keep straight is unique CANDIDATES versus
 * render ATTEMPTS. Blurring them makes a retry look like the deck reaching
 * deeper into the pool, which reads as "the search is running short of
 * moments" when what actually happened is "one encode needed a second go".
 * Those call for opposite responses, so they get separate names.
 */
export function deckMetrics(
  outcome: DeckOutcome,
  startedAtMs: number,
  nowMs: number,
  request: {
    /** Exactly what the creator asked for, before any availability cap. */
    requestedResultCount: number;
    /** The whole ranked pool this deck could draw from. */
    internalCandidateCount: number;
  },
) {
  // Only candidates that actually produced media can be "rendered but
  // skipped". A failure wasted time; it did not leave a file behind.
  const uniqueRendered = outcome.deck.length + outcome.readyButUnused.length;
  const renderedButSkippedCount = outcome.readyButUnused.length;

  return {
    // From the REQUEST, never inferred from how things turned out. Deriving
    // it from outcomes meant a deck that failed reported having been asked
    // for however many happened to fail.
    requestedResultCount: request.requestedResultCount,
    internalCandidateCount: request.internalCandidateCount,
    /** How many moments were actually obtainable: min(requested, available). */
    effectiveDeckTarget: outcome.target,
    uniqueCandidatesAttempted: outcome.uniqueCandidatesAttempted,
    renderAttempts: outcome.renderAttempts,
    readyResultCount: outcome.deck.length,
    failedCandidateCount: outcome.failed.length,
    // The same unique count named as what it MEANS: moments a creator wanted
    // and did not get because we could not finish them.
    suppressedFailureCount: outcome.failed.length,
    backfillCount: outcome.backfillCount,
    renderedButSkippedCount,
    // Against candidates that actually rendered — the population the question
    // is about. Null rather than zero when nothing rendered, because "no
    // waste" and "nothing to measure" are different answers.
    renderedButSkippedRate:
      uniqueRendered > 0 ? Number((renderedButSkippedCount / uniqueRendered).toFixed(4)) : null,
    // The creator-facing milestone: not time-to-first-card, which nobody
    // sees, but time until the whole deck could be shown.
    timeToCompleteDeckMs: outcome.complete ? Math.max(0, Math.round(nowMs - startedAtMs)) : null,
  };
}
