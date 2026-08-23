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
 * One drawtext filter per caption, sizes computed against the real frame
 * height so the burn matches the preview.
 *
 * The text itself goes through a textfile, never inline: drawtext's inline
 * escaping rules (colons, quotes, percent signs) are exactly the kind of
 * thing user text exists to trip over, and a file sidesteps all of it.
 */
export function buildDrawtextFilter(
  caption: ClipCaption,
  context: { fontFile: string; textFile: string; videoHeight: number },
): string {
  const fontSize = Math.max(8, Math.round((context.videoHeight * caption.sizePct) / 100));
  const color = `0x${caption.color.slice(1)}`;
  const parts = [
    `fontfile='${context.fontFile}'`,
    `textfile='${context.textFile}'`,
    `fontsize=${fontSize}`,
    `fontcolor=${color}`,
    // Centred horizontally; vertical centre at yPct, clamped so text never
    // leaves the frame.
    `x=(w-text_w)/2`,
    `y=min(max(h*${(caption.yPct / 100).toFixed(4)}-text_h/2\\,h*0.01)\\,h-text_h-h*0.01)`,
  ];
  if (caption.outline) {
    parts.push(`borderw=${Math.max(1, Math.round(fontSize / 14))}`, `bordercolor=black@0.85`);
  }
  return `drawtext=${parts.join(':')}`;
}

/**
 * Write each caption's text to its own file in the work directory and return
 * the full filter list, in spec order (later captions draw over earlier).
 */
export async function prepareCaptionFilters(
  captions: ClipCaption[],
  workDir: string,
  videoHeight: number,
): Promise<string[]> {
  const filters: string[] = [];
  for (const [index, caption] of captions.entries()) {
    const textFile = path.join(workDir, `caption-${index}.txt`);
    await writeFile(textFile, caption.text, 'utf8');
    const fontFile = await resolveFontFile(caption.font);
    filters.push(buildDrawtextFilter(caption, { fontFile, textFile, videoHeight }));
  }
  return filters;
}
