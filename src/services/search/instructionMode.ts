import type { EvidenceRequirement, ResolvedSearchMode, SearchMode } from '../../domain/types.js';

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
 * Whether the instruction quotes something.
 *
 * A quoted phrase proves nothing about modality: it can be said aloud or
 * painted on a car hood. Counting it as speech routed `Find "SALE"` to a
 * transcript-only search, which is never sent the video and so can never
 * satisfy the phrase from what is on screen — a false negative on exactly the
 * instruction shape most likely to be about visible text.
 *
 * This detects a quotation rather than parsing one, because nothing here reads
 * the quoted text — only whether a quotation is present. Matching delimiter
 * pairs meant tracking what may appear between them, and an apostrophe inside
 * the quote (`‘I’m done’`) closed it early and lost the match. Looking for a
 * single opening mark has no interior to get wrong.
 *
 * Apostrophes are the whole difficulty: `'` and `’` are also quote characters,
 * so both are only counted when they do not sit inside a word, which keeps
 * `he's` and `isn’t` from turning a plain transcript search into a full video
 * upload. The unambiguous marks — `"`, `“`, `”`, `‘` — are never apostrophes
 * and need no such guard.
 */
const QUOTATION = /["“”‘]|(?<![\p{L}\p{N}])['’]/u;

/**
 * Things text is written ON. Without these, "the sign that says EXIT" reads
 * as pure speech and never gets the video that the sign is visible in. They
 * also decide what a quoted phrase is: beside one of these the phrase is
 * plausibly what is written there, which nobody need say aloud.
 */
const TEXT_SURFACE_PATTERNS: RegExp[] = [
  /\b(sign|signs|label|labels|banner|poster|billboard|placard)\b/i,
  /\b(shirt|jersey|hoodie|cap|hat|badge|name ?tag|sticker|decal)\b/i,
  /\b(caption|captions|subtitle|subtitles|headline|logo|licen[cs]e plate)\b/i,
  /\b(hood|bumper|windshield|title card|lower third|whiteboard|slide|chart|graph|screen|scoreboard)\b/i,
  /\b(text|writing|written|printed|says on|reads)\b/i,
];

const TEXT_SURFACES = 'sign|signs|label|labels|banner|poster|billboard|placard'
  + '|shirt|jersey|hoodie|cap|hat|badge|name ?tag|sticker|decal'
  + '|caption|captions|subtitle|subtitles|headline|logo|licen[cs]e plate'
  + '|hood|bumper|windshield|title card|lower third|whiteboard|slide|chart|graph|screen|scoreboard'
  + '|text|writing';
const SURFACE_WORD = new RegExp(String.raw`\b(?:${TEXT_SURFACES})\b`, 'giu');
/** Any quote mark; an apostrophe (straight or curly) counts only when it is not inside a word. */
const QUOTE_MARK = /["“”‘]|(?<![\p{L}\p{N}])['’]|['’](?![\p{L}\p{N}])/gu;
/** How many words may sit between a surface and its quote. */
const BRIDGE_WORDS = 4;
/**
 * A word that starts a new clause or names a speaker: the surface and the
 * quote are then two things, not one (`the banner while he says "..."`).
 */
const BRIDGE_BREAKERS = new Set([
  'while', 'when', 'as', 'and', 'but', 'then', 'before', 'after', 'because', 'until', 'where', 'if', 'who', 'whom',
  'i', 'we', 'you', 'he', 'she', 'they', 'him', 'her', 'them', 'someone', 'somebody', 'everyone', 'people', 'man', 'woman', 'guy', 'girl',
]);
/** `"we are live" on the banner`: the quote is placed on the surface. */
const PLACING_PREPOSITIONS = new Set(['on', 'onto', 'upon', 'across', 'over', 'in', 'at', 'of']);

function bridgeWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

const WORD_CHARACTER = /[\p{L}\p{N}]/u;

function closesSpan(opener: string, mark: string): boolean {
  return (opener === '“' && mark === '”')
    || (opener === '‘' && (mark === '’' || mark === "'"))
    || (opener === '"' && mark === '"')
    || (opener === "'" && (mark === "'" || mark === '’'));
}

/**
 * The quoted spans of the sentence, as [opening mark, closing mark] offsets.
 * While a span is open only its own closer ends it: an apostrophe or a
 * differently styled mark inside (`"James' car"`) is part of the quoted
 * text. Inside a single-quoted span a word-final apostrophe looks exactly
 * like the closer (`‘James' car is on the screen’`), so the last candidate
 * in the sentence closes it. A span left open runs to the end of the
 * sentence, as the QUOTATION test above already accepts a single opening
 * mark. A closing-style mark with nothing open, a straight apostrophe not
 * followed by a word (`James' car`), or a straight double mark right after a
 * digit (`12"`, a measurement) is punctuation, not a quote.
 */
function quoteSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const marks = [...text.matchAll(QUOTE_MARK)].map((match) => ({ mark: match[0], index: match.index ?? 0 }));
  let open: { index: number; mark: string } | null = null;
  for (let position = 0; position < marks.length; position += 1) {
    const { mark, index } = marks[position]!;
    if (open !== null) {
      const opener = open.mark;
      if (!closesSpan(opener, mark)) continue;
      const singleQuoted = opener === '‘' || opener === "'";
      if (singleQuoted && marks.slice(position + 1).some((later) => closesSpan(opener, later.mark))) continue;
      spans.push({ start: open.index, end: index });
      open = null;
      continue;
    }
    if (mark === '”' || mark === '’') continue;
    if (mark === "'" && !WORD_CHARACTER.test(text.charAt(index + 1))) continue;
    if (mark === '"' && /\d/.test(text.charAt(index - 1))) continue;
    open = { index, mark };
  }
  if (open !== null) spans.push({ start: open.index, end: text.length });
  return spans;
}

/**
 * Whether the quoted phrase is written on a named surface. The surface word
 * must sit outside the quote, near it, with nothing between them that starts
 * a new clause or names a speaker: `the sign that clearly says "EXIT"`, `the
 * sign says, "EXIT"`, `the banner displaying the words "SALE"`, `a shirt with
 * "BOSS"`, or, the other way round with a placing preposition, `says "we are
 * live" on the banner`. A surface word elsewhere in the sentence (`she says
 * "goodbye" while the screen fades`, `the banner while he says "..."`) is a
 * separate visual condition, and a surface word inside the quote (`she says
 * "look at the screen"`) is part of what is said, not where it is written.
 */
export function quoteOnSurface(text: string): boolean {
  const spans = quoteSpans(text);
  if (spans.length === 0) return false;
  // Blank out the quoted text so a surface word inside a quote is never seen.
  const outside = text.split('');
  for (const span of spans) {
    for (let index = span.start + 1; index < span.end; index += 1) outside[index] = ' ';
  }
  const visible = outside.join('');
  for (const span of spans) {
    const before = visible.slice(0, span.start);
    const lastSurface = [...before.matchAll(SURFACE_WORD)].at(-1);
    if (lastSurface) {
      const between = bridgeWords(before.slice((lastSurface.index ?? 0) + lastSurface[0].length));
      if (between.length <= BRIDGE_WORDS && !between.some((word) => BRIDGE_BREAKERS.has(word))) return true;
    }
    const after = visible.slice(span.end + 1);
    const firstSurface = [...after.matchAll(SURFACE_WORD)][0];
    if (firstSurface) {
      const between = bridgeWords(after.slice(0, firstSurface.index ?? 0));
      if (
        between.length <= BRIDGE_WORDS
        && between.some((word) => PLACING_PREPOSITIONS.has(word))
        && !between.some((word) => BRIDGE_BREAKERS.has(word))
      ) return true;
    }
  }
  return false;
}

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
  /\b(scene|shot|frame|footage|camera|gameplay)\b/i,
  /\b(level|stage|map|menu|hud|replay)\b/i,
  ...TEXT_SURFACE_PATTERNS,
  /\b(door|wall|board)\b/i,
  /\b(red|blue|green|yellow|black|white|orange|purple)\b/i,
  /\b(dog|cat|car|ball)\b/i,
  /\b(celebrat\w+|dance|dancing|laugh\w*|smile|smiling|cry\w*)\b/i,
];

