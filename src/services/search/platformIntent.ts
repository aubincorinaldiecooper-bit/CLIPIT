import { presentationTargetFor, type PresentationTarget } from './presentationTarget.js';

/**
 * ONE canonical reading of what the creator asked for.
 *
 * Search and rendering must never form independent opinions about what
 * "TikTok" means. If the search path thinks a request is TikTok and the
 * render path does not, a creator gets landscape clips for a vertical ask and
 * every log line looks correct in isolation.
 *
 * RECONCILIATION NOTE (2026-08-31). The brief referenced commit 00fd3ae for a
 * platform-aware path. That SHA does not exist; the work is 0e3590b on branch
 * codex/implement-fast-candidate-path-for-clipit, which is NOT on main. It
 * introduced platformOutput.ts (duration profiles, explicit-duration
 * override) — complementary to this branch's presentationTarget.ts (framing),
 * but overlapping on platform detection, and knowing only 'tiktok'.
 *
 * This module is the single source of truth for both questions. The profile
 * SHAPE below is deliberately identical to platformOutput.ts's so that when
 * that branch merges, deleting its copy is mechanical rather than a rewrite.
 * Duration values are taken from it verbatim.
 */

export type OutputPlatform = 'tiktok' | 'reels' | 'shorts';

export interface PlatformOutputProfile {
  targetMinSeconds: number;
  targetMaxSeconds: number;
  hardMaxSeconds: number;
}

/**
 * Duration rules. tiktok's numbers are 0e3590b's, unchanged; reels and shorts
 * share them because all three are the same 60-second short-form shape and
 * inventing different numbers would be a guess dressed as a policy.
 */
export const PLATFORM_OUTPUT_PROFILES: Record<OutputPlatform, PlatformOutputProfile> = {
  tiktok: { targetMinSeconds: 15, targetMaxSeconds: 45, hardMaxSeconds: 60 },
  reels: { targetMinSeconds: 15, targetMaxSeconds: 45, hardMaxSeconds: 60 },
  shorts: { targetMinSeconds: 15, targetMaxSeconds: 45, hardMaxSeconds: 60 },
};

/** How each platform is actually written by the people asking for it. */
const PLATFORM_PATTERNS: Array<[OutputPlatform, RegExp]> = [
  // The trailing s matters: "give me 5 tiktoks" is how people actually ask,
  // and without it the platform came back null, no deck was built at all, and
  // the creator got a list of timestamps for an explicit TikTok request.
  ['tiktok', /\btik\s?toks?\b/i],
  ['reels', /\b(instagram\s+)?reels?\b|\binstagram\b/i],
  ['shorts', /\b(youtube\s+)?shorts?\b/i],
];

const UNIT_SECONDS: Record<string, number> = {
  second: 1, seconds: 1, sec: 1, secs: 1,
  minute: 60, minutes: 60, min: 60, mins: 60,
};

/** Numbers people write as words. Stops at ten; past that they use digits. */
const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  couple: 2, few: 3,
};

/**
 * What the deck is made of, however the creator names it.
 *
 * "video" is deliberately absent. In "what happens in this video" it names
 * the SOURCE, not something being asked for, and counting it would read an
 * ordinary question as a request for one clip.
 */
const MOMENT_WORDS = 'moment|clip|cut|highlight|post|short|reel|bit|tiktok';

/** "3 moments", "three funny clips", "a couple of highlights". */
const COUNTED = new RegExp(
  String.raw`\b(\d{1,3}|${Object.keys(WORD_NUMBERS).join('|')})\b`
  // Up to three words of description may sit between the number and the
  // noun: "3 really funny moments", "a couple of clips".
  + String.raw`(?:\s+\w+){0,3}?\s+(?:${MOMENT_WORDS})s?\b`,
  'i',
);

/** Every mention of the noun, so singular can be told from plural. */
const BARE_NOUN = new RegExp(String.raw`\b(?:${MOMENT_WORDS})(s?)\b`, 'gi');

/** A number that is really a duration: "30 second clips" is ONE clip. */
const DURATION_NUMBER = /\b\d+\s*(?:seconds?|secs?|minutes?|mins?)\b/i;

/**
 * "Find me 3 moments" — how many cards the deck should hold.
 *
 * Read from the request rather than fixed, because the number IS the request:
 * asking for three and receiving one is a wrong answer, and asking for one
 * and receiving three spends money on renders nobody agreed to. Returns null
 * when the creator did not say, and the caller supplies its default.
 *
 * Two phrases this deliberately gets right, because both are common and both
 * are expensive to misread:
 *
 *  - "a 30 second clip for TikTok" is ONE clip, not thirty. A number attached
 *    to a duration unit belongs to parseExplicitDurationSeconds, never here.
 *  - "the best moment", singular, is one — even with no number in it. Reading
 *    that as the default three would render two clips nobody asked for.
 */
