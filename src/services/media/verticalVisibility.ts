/**
 * What a creator is allowed to see, and what only we see.
 *
 * The product rule (owner, 2026-08-31): Clipit surfaces FINISHED moments. A
 * vertical candidate whose media pipeline has not finished, or has failed for
 * good, is simply not in the deck — no processing card, no error card, no
 * retry button, and above all no landscape clip quietly standing in for the
 * 9:16 file that was promised.
 *
 * The substitution is the one worth spelling out. Handing back the canonical
 * landscape clip when the derivative failed would be the most tempting
 * fallback and the worst: the creator asked for something to post to TikTok,
 * would receive something that is not that, and nothing on screen would say
 * so. They would find out from the platform, or from the comments.
 *
 * Two audiences, two truths, and they must not be confused:
 *   creator  — "these are finished moments"
 *   operator — "here is everything that failed while making them"
 * Which is why nothing here deletes a failure; it only hides one.
 */

/** The internal lifecycle. All three are real and recorded. */
export type DerivativeStatus = 'pending' | 'ready' | 'failed';

/** Where a vertical render gave way. Structured so it can be grouped. */
export type FailureStage =
  /** Cutting the canonical excerpt — the step before any vertical work. */
  | 'canonical_generation'
  | 'composition_decision'
  | 'composition_validation'
  | 'smart_crop_render'
  | 'blurred_background_render'
  | 'poster_generation'
  | 'storage_upload'
  | 'media_probe'
  | 'serialization';

/** One candidate, as the selector sees it. */
export interface VerticalCandidate {
  matchId: string;
  derivativeStatus: DerivativeStatus;
  /** The 9:16 file's key. Absent means there is no derivative, whatever the status says. */
  derivativeStorageKey: string | null;
  posterStorageKey: string | null;
  /** Higher is better; the order candidates were ranked in. */
  confidence: number;
}

/**
 * Is this candidate finished enough to show?
 *
 * Deliberately checks the FILE, not just the status column. A row marked
 * 'ready' with no derivative key is a bug somewhere upstream, and trusting
 * the label over the artefact is how a creator ends up with a card that
 * plays nothing. The status must agree with reality before anyone sees it.
 *
 * The poster is required too: the spec calls for required media metadata, and
 * a post-ready card with no still is not post-ready.
 */
export function isCreatorVisible(candidate: VerticalCandidate): boolean {
  if (candidate.derivativeStatus !== 'ready') return false;
  if (!candidate.derivativeStorageKey) return false;
  if (!candidate.posterStorageKey) return false;
  return true;
}

/**
 * Fill the creator's requested count from the candidates that actually
 * finished, best first.
 *
 * "Give me 3 TikTok moments" means three usable moments. A candidate whose
 * render failed must not consume one of those three — the creator would
 * receive two and no explanation, and would reasonably conclude their video
 * only had two good moments in it. Over-selecting internally is what absorbs
 * a failure without shrinking the answer.
 *
 * Returns what was shown AND what was withheld, because the caller has to
 * record the second: a suppressed candidate is invisible to the creator and
 * must never be invisible to us.
 */
export function selectCreatorVisible(
  candidates: VerticalCandidate[],
  requested: number,
): { visible: VerticalCandidate[]; withheld: VerticalCandidate[] } {
  const ranked = [...candidates].sort((a, b) => b.confidence - a.confidence);
  const visible: VerticalCandidate[] = [];
  const withheld: VerticalCandidate[] = [];

  for (const candidate of ranked) {
    if (isCreatorVisible(candidate) && visible.length < Math.max(0, requested)) {
      visible.push(candidate);
    } else {
      // Everything else, including ready candidates beyond the requested
      // count — the caller distinguishes "not finished" from "not needed"
      // by reading derivativeStatus, and only the former is a suppression.
      withheld.push(candidate);
    }
  }

  return { visible, withheld };
}

/**
 * How many candidates a failure actually cost the creator: those that were
 * wanted, and could not be shown because the pipeline did not finish them.
 *
 * This is the number that answers "did Clipit find fewer moments, or did it
 * fail to finish them?" — and it is the reason the withheld list is returned
 * above rather than dropped.
 */
export function suppressedByPipeline(withheld: VerticalCandidate[]): VerticalCandidate[] {
  return withheld.filter((candidate) => !isCreatorVisible(candidate));
}

/**
 * How many candidates to prepare so one failure does not cost a result.
 *
 * Multiplied rather than fixed: asking for one extra covers a single failure
 * out of three, and nothing when someone asks for ten. The ceiling is what
 * keeps a large request from quietly becoming a very large render bill —
 * every extra candidate is a real clip cut, a real GPU call and a real
 * encode, and this rule exists to protect a result count, not to warm a
 * cache.
 */
export function candidateTargetFor(requested: number, overfetchRatio: number, ceiling: number): number {
  if (!Number.isFinite(requested) || requested <= 0) return 0;
  const wanted = Math.ceil(requested * Math.max(1, overfetchRatio));
  return Math.min(Math.max(requested, wanted), Math.max(requested, ceiling));
}

/**
 * Is this failure worth one more attempt?
 *
 * A bounded, automatic retry — the creator never presses anything to recover
 * from our infrastructure faltering, and never sees that it did. But only
 * where trying again could plausibly differ: a dropped upload or a model call
 * that timed out might; a response the validator rejected as malformed will
 * produce the same rejection, and a crop whose geometry is impossible will
 * fail identically forever.
 *
 * Note that composition failures do not need a retry to be survivable at all:
 * the composition layer already falls back to blurred_background, which
 * preserves the whole frame. Retrying is for the transport, not the judgement.
 */
export function isRetryableFailure(stage: FailureStage): boolean {
  switch (stage) {
    // The cut itself: a download that dropped, a disk that filled, an encoder
    // that died. All transient, all worth one more go.
    case 'canonical_generation':
    case 'composition_decision':
    case 'smart_crop_render':
    case 'blurred_background_render':
    case 'poster_generation':
    case 'storage_upload':
      return true;
    // A malformed model answer re-parses the same way; a probe that could not
    // read the file will not read it next time; serialization failing is our
    // own bug and a retry only hides it.
    case 'composition_validation':
    case 'media_probe':
    case 'serialization':
      return false;
  }
}

/** Whether another attempt is allowed at all, given the bound. */
export function shouldRetry(stage: FailureStage, attemptNumber: number, maxAttempts: number): boolean {
  if (attemptNumber >= maxAttempts) return false;
  return isRetryableFailure(stage);
}