export interface ModeClassification {
  mode: ResolvedSearchMode;
  /**
   * `both` is returned for two different reasons, and they must not be
   * confused downstream: a question that mixes spoken and visual signals
   * needs both ('all'); a question with no signal, or a quoted phrase that
   * may be spoken or on screen, is searched in both sources and either may
   * satisfy it ('any').
   */
  evidence: EvidenceRequirement;
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
      evidence: 'any',
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
    if (QUOTATION.test(text)) {
      return {
        mode: 'both',
        evidence: 'any',
        spokenScore,
        visualScore,
        rationale: 'quoted phrase may be spoken or visible on screen; searching video and transcript',
      };
    }
    return { mode: 'transcript', evidence: 'all', spokenScore, visualScore, rationale: 'instruction refers to spoken content' };
  }

  if (visualScore > 0 && spokenScore === 0) {
    return { mode: 'visual', evidence: 'all', spokenScore, visualScore, rationale: 'instruction refers to on-screen content' };
  }

  // A quoted phrase is modality-ambiguous when the sentence writes it on a
  // surface: `the sign that says "EXIT"` names a sign and "says", and the
  // sign satisfies it with nobody speaking, so either source may establish
  // it. Otherwise "says" beside a visual condition is speech beside that
  // condition (`she says "goodbye" while leaving the room`, `she says
  // "goodbye" while the screen fades`), and a sentence that mixes spoken and
  // visual conditions needs both.
  if (QUOTATION.test(text) && quoteOnSurface(text)) {
    return {
      mode: 'both',
      evidence: 'any',
      spokenScore,
      visualScore,
      rationale: 'quoted phrase beside a surface text is written on; either source may establish it',
    };
  }
  return {
    mode: 'both',
    evidence: 'all',
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
  /** See ModeClassification.evidence. An explicitly requested `both` is 'all'. */
  evidence: EvidenceRequirement;
  rationale: string;
}

/**
 * Combines the caller's request, the classifier, and what the video actually
 * has available. Never returns a mode the video cannot serve.
 */
export function resolveSearchMode(input: ResolveModeInput): ResolvedMode {
  const requested = input.requested;

  let candidate: ResolvedSearchMode;
  let evidence: EvidenceRequirement;
  let rationale: string;

  if (requested === 'auto') {
    const classification = classifyInstruction(input.instruction);
    candidate = classification.mode;
    evidence = classification.evidence;
    rationale = `auto: ${classification.rationale}`;
  } else {
    // A caller who asks for both sources by name means both.
    candidate = requested;
    evidence = 'all';
    rationale = `explicitly requested: ${requested}`;
  }

  if (!input.transcriptAvailable && candidate !== 'visual') {
    return {
      mode: 'visual',
      evidence: 'all',
      rationale: `${rationale}; no transcript available, falling back to visual search`,
    };
  }

  return { mode: candidate, evidence, rationale };
}