export function parseRequestedMomentCount(instruction: string): number | null {
  const counted = instruction.match(COUNTED);
  if (counted && !DURATION_NUMBER.test(counted[0])) {
    const token = counted[1]!.toLowerCase();
    const value = WORD_NUMBERS[token] ?? Number(token);
    if (Number.isFinite(value) && value >= 1) return Math.floor(value);
  }

  // No number, but the noun itself can be singular or plural.
  //
  // Skipped when the word OPENS the instruction, because there it is a verb,
  // not a thing being counted. "post the 5 best bits to tiktok" was read as a
  // request for one moment — the leading "post" taken as a singular noun —
  // and the whole deck was built for a single card when five were asked for.
  for (const bare of instruction.matchAll(BARE_NOUN)) {
    // A word that OPENS the instruction is a verb, not a thing being counted:
    // "post the best bits", "clip this for tiktok". Skipping to the next
    // mention rather than giving up keeps the noun further along — "clip this
    // for tiktok" is still one moment, read off "tiktok".
    if (bare.index === 0) continue;
    return bare[1] ? null : 1;
  }

  return null;
}

/** "make it 30 seconds" — an explicit ask that outranks the default profile. */
export function parseExplicitDurationSeconds(instruction: string): number | null {
  const match = instruction.match(/\b(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?)\b/i);
  if (!match) return null;
  const seconds = Number(match[1]) * (UNIT_SECONDS[match[2]!.toLowerCase()] ?? 0);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export interface PlatformIntent {
  /** Null when nothing in the request named a short-form platform. */
  platform: OutputPlatform | null;
  profile: PlatformOutputProfile | null;
  /** 'vertical' means a real 9:16 derivative is owed. */
  presentationTarget: PresentationTarget;
  explicitDurationSeconds: number | null;
  /** The ceiling actually enforced, after the explicit ask and the global cap. */
  hardMaxSeconds: number;
  /** The phrase that decided the framing, for the log line. */
  matchedPhrase: string | null;
  /** How many moments the creator asked for. Never below one, never clamped. */
  requestedCount: number;
  /**
   * Whether that number was in the question. Without one, a platform
   * question keeps its default; a plain question means every moment found.
   */
  countExplicit: boolean;
  /** The most this pipeline will render for one request. */
  renderCeiling: number;
}

/**
 * Read the request once, and hand the same answer to search and to rendering.
 *
 * An explicit "keep the original framing" beats a platform word for FRAMING
 * but not for DURATION: "post a 30-second clip to TikTok but keep the
 * original framing" is a coherent request for a 30-second landscape clip, and
 * throwing away the duration rules with the crop would be over-reading it.
 */
export function resolvePlatformIntent(
  instruction: string | null | undefined,
  globalMaxSeconds: number,
  options: { defaultCount?: number; maxCount?: number } = {},
): PlatformIntent {
  const text = typeof instruction === 'string' ? instruction : '';
  const framing = presentationTargetFor(text);

  const found = PLATFORM_PATTERNS.find(([, pattern]) => pattern.test(text));
  const platform = found?.[0] ?? null;
  const profile = platform ? PLATFORM_OUTPUT_PROFILES[platform] : null;
  const explicitDurationSeconds = parseExplicitDurationSeconds(text);
  const explicitCount = parseRequestedMomentCount(text);

  // The global product limit is never exceeded, explicit ask or not.
  const hardMaxSeconds = explicitDurationSeconds !== null
    ? Math.min(explicitDurationSeconds, globalMaxSeconds)
    : profile
      ? Math.min(profile.hardMaxSeconds, globalMaxSeconds)
      : globalMaxSeconds;

  return {
    platform,
    profile,
    // A platform was named but the creator asked to keep the framing: they
    // get the duration rules and their original shape.
    presentationTarget: framing.target,
    explicitDurationSeconds,
    hardMaxSeconds,
    matchedPhrase: framing.matched,
    // What the creator ASKED FOR, and nothing else. Clamping it to the render
    // ceiling here meant "give me 12 clips for TikTok" was recorded, reported
    // and shown back as a request for 8 — the number we were willing to make
    // standing in for the number they wanted, with nothing left saying
    // otherwise. The ceiling still applies; it applies to the deck target,
    // which is a different quantity and now has its own name.
    requestedCount: Math.max(1, explicitCount ?? options.defaultCount ?? 3),
    countExplicit: explicitCount !== null,
    /** The most this pipeline will render for one request. */
    renderCeiling: Math.max(1, options.maxCount ?? 8),
  };
}

/**
 * Does a vertical derivative need making for this request? Always.
 *
 * This used to require a named platform AND a vertical framing target, so a
 * search that never said "TikTok" produced a landscape clip. Every clip is
 * 9:16 now — the owner's rule of 2026-09-03, and the reasoning lives in
 * presentationTarget.ts. The intent is still read for everything else it
 * decides: which platform's limits apply, how many moments, how long each
 * may run.
 */
export function needsVerticalDerivative(_intent: PlatformIntent): boolean {
  return true;
}

/**
 * Reject an over-long candidate BEFORE anything expensive happens to it.
 * Rendering an 85-second clip and only then discovering the profile refuses it
 * spends a GPU call and an encode on something that was never eligible.
 */
export function exceedsPlatformHardMax(
  range: { startSeconds: number; endSeconds: number },
  intent: PlatformIntent,
): boolean {
  if (intent.platform === null) return false;
  return range.endSeconds - range.startSeconds > intent.hardMaxSeconds + 0.001;
}
