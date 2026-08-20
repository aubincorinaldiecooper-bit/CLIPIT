import type { ResolvedSearchMode, SearchMode } from '../../domain/types.js';

/**
 * Decides whether an instruction is about what is *said*, what is *seen*, or
 * both. This is deliberately a transparent heuristic rather than a model call:
 * it runs before any paid request, is cheap, and is easy to unit test. The
 * caller can always override it (`mode` on the clip request).
 */

const SPOKEN_PATTERNS: RegExp[] = [
  /\b(say|says|said|saying)\b/i,
  /\b(talk|talks|talked|talking)\b/i,
  /\b(speak|speaks|spoke|speaking)\b/i,
  /\b(explain|explains|explained|explaining|explanation)\b/i,
  /\b(mention|mentions|mentioned|mentioning)\b/i,
  /\b(tell|tells|told|telling)\b/i,
  /\b(answer|answers|answered|question|asked|asks)\b/i,
  /\b(discuss|discusses|discussed|discussing|discussion)\b/i,
  /\b(describe|describes|described|describing)\b/i,
  /\b(announce|announces|announced|announcing)\b/i,
  /\b(rant|rants|ranted|story|anecdote|joke|jokes)\b/i,
  /\b(interview|monologue|commentary|podcast)\b/i,
  /\b(quote|quotes|quoted|word for word|verbatim)\b/i,
  /\b(promise|promised|apolog\w+|complain\w*|admit\w*|confess\w*)\b/i,
  /\bthe part where\b.*\b(i|he|she|they|we|you)\b/i,
  /\breason(s)? (why|for|behind)\b/i,
  /\b(why|because)\b/i,
  /\b(topic|subject) of\b/i,
];

/**
 * A quoted phrase proves nothing about modality: it can be said aloud or
 * painted on a car hood. Counting it as speech routed `Find "SALE"` to a
 * transcript-only search, which is never sent the video and so can never
 * satisfy the phrase from what is on screen — a false negative on exactly the
 * instruction shape most likely to be about visible text.
 *
 * Curly quotes are included because instructions get pasted from anywhere.
 */
const QUOTED_PHRASE = /"[^"]{2,}"|“[^”]{2,}”|'[^']{4,}'/;

const VISUAL_PATTERNS: RegExp[] = [
  /\b(show|shows|showed|showing|shown)\b/i,
  /\b(see|sees|saw|seen|visible|on screen|onscreen)\b/i,
  /\b(appear|appears|appeared|appearing)\b/i,
  /\b(score|scores|scored|scoring|goal|goals|touchdown|point|points)\b/i,
  /\b(kill|kills|killed|death|dies|died|headshot|clutch|ace)\b/i,
  /\b(boss|fight|fights|fighting|battle|raid|combat)\b/i,
  /\b(win|wins|won|victory|lose|loses|lost|defeat)\b/i,
  /\b(crash|crashes|crashed|explosion|explodes|jump|jumps|dunk|trick)\b/i,
  /\b(enter|enters|entered|join|joins|joined|leave|leaves|walks? in)\b/i,
  /\b(wear|wearing|wears|holding|holds|picks? up)\b/i,
  /\b(scene|shot|frame|footage|camera|screen|gameplay)\b/i,
  /\b(level|stage|map|menu|scoreboard|hud|replay)\b/i,
  // Things text is written ON. Without these, "the sign that says EXIT" reads
  // as pure speech and never gets the video that the sign is visible in.
  /\b(sign|signs|label|labels|banner|poster|billboard|placard)\b/i,
  /\b(shirt|jersey|hoodie|cap|hat|badge|name ?tag|sticker|decal)\b/i,
  /\b(caption|captions|subtitle|subtitles|headline|logo|licen[cs]e plate)\b/i,
  /\b(hood|bumper|windshield|door|wall|board|title card|lower third)\b/i,
  /\b(text|writing|written|printed|says on|reads)\b/i,
  /\b(red|blue|green|yellow|black|white|orange|purple)\b/i,
  /\b(dog|cat|car|ball|door|whiteboard|slide|chart|graph)\b/i,
  /\b(celebrat\w+|dance|dancing|laugh\w*|smile|smiling|cry\w*)\b/i,
];

export interface ModeClassification {
  mode: ResolvedSearchMode;
  spokenScore: number;
  visualScore: number;
  /** Human-readable justification, echoed back on the clip request for debugging. */
  rationale: string;
}

export function classifyInstruction(instruction: string): ModeClassification {
  const text = instruction ?? '';
  const spokenScore = SPOKEN_PATTERNS.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);
  const visualScore = VISUAL_PATTERNS.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0);

  if (spokenScore === 0 && visualScore === 0) {
    return {
      mode: 'both',
      spokenScore,
      visualScore,
      rationale: 'no strong spoken or visual signal; searching frames and transcript',
    };
  }

  if (spokenScore > 0 && visualScore === 0) {
    // Speech words alone are not enough to drop the video when the thing being
    // matched is a quoted phrase, because that phrase may be on screen rather
    // than in the audio. Erring toward `both` costs one upload; erring toward
    // `transcript` cannot find visible text at all.
    if (QUOTED_PHRASE.test(text)) {
      return {
        mode: 'both',
        spokenScore,
        visualScore,
        rationale: 'quoted phrase may be spoken or visible on screen; searching video and transcript',
      };
    }
    return { mode: 'transcript', spokenScore, visualScore, rationale: 'instruction refers to spoken content' };
  }

  if (visualScore > 0 && spokenScore === 0) {
    return { mode: 'visual', spokenScore, visualScore, rationale: 'instruction refers to on-screen content' };
  }

  return {
    mode: 'both',
    spokenScore,
    visualScore,
    rationale: 'instruction mixes spoken and visual signals',
  };
}

export interface ResolveModeInput {
  instruction: string;
  requested: SearchMode;
  /** False when the video has no usable transcript (disabled, failed, or silent source). */
  transcriptAvailable: boolean;
}

export interface ResolvedMode {
  mode: ResolvedSearchMode;
  rationale: string;
}

/**
 * Combines the caller's request, the classifier, and what the video actually
 * has available. Never returns a mode the video cannot serve.
 */
export function resolveSearchMode(input: ResolveModeInput): ResolvedMode {
  const requested = input.requested;

  let candidate: ResolvedSearchMode;
  let rationale: string;

  if (requested === 'auto') {
    const classification = classifyInstruction(input.instruction);
    candidate = classification.mode;
    rationale = `auto: ${classification.rationale}`;
  } else {
    candidate = requested;
    rationale = `explicitly requested: ${requested}`;
  }

  if (!input.transcriptAvailable && candidate !== 'visual') {
    return {
      mode: 'visual',
      rationale: `${rationale}; no transcript available, falling back to visual search`,
    };
  }

  return { mode: candidate, rationale };
}
