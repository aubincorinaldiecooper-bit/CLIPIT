import { access } from 'node:fs/promises';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';

/**
 * Clip captions: the spec the editor writes and the drawtext filters the
 * renderer burns in.
 *
 * The spec is deliberately small and bounded — text, one of four faces, a
 * size and vertical position as percentages of the frame, a colour from a
 * validated hex, an outline toggle. Percentages rather than pixels because
 * the same spec must mean the same thing on the editor's preview and on the
 * rendered file, whatever the source resolution.
 */

export const captionSchema = z.object({
  text: z.string().trim().min(1).max(200),
  font: z.enum(['sans', 'serif', 'mono', 'bold']),
  /** Text height as % of the video's height. */
  sizePct: z.number().min(2).max(15),
  /** #rrggbb. Validated here; passed to ffmpeg as 0xRRGGBB. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  /** Vertical centre of the text as % of the video's height. */
  yPct: z.number().min(2).max(98),
  /**
   * Horizontal centre of the text as % of the video's width.
   *
   * Defaults to the middle, which is where every caption sat before the
   * editor let people drag text sideways — so specs written by the old
   * editor, and every row already in clips.captions, render exactly as they
   * did. The renderer proves this: at 50 the clamped expression reduces to
   * the old (w-text_w)/2.
   */
  xPct: z.number().min(2).max(98).default(50),
  /** A dark outline keeps light text readable over light footage. */
  outline: z.boolean().default(true),
});

export type ClipCaption = z.infer<typeof captionSchema>;

export const captionsSchema = z.array(captionSchema).max(6);

/**
 * The four faces, mapped to fonts the image installs (Dockerfile:
 * fonts-liberation, fonts-dejavu-core). Liberation is metrically Arial/Times
 * -compatible, so the browser preview's stand-ins are honest.
 */
