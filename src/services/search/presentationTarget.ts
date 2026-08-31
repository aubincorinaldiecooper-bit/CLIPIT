/**
 * What shape did the person actually ask for?
 *
 * "Find me 3 moments I can post on TikTok" is a request for vertical clips.
 * "Find the part where they introduce themselves" is not. Nothing in this
 * codebase read that difference before, so a vertical derivative would either
 * be built for everyone (wasteful, and wrong for someone who wants the
 * original framing) or for nobody.
 *
 * Read from the INSTRUCTION the person typed, because that is where the intent
 * lives — CLAUDE.md's rule that the user's instruction is the search applies
 * to how the result is presented too.
 *
 * Deliberately conservative: an explicit request to keep the original framing
 * always wins over a platform mention, because "post the original framing to
 * TikTok" is a coherent thing to want and guessing otherwise silently crops
 * footage somebody asked to keep whole.
 */

export type PresentationTarget = 'vertical' | 'source';

/** Platform words that imply a 9:16 deliverable. */
const VERTICAL_PLATFORMS = [
  'tiktok',
  'tik tok',
  'reels',
  'reel',
  'instagram',
  'shorts',
  'short-form',
  'short form',
  'youtube shorts',
  'vertical',
  'portrait',
  '9:16',
];

/**
 * Phrases that mean "leave the framing alone". Checked FIRST and allowed to
 * override a platform mention.
 */
const KEEP_ORIGINAL = [
  'keep original framing',
  'keep the original framing',
  'preserve original framing',
  'preserve the original framing',
  'preserve original aspect',
  'preserve the original aspect',
  'original aspect ratio',
  "don't crop",
  'do not crop',
  'dont crop',
  'no crop',
  'use the original framing',
  'use original framing',
  'keep it wide',
  'keep the full frame',
];

export interface PresentationIntent {
  target: PresentationTarget;
  /** The phrase that decided it, for the log line. Null when nothing matched. */
  matched: string | null;
}

export function presentationTargetFor(instruction: string | null | undefined): PresentationIntent {
  if (typeof instruction !== 'string' || instruction.trim() === '') {
    return { target: 'source', matched: null };
  }
  const text = instruction.toLowerCase();

  // An explicit "leave it alone" beats any platform word in the same sentence.
  for (const phrase of KEEP_ORIGINAL) {
    if (text.includes(phrase)) return { target: 'source', matched: phrase };
  }

  for (const phrase of VERTICAL_PLATFORMS) {
    if (text.includes(phrase)) return { target: 'vertical', matched: phrase };
  }

  // No signal is not a vertical request. Someone asking for "the part where
  // they introduce themselves" gets their footage as it was shot.
  return { target: 'source', matched: null };
}
