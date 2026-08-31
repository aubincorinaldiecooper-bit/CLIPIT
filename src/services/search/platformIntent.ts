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
  ['tiktok', /\btik\s?tok\b/i],
  ['reels', /\b(instagram\s+)?reels?\b|\binstagram\b/i],
  ['shorts', /\b(youtube\s+)?shorts?\b/i],
];

const UNIT_SECONDS: Record<string, number> = {
  second: 1, seconds: 1, sec: 1, secs: 1,
  minute: 60, minutes: 60, min: 60, mins: 60,
};

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
): PlatformIntent {
  const text = typeof instruction === 'string' ? instruction : '';
  const framing = presentationTargetFor(text);

  const found = PLATFORM_PATTERNS.find(([, pattern]) => pattern.test(text));
  const platform = found?.[0] ?? null;
  const profile = platform ? PLATFORM_OUTPUT_PROFILES[platform] : null;
  const explicitDurationSeconds = parseExplicitDurationSeconds(text);

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
  };
}

/** Does a vertical derivative need making for this request? */
export function needsVerticalDerivative(intent: PlatformIntent): boolean {
  return intent.platform !== null && intent.presentationTarget === 'vertical';
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
