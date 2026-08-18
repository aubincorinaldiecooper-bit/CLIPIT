/**
 * When to look harder, and how.
 *
 * The scene index is a *retrieval* layer: it records what the indexer thought
 * worth writing down while summarising many frames at once. A detail it did
 * not mention — white text across a car's hood — is absent from the index but
 * plainly present in the video. So "the index has nothing" must never be
 * reported as "the video has nothing" without looking again at the footage
 * itself, with the user's actual question in hand.
 */

/**
 * Phrases that mean "you were wrong, try harder" rather than describing a new
 * moment. Searching these literally is meaningless — there is no scene in any
 * video matching "please look again" — so they re-run the previous question
 * with a deeper scan instead.
 */
const RETRY_PATTERNS = [
  /\blook\s+(again|harder|closer|more carefully)\b/i,
  /\b(try|check|search|scan)\s+again\b/i,
  /\bare\s+you\s+(sure|certain)\b/i,
  /\b(it'?s|its|there'?s)\s+(definitely|clearly|obviously)\s+there\b/i,
  /\bkeep\s+looking\b/i,
  /\b(re-?scan|re-?search|re-?check)\b/i,
  /\bthat'?s\s+wrong\b/i,
  /\byou\s+missed\s+it\b/i,
];

/** True when the instruction is a request to retry, not a new search. */
export function isRetryRequest(instruction: string): boolean {
  const trimmed = instruction.trim();
  if (!trimmed) return false;
  // A long instruction that happens to contain "check again" is still a real
  // instruction; a retry is a short aside.
  if (trimmed.split(/\s+/).length > 12) return false;
  return RETRY_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Cues that the answer depends on reading something on screen. Vision models
 * transcribe text far more reliably when told to look for it than when left
 * to describe a frame generally.
 */
const TEXT_CUE_PATTERNS = [
  /\bsays?\b/i,
  /\bwritten\b/i,
  /\bwrites\b/i,
  /\breads?\b/i,
  /\btexts?\b/i,
  /\bwords?\b/i,
  /\bsigns?\b/i,
  /\bcaptions?\b/i,
  /\bsubtitles?\b/i,
  /\bscoreboard\b/i,
  /\bscore\b/i,
  /\blabel(?:led|ed|s)?\b/i,
  /\btitles?\b/i,
  /\bheadlines?\b/i,
  /\blogos?\b/i,
  /\bnames?\b/i,
  /\bnumbers?\b/i,
  /\bspell(?:s|ed|ing)?\b/i,
  /\bprinted\b/i,
  /\bbanners?\b/i,
  /\bplates?\b/i,
  // Anything in quotes is almost always text to be matched literally.
  /["“”'']\s*\S/,
];

/** True when the instruction hinges on text visible in the frame. */
export function mentionsOnScreenText(instruction: string): boolean {
  return TEXT_CUE_PATTERNS.some((pattern) => pattern.test(instruction));
}

export interface RescanPlan {
  /** Frames sampled from each chunk. */
  framesPerChunk: number;
  /** Frames per model request. */
  framesPerCall: number;
  /** Total model calls the plan will make. */
  plannedCalls: number;
}

/**
 * Plans a rescan that always covers EVERY chunk — the point of looking again
 * is that we do not know where the missed moment is, so skipping regions
 * could skip the answer. Density is what gives way to the budget, never
 * coverage: with a tight budget a long video is scanned thinly rather than
 * partially.
 */
export function planRescan(input: {
  chunkCount: number;
  desiredFramesPerChunk: number;
  framesPerCall: number;
  maxModelCalls: number;
}): RescanPlan {
  const chunks = Math.max(1, Math.floor(input.chunkCount));
  const framesPerCall = Math.max(1, Math.floor(input.framesPerCall));
  const budget = Math.max(1, Math.floor(input.maxModelCalls));

  // At least one call per chunk, so every chunk is looked at.
  const callsPerChunk = Math.max(1, Math.floor(budget / chunks));
  const affordableFrames = callsPerChunk * framesPerCall;
  const framesPerChunk = Math.max(
    framesPerCall,
    Math.min(Math.max(1, Math.floor(input.desiredFramesPerChunk)), affordableFrames),
  );

  return {
    framesPerChunk,
    framesPerCall,
    plannedCalls: chunks * Math.ceil(framesPerChunk / framesPerCall),
  };
}
