/**
 * Composition: turning a decision about MEANING into deterministic pixels.
 *
 * The division of labour this file exists to keep honest:
 *
 *   MiniCPM decides WHAT must remain visible.
 *   FFmpeg decides HOW to make that fit.
 *
 * Everything here is arithmetic and filter strings. Nothing in this file
 * looks at a frame, recognises a face, or forms an opinion about a subject —
 * that judgement arrives from the model as a focal point and a yes/no, and is
 * executed here without interpretation. Keeping it that way is what stops a
 * tracker creeping in the next time a crop looks wrong.
 *
 * Pure on purpose: every number below can be tested without encoding a frame.
 */

/** The shapes the reader can be told about. */
export type AspectLabel = '16:9' | '9:16' | '1:1' | '4:3' | '4:5' | '21:9' | string;

/**
 * How a vertical derivative was actually produced. Must stay truthful:
 * 'smart_crop' means a crop was judged safe by the model, and nothing else.
 */
export type CompositionMode = 'smart_crop' | 'blurred_background' | 'padded' | 'original';

/**
 * Where the poster frame is taken from: a quarter of the way in.
 *
 * Frame zero is the worst possible choice — cuts routinely open on a fade, a
 * title card, or the tail of the previous shot, and a library full of black
 * rectangles is what "use the first frame" actually produces. A quarter in is
 * far enough to be past the transition and early enough to still be the
 * moment the clip was cut for.
 *
 * The clamp matters more than the fraction on short clips: on a 2-second cut,
 * 25% is 0.5s, and the inset keeps it off both edges so a frame always exists
 * to extract.
 */
export function posterOffsetSeconds(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  const MIN_INSET = 0.25;
  // Never within a quarter-second of the end: seeking to the final frame is
  // where extraction reliably returns nothing.
  const latest = Math.max(0, durationSeconds - MIN_INSET);
  const quarter = durationSeconds * 0.25;
  return Number(Math.min(latest, Math.max(Math.min(MIN_INSET, latest), quarter)).toFixed(3));
}

/** Greatest common divisor, for reducing measured pixels to a ratio. */
function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * The source's shape as a label, from MEASURED pixels only.
 *
 * Never from a filename and never from a container hint: the reader shows this
 * to a person, and "16:9" about a portrait video is a lie that costs them a
 * bad crop. Common ratios are snapped within 1% because real encodes are not
 * arithmetically exact (1920x1080 is, 1918x1080 is not), and anything else is
 * reduced honestly rather than forced into a familiar name.
 */
export function aspectRatioLabel(width: number | null, height: number | null): AspectLabel | null {
  if (!Number.isFinite(width as number) || !Number.isFinite(height as number)) return null;
  const w = Number(width);
  const h = Number(height);
  if (w < 2 || h < 2) return null;

  const ratio = w / h;
  const common: Array<[AspectLabel, number]> = [
    ['16:9', 16 / 9],
    ['9:16', 9 / 16],
    ['1:1', 1],
    ['4:3', 4 / 3],
    ['4:5', 4 / 5],
    ['21:9', 21 / 9],
  ];
  for (const [label, target] of common) {
    if (Math.abs(ratio - target) / target < 0.01) return label;
  }

  const divisor = gcd(Math.round(w), Math.round(h)) || 1;
  return `${Math.round(w / divisor)}:${Math.round(h / divisor)}`;
}

/**
 * The model answers in normalized frame coordinates; planReframe slides its
 * window along ONE axis as a percentage. This is the translation.
 *
 * Which axis matters is decided by the shapes, not by the model: cutting 9:16
 * out of a landscape frame keeps the full height and moves horizontally, so
 * focal_x is what counts and focal_y is irrelevant. Handing planReframe the
 * wrong axis would slide the window against an axis it is not cutting, which
 * silently ignores the model's judgement — the crop would look centred and
 * nobody would know the decision had been discarded.
 */
export function focusPctForCrop(
  focalX: number,
  focalY: number,
  source: { width: number; height: number },
  targetRatio: number,
): number {
  const sourceRatio = source.width / source.height;
  // Wider than the target means the width is being cut: travel horizontally.
  const along = sourceRatio > targetRatio ? focalX : focalY;
  const clamped = Math.min(1, Math.max(0, Number.isFinite(along) ? along : 0.5));
  return Number((clamped * 100).toFixed(2));
}

/**
 * The blurred-background composition, as one FFmpeg filter chain.
 *
 * Black bars are the thing this exists to avoid. A 16:9 clip dropped into a
 * 9:16 frame leaves two thirds of the canvas empty, and on TikTok that reads
 * as a reposted YouTube video. Filling it with a blurred, enlarged copy of the
 * same footage keeps the canvas alive while the real frame stays COMPLETE and
 * uncropped in the middle — nothing the camera saw is thrown away, which is
 * the whole reason this mode is the safe fallback.
 *
 * The chain:
 *   background — scale to cover the canvas, centre-crop the overflow, blur;
 *   foreground — scale to fit entirely inside the canvas, untouched otherwise;
 *   overlay    — foreground centred on background.
 *
 * `force_original_aspect_ratio` does the fitting arithmetic inside FFmpeg, so
 * a rounding error here cannot squash someone's footage.
 */
export function blurredBackgroundFilter(canvas: { width: number; height: number }, blurSigma = 24): string {
  const { width, height } = canvas;
  return [
    `[0:v]split=2[bg][fg]`,
    // increase=cover the canvas, crop the excess, then blur hard enough that
    // it reads as texture rather than as a second, confusing video.
    `[bg]scale=${width}:${height}:force_original_aspect_ratio=increase,` +
      `crop=${width}:${height},gblur=sigma=${blurSigma}[bgblur]`,
    // decrease=the whole frame fits; nothing is cropped away.
    `[fg]scale=${width}:${height}:force_original_aspect_ratio=decrease[fgfit]`,
    `[bgblur][fgfit]overlay=(W-w)/2:(H-h)/2`,
  ].join(';');
}

/**
 * The canvas a blurred-background composition is rendered onto.
 *
 * Follows this codebase's standing rule (services/media/reframe.ts): never
 * upscale. The canvas is as tall as the source and only as wide as 9:16 needs,
 * so every pixel in the output is a pixel the camera actually recorded. A
 * 1920x1080 source composes onto 608x1080, not 1080x1920 — the latter would
 * invent more than half its pixels and platforms accept the former.
 */
export function verticalCanvasFor(source: { width: number; height: number }, targetRatio = 9 / 16): {
  width: number;
  height: number;
} {
  // Floor, not round — the SAME rule as services/media/reframe.ts. Rounding
  // here would put a smart_crop at 606px and a blurred_background at 608px
  // for the identical source, two files nominally the same shape and neither
  // matching the other. The convention is one place's to own, and reframe.ts
  // already owns it.
  const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);
  const height = even(source.height);
  const width = even(height * targetRatio);
  // A source narrower than the target canvas cannot be widened without
  // inventing pixels, so the canvas shrinks to what exists.
  if (width > source.width) {
    const cappedWidth = even(source.width);
    return { width: cappedWidth, height: even(cappedWidth / targetRatio) };
  }
  return { width, height };
}
