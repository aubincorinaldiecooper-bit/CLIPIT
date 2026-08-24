import { z } from 'zod';

/**
 * Reframing: cutting a clip to the shape the platform wants.
 *
 * A concert shot at 16:9 is the wrong shape for Reels, TikTok and Shorts,
 * and "post it anyway" means black bars or an automatic centre crop that
 * loses whatever was not in the middle. So the shape is part of the clip's
 * spec, and so is WHICH PART of the frame survives — the subject is rarely
 * dead centre.
 *
 * The crop is expressed against the source's own pixels and always lands on
 * even numbers, because H.264 chroma subsampling cannot encode an odd
 * dimension. Nothing is ever upscaled: a 9:16 cut of a 1920×1080 source is
 * 608×1080 of the ORIGINAL pixels, which every platform accepts. Padding a
 * frame to a "standard" 1080×1920 would only invent pixels the camera never
 * saw.
 */

export const clipFormatSchema = z.object({
  /**
   * The shape to cut to. "source" keeps the video exactly as it was shot —
   * the default, so a clip nobody reframed is byte-identical to before.
   */
  aspect: z.enum(['source', '9:16', '1:1', '4:5', '16:9']).default('source'),
  /**
   * Which part of the frame to keep, as the % position of the crop window's
   * CENTRE along the axis being cut. 50 is the middle; lower keeps the left
   * (or top), higher the right (or bottom). Ignored for "source".
   */
  focusPct: z.number().min(0).max(100).default(50),
});

export type ClipFormat = z.infer<typeof clipFormatSchema>;

const RATIOS: Record<Exclude<ClipFormat['aspect'], 'source'>, number> = {
  '9:16': 9 / 16,
  '1:1': 1,
  '4:5': 4 / 5,
  '16:9': 16 / 9,
};

/** Largest even number at or below n, floored to at least 2. */
function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

export interface ReframePlan {
  /** The ffmpeg crop filter, or null when the source is kept as shot. */
  filter: string | null;
  /** The frame captions will be drawn on — the crop's size, not the source's. */
  outputWidth: number;
  outputHeight: number;
}

/**
 * Work out the crop for one clip.
 *
 * The window is as large as the source allows: cutting 9:16 out of a
 * landscape frame keeps the FULL height and narrows the width; cutting 16:9
 * out of a portrait frame keeps the full width and shortens the height. The
 * window is then slid along the axis being cut, to `focusPct`, and clamped so
 * it can never leave the frame.
 */
export function planReframe(
  format: ClipFormat | null | undefined,
  source: { width: number; height: number },
): ReframePlan {
  const aspect = format?.aspect ?? 'source';
  // Guard the RAW numbers: a probe that knew nothing reports 0, and rounding
  // that to an even 2 would produce a 2×2 crop of a real video.
  if (!Number.isFinite(source.width) || !Number.isFinite(source.height) || source.width < 2 || source.height < 2) {
    return { filter: null, outputWidth: source.width, outputHeight: source.height };
  }

  const width = even(source.width);
  const height = even(source.height);
  if (aspect === 'source') {
    return { filter: null, outputWidth: width, outputHeight: height };
  }

  const target = RATIOS[aspect];
  const sourceRatio = width / height;

  let cropWidth = width;
  let cropHeight = height;
  if (sourceRatio > target) {
    // Source is wider than the target: keep the height, narrow the width.
    cropWidth = even(height * target);
  } else if (sourceRatio < target) {
    // Source is taller: keep the width, shorten the height.
    cropHeight = even(width / target);
  } else {
    // Already the right shape — nothing to cut, and saying so keeps the
    // encode from doing a pointless copy of every pixel.
    return { filter: null, outputWidth: width, outputHeight: height };
  }

  const focus = Number.isFinite(format?.focusPct) ? (format?.focusPct ?? 50) : 50;
  const slack = { x: width - cropWidth, y: height - cropHeight };
  // The window's centre sits at focusPct along the axis; the clamp is what
  // keeps it inside the frame at either extreme.
  const x = Math.round(Math.min(slack.x, Math.max(0, (focus / 100) * width - cropWidth / 2)));
  const y = Math.round(Math.min(slack.y, Math.max(0, (focus / 100) * height - cropHeight / 2)));

  return {
    filter: `crop=${cropWidth}:${cropHeight}:${slack.x === 0 ? 0 : x}:${slack.y === 0 ? 0 : y}`,
    outputWidth: cropWidth,
    outputHeight: cropHeight,
  };
}
