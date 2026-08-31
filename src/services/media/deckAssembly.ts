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
  /** The complete set, or empty. Never a partial deck. */
  deck: PreparedCandidate[];
  /** True only when the full requested count was assembled. */
  complete: boolean;
  /** Prepared, finished, and not needed — the rendered-but-skipped cost. */
  surplus: PreparedCandidate[];
  /** Prepared and never finished. The suppression count. */
  suppressed: PreparedCandidate[];
  candidatesRendered: number;
  backfillCount: number;
}

/**
 * Prepare candidates in rank order until the requested number are READY.
 *
 * `prepare` does the expensive work for one candidate and reports what came
 * back. It is injected rather than imported so the ordering rules here can be
 * tested without cutting a single frame of video — the sequencing IS the
 * product rule, and it deserves tests that run in milliseconds.
 *
 * Stops early on success. Stops at the candidate ceiling on failure, and
 * returns an INCOMPLETE outcome rather than a short deck: a deck of two when
 * three were asked for is the partial reveal this whole file exists to
 * prevent, and the caller decides what to tell the creator instead.
 */
export async function assembleDeck(
  ranked: VerticalCandidate[],
  plan: DeckPlan,
  prepare: (candidate: VerticalCandidate, attempt: number) => Promise<PreparedCandidate>,
  maxAttempts: number,
): Promise<DeckOutcome> {
  const ready: PreparedCandidate[] = [];
  const suppressed: PreparedCandidate[] = [];
  let candidatesRendered = 0;
  let backfillCount = 0;

  for (const candidate of ranked.slice(0, plan.candidateTarget)) {
    if (ready.length >= plan.requested) break;

    // Anything past the first `requested` candidates is only being touched
    // because an earlier one failed. That is the backfill, and counting it
    // is how "how often does a failure cost us extra work" gets answered.
    if (candidatesRendered >= plan.requested) backfillCount += 1;

    let prepared: PreparedCandidate | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      candidatesRendered += 1;
      prepared = await prepare(candidate, attempt);
      if (isCreatorVisible(prepared)) break;
      // Bounded, automatic, and only where another go could genuinely differ.
      // The creator never presses anything to recover from our faults.
      if (!prepared.failureStage || !shouldRetry(prepared.failureStage, attempt, maxAttempts)) break;
    }

    if (prepared && isCreatorVisible(prepared)) ready.push(prepared);
    else if (prepared) suppressed.push(prepared);
  }

  const complete = ready.length >= plan.requested;
  return {
    // Nothing is released unless the whole set stands. An incomplete deck is
    // returned empty so no caller can accidentally reveal a partial one.
    deck: complete ? ready.slice(0, plan.requested) : [],
    complete,
    surplus: complete ? ready.slice(plan.requested) : [],
    // On an incomplete outcome the ready ones were still rendered and still
    // went unseen — they belong in the skipped cost, not silently nowhere.
    suppressed: complete ? suppressed : [...suppressed, ...ready],
    candidatesRendered,
    backfillCount,
  };
}

/**
 * What the deck cost, for the metrics the owner asked for.
 *
 * renderedButSkipped is the number that says how much media generation is
 * spent on moments a creator never sees — surplus we prepared and did not
 * need, plus everything suppressed. Generating before Keep is what makes this
 * measurable and what makes it matter.
 */
export function deckMetrics(outcome: DeckOutcome, startedAtMs: number, nowMs: number) {
  const renderedButSkipped = outcome.surplus.length + outcome.suppressed.length;
  return {
    requestedResultCount: outcome.deck.length + (outcome.complete ? 0 : outcome.suppressed.length),
    readyResultCount: outcome.deck.length,
    candidatesRendered: outcome.candidatesRendered,
    failedCandidateCount: outcome.suppressed.length,
    backfillCount: outcome.backfillCount,
    renderedButSkippedCount: renderedButSkipped,
    renderedButSkippedRate:
      outcome.candidatesRendered > 0
        ? Number((renderedButSkipped / outcome.candidatesRendered).toFixed(4))
        : null,
    // The creator-facing milestone: not time-to-first-card, which nobody
    // sees, but time until the whole deck could be shown.
    timeToCompleteDeckMs: outcome.complete ? Math.max(0, Math.round(nowMs - startedAtMs)) : null,
  };
}
