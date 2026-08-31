export interface PlatformOutputProfile {
  targetMinSeconds: number;
  targetMaxSeconds: number;
  hardMaxSeconds: number;
}

export const PLATFORM_OUTPUT_PROFILES = {
  tiktok: { targetMinSeconds: 15, targetMaxSeconds: 45, hardMaxSeconds: 60 },
} as const satisfies Record<string, PlatformOutputProfile>;

export type OutputPlatform = keyof typeof PLATFORM_OUTPUT_PROFILES;

export interface ActivePlatformOutput {
  platform: OutputPlatform;
  profile: PlatformOutputProfile;
  /** Explicit user durations override recommendation defaults, but not the global product limit. */
  explicitDurationSeconds: number | null;
  hardMaxSeconds: number;
}

const UNIT_SECONDS: Record<string, number> = { second: 1, seconds: 1, sec: 1, secs: 1, minute: 60, minutes: 60, min: 60, mins: 60 };

export function parseExplicitDurationSeconds(instruction: string): number | null {
  const match = instruction.match(/\b(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?)\b/i);
  if (!match) return null;
  const seconds = Number(match[1]) * UNIT_SECONDS[match[2]!.toLowerCase()]!;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export function resolvePlatformOutput(instruction: string, globalMaxSeconds: number): ActivePlatformOutput | null {
  const platform = (Object.keys(PLATFORM_OUTPUT_PROFILES) as OutputPlatform[])
    .find((candidate) => new RegExp(`\\b${candidate}\\b`, 'i').test(instruction));
  if (!platform) return null;
  const explicitDurationSeconds = parseExplicitDurationSeconds(instruction);
  const profile = PLATFORM_OUTPUT_PROFILES[platform];
  return {
    platform,
    profile,
    explicitDurationSeconds,
    hardMaxSeconds: explicitDurationSeconds === null
      ? Math.min(profile.hardMaxSeconds, globalMaxSeconds)
      : globalMaxSeconds,
  };
}

export function exceedsPlatformHardMax(
  range: { startSeconds: number; endSeconds: number },
  active: ActivePlatformOutput | null,
): boolean {
  return active !== null && range.endSeconds - range.startSeconds > active.hardMaxSeconds + 0.001;
}
