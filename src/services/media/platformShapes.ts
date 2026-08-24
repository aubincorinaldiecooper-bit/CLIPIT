import type { VariantAspect } from '../../db/repositories/clipVariants.js';

/**
 * The shape each platform wants.
 *
 * This is the whole point of automatic reframing: a person should not have
 * to know that TikTok is 9:16 and a YouTube upload is 16:9, or remember to
 * cut two versions before posting to both. They press Publish; the file that
 * goes out is the right shape for where it is going.
 *
 * The mapping is deliberately explicit and boring — no clever inference from
 * clip length or content. It is also SURFACED in the publish panel rather
 * than applied silently, because a crop discards footage, and a person is
 * entitled to see what will be thrown away before it happens.
 */
const PLATFORM_SHAPE: Record<string, VariantAspect> = {
  tiktok: '9:16',
  // Reels is the destination a clip goes to on Instagram, and Reels is 9:16.
  instagram: '9:16',
  // A YouTube upload is landscape. Shorts is 9:16, but a clip is only a
  // Short if it is under a minute AND uploaded as one — guessing wrong would
  // letterbox a real upload, so the safe default is the platform's own.
  youtube: '16:9',
};

/**
 * Which shape a platform needs, or null when we have no opinion — an unknown
 * platform is posted exactly as the clip was shot, never cropped on a guess.
 */
export function shapeForPlatform(platform: string): VariantAspect | null {
  return PLATFORM_SHAPE[platform] ?? null;
}

/**
 * Group publish targets by the shape they need.
 *
 * The publishing API takes ONE file per post, so targets wanting different
 * shapes cannot share a call: TikTok and YouTube in the same action become
 * two posts, each carrying its own correctly-cut file. Targets whose shape
 * matches the clip as shot (or whose platform we have no opinion about) fall
 * into the `null` group and post the original file.
 */
export function groupTargetsByShape<T extends { platform: string }>(
  targets: T[],
  sourceAspect: VariantAspect | null,
): Array<{ aspect: VariantAspect | null; targets: T[] }> {
  const groups = new Map<string, { aspect: VariantAspect | null; targets: T[] }>();
  for (const target of targets) {
    const wanted = shapeForPlatform(target.platform);
    // Already the right shape? Then there is nothing to cut, and the master
    // file is what should go out.
    const aspect = wanted && wanted !== sourceAspect ? wanted : null;
    const key = aspect ?? 'source';
    const group = groups.get(key);
    if (group) group.targets.push(target);
    else groups.set(key, { aspect, targets: [target] });
  }
  return [...groups.values()];
}

/** The shape a source's own dimensions already are, if it is one we cut to. */
export function aspectOfSource(width: number | null, height: number | null): VariantAspect | null {
  if (!width || !height || width < 2 || height < 2) return null;
  const ratio = width / height;
  const candidates: Array<[VariantAspect, number]> = [
    ['9:16', 9 / 16],
    ['4:5', 4 / 5],
    ['1:1', 1],
    ['16:9', 16 / 9],
  ];
  for (const [aspect, target] of candidates) {
    // Within a percent: a 1080×1920 and a 1078×1918 are both 9:16 in every
    // way that matters to a platform.
    if (Math.abs(ratio - target) / target < 0.01) return aspect;
  }
  return null;
}