const FONT_FILES: Record<ClipCaption['font'], { primary: string; fallback: string }> = {
  sans: {
    primary: '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
    fallback: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  },
  bold: {
    primary: '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    fallback: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  },
  serif: {
    primary: '/usr/share/fonts/truetype/liberation/LiberationSerif-Regular.ttf',
    fallback: '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf',
  },
  mono: {
    primary: '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf',
    fallback: '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
  },
};

async function resolveFontFile(font: ClipCaption['font']): Promise<string> {
  const { primary, fallback } = FONT_FILES[font];
  try {
    await access(primary);
    return primary;
  } catch {
    // Refusing to render over a missing file beats rendering the wrong face
    // silently — but DejaVu ships in the same image, so this is a real
    // fallback, not a guess.
    await access(fallback);
    return fallback;
  }
}

/**
 * Average glyph width as a fraction of the font size, per face. Rough on
 * purpose: it only has to keep lines comfortably inside the frame, and the
 * SAME numbers drive the editor's preview wrapping (see the frontend's
 * lib/captions.ts mirror), so both sides break lines in the same places.
 */
const CHAR_WIDTH_FACTOR: Record<ClipCaption['font'], number> = {
  sans: 0.5,
  bold: 0.53,
  serif: 0.5,
  mono: 0.6,
};

/** How much of the frame's width a caption line may use at most. */
const USABLE_WIDTH_FRACTION = 0.92;

/** The margin the renderer's clamp keeps between text and the frame edge. */
const EDGE_MARGIN_FRACTION = 0.01;

/**
 * How wide a caption block centred at xPct can be before the renderer's
 * clamp would start sliding it back toward the middle. Text dragged to the
 * left edge has less room than text in the centre, and wrapping has to know
 * that — otherwise the editor shows a line the renderer would move.
 */
export function usableWidthFraction(xPct: number): number {
  const x = xPct / 100;
  const room = 2 * Math.min(x - EDGE_MARGIN_FRACTION, 1 - EDGE_MARGIN_FRACTION - x);
  return Math.max(0, Math.min(USABLE_WIDTH_FRACTION, room));
}

/**
 * How many characters fit on one line, from the frame's shape and where the
 * text sits — resolution-independent, so the preview (which knows only the
 * aspect ratio) computes the identical number.
 */
export function maxCharsPerLine(
  font: ClipCaption['font'],
  sizePct: number,
  aspectRatio: number,
  xPct = 50,
): number {
  return Math.max(
    4,
    Math.floor((usableWidthFraction(xPct) * aspectRatio * 100) / (CHAR_WIDTH_FACTOR[font] * sizePct)),
  );
}

/**
 * Greedy word wrap; a single word longer than a line is broken hard rather
 * than allowed to run off the frame. Pure and shared in spirit with the
 * frontend mirror: what the editor shows as lines is exactly what is burned.
 */
export function wrapCaptionText(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const rawLine of text.split('\n')) {
    const words = rawLine.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0) continue;
    let current = '';
    for (let word of words) {
      while (word.length > maxChars) {
        if (current) {
          lines.push(current);
          current = '';
        }
        lines.push(word.slice(0, maxChars));
        word = word.slice(maxChars);
      }
      if (!current) current = word;
      else if (current.length + 1 + word.length <= maxChars) current = `${current} ${word}`;
      else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines.length > 0 ? lines : [text.trim() || ' '];
}

/**
 * One drawtext filter per LINE, sizes computed against the real frame.
 *
 * Per-line filters rather than one multi-line drawtext because drawtext
 * left-aligns lines inside its own text box; a filter per line, each with
 * x=(w-text_w)/2, is what actually centres every line — and it is exactly
 * how the preview lays lines out, so the two agree.
 *
 * The text itself travels via textfile, and expansion is switched OFF:
 * drawtext's default "normal" expansion runs %{...} functions found in the
 * text — even text loaded from a textfile — so a stray percent sign would
 * silently swallow a caption, and %{gmtime} would stamp the server's clock
 * into a user's video. With expansion=none the file's bytes are drawn
 * literally, which is the only honest reading of "caption text".
 */
export function buildDrawtextFilter(
  line: string,
  caption: ClipCaption,
  context: {
    fontFile: string;
    textFile: string;
    videoHeight: number;
    /** This line's offset from the caption block's centre, in lines. */
    lineOffset: number;
  },
): string {
  const fontSize = Math.max(8, Math.round((context.videoHeight * caption.sizePct) / 100));
  // A row stored before horizontal placement existed carries no xPct. The
  // schema defaults it, and every path into here parses first — but a number
  // that arrives missing would build "w*NaN", which ffmpeg accepts as a
  // filter and draws nowhere. The centre is the honest fallback.
  const xPct = Number.isFinite(caption.xPct) ? caption.xPct : 50;
  const lineHeight = Math.round(fontSize * 1.15);
  const offsetPx = Math.round(context.lineOffset * lineHeight);
  const color = `0x${caption.color.slice(1)}`;
  const offset = offsetPx === 0 ? '' : offsetPx > 0 ? `+${offsetPx}` : `${offsetPx}`;
  const parts = [
    `fontfile='${context.fontFile}'`,
    `textfile='${context.textFile}'`,
    `expansion=none`,
    `fontsize=${fontSize}`,
    `fontcolor=${color}`,
    // The block's centre sits at (xPct, yPct); this line is shifted by its
    // own offset, and both axes are clamped so no line ever leaves the
    // frame. Every line of one caption centres on the SAME x, which is what
    // keeps a wrapped block centred on itself wherever it was dragged.
    `x=min(max(w*${(xPct / 100).toFixed(4)}-text_w/2\\,w*0.01)\\,w-text_w-w*0.01)`,
    `y=min(max(h*${(caption.yPct / 100).toFixed(4)}${offset}-text_h/2\\,h*0.01)\\,h-text_h-h*0.01)`,
  ];
  if (caption.outline) {
    parts.push(`borderw=${Math.max(1, Math.round(fontSize / 14))}`, `bordercolor=black@0.85`);
  }
  return `drawtext=${parts.join(':')}`;
}

/**
 * Lay out and write every caption: wrapped into lines that fit the frame's
 * width, one textfile and one filter per line, in spec order (later captions
 * draw over earlier).
 */
export async function prepareCaptionFilters(
  captions: ClipCaption[],
  workDir: string,
  dimensions: { videoWidth: number; videoHeight: number },
): Promise<string[]> {
  const aspectRatio = dimensions.videoWidth / Math.max(1, dimensions.videoHeight);
  const filters: string[] = [];
  for (const [index, caption] of captions.entries()) {
    const fontFile = await resolveFontFile(caption.font);
    const lines = wrapCaptionText(
      caption.text,
      maxCharsPerLine(caption.font, caption.sizePct, aspectRatio, caption.xPct),
    );
    for (const [lineIndex, line] of lines.entries()) {
      const textFile = path.join(workDir, `caption-${index}-${lineIndex}.txt`);
      await writeFile(textFile, line, 'utf8');
      filters.push(
        buildDrawtextFilter(line, caption, {
          fontFile,
          textFile,
          videoHeight: dimensions.videoHeight,
          lineOffset: lineIndex - (lines.length - 1) / 2,
        }),
      );
    }
  }
  return filters;
}
