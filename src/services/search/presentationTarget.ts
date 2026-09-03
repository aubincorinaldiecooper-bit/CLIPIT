/**
 * What shape a moment is delivered in. There is only one answer: vertical.
 *
 * THE RULE (owner's decision, 2026-09-03, permanent): every clip this product
 * makes is 9:16. Never landscape. Ever. It is not a preference, a default, or
 * a thing the instruction can influence — it is what Clipit delivers.
 *
 * What this module used to do, and why it is now a constant
 * ---------------------------------------------------------
 * It read the person's words and decided: "3 moments for TikTok" meant a 9:16
 * derivative was owed, "the part where they introduce themselves" meant the
 * footage came back as it was shot. The reasoning was that building a vertical
 * derivative for everyone is wasteful and wrong for someone who wants the
 * original framing.
 *
 * That was wrong in practice, and the way it was wrong is worth keeping: a
 * search whose wording happened to carry no platform word produced a landscape
 * clip, which the review card — fixed at 9:16 — then showed as a small wide
 * band floating in a tall black box. Nothing had failed. The clip was cut
 * quickly and correctly, and it still looked broken, because the shape it was
 * made in was decided by whether the person happened to type "TikTok".
 *
 * Deliberately removed with it: the "keep the original framing" escape hatch.
 * There is no phrase that returns landscape now. That is what "never, ever"
 * means, and it is the owner's call rather than an oversight.
 *
 * The file stays — rather than the constant being inlined at each call site —
 * so the rule has ONE home, with the reasoning attached. A future change of
 * mind is an edit here, not an archaeology exercise across the worker.
 */

export type PresentationTarget = 'vertical';

/** The only shape. Exported so a caller can say what it means, not `true`. */
export const ALWAYS_VERTICAL: PresentationTarget = 'vertical';

export interface PresentationIntent {
  target: PresentationTarget;
  /**
   * The phrase that decided it. Always null now: nothing in the instruction
   * decides this any more. Kept so the log line and its readers do not change
   * shape over a rule that has no matched phrase to report.
   */
  matched: string | null;
}

/**
 * Always vertical, whatever was typed.
 *
 * The instruction is still the search — that rule is untouched. What the
 * person asked to FIND is entirely theirs. What shape it comes back in is
 * the product's answer, and the product has one.
 */
export function presentationTargetFor(_instruction: string | null | undefined): PresentationIntent {
  return { target: ALWAYS_VERTICAL, matched: null };
}

/**
 * Whether a stored presentation means vertical. Every new row says 'vertical';
 * rows written before this rule may say 'original' or 'source'.
 *
 * Those old rows are read as vertical for anything being MADE OR REMADE — a
 * re-cut of a moment from last week comes back 9:16 like everything else.
 * What it must not do is rewrite how an existing landscape file is described:
 * a clip that IS landscape is still served and still played, because hiding
 * somebody's library behind a rule about future work would be its own lie.
 */
export function verticalForRework(): PresentationTarget {
  return ALWAYS_VERTICAL;
}
