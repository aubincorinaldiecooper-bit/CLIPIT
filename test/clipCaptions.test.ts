import { describe, expect, it } from 'vitest';
import {
  buildDrawtextFilter,
  captionsSchema,
  maxCharsPerLine,
  usableWidthFraction,
  wrapCaptionText,
} from '../src/services/media/captions.js';

/**
 * The caption spec is the one place user-typed content approaches a shell
 * command, so the tests care about two things: the spec cannot smuggle
 * anything past validation, and the filter that reaches ffmpeg is built from
 * numbers we computed, never strings the user controls. Text itself never
 * appears in the filter — it travels via textfile.
 */

const caption = {
  text: 'CROWD GOES WILD',
  font: 'bold' as const,
  sizePct: 6,
  color: '#fcd34d',
  yPct: 85,
  xPct: 50,
  widthPct: 92,
  outline: true,
};

const context = {
  fontFile: '/fonts/LiberationSans-Bold.ttf',
  textFile: '/work/caption-0-0.txt',
  videoHeight: 1080,
  lineOffset: 0,
};

describe('buildDrawtextFilter', () => {
  it('sizes text against the real frame height', () => {
    const filter = buildDrawtextFilter(caption.text, caption, context);
    // 6% of 1080 = 64.8 → 65px.
    expect(filter).toContain('fontsize=65');
  });

  it('references the text by file, never inline', () => {
    const filter = buildDrawtextFilter(caption.text, caption, context);
    expect(filter).toContain("textfile='/work/caption-0-0.txt'");
    expect(filter).not.toContain('CROWD');
  });

  it('switches drawtext expansion OFF so user text is drawn literally', () => {
    // Without this, %{gmtime} in a caption stamps the server clock into the
    // video and a stray % silently swallows the caption.
    expect(buildDrawtextFilter(caption.text, caption, context)).toContain('expansion=none');
  });

  it('passes colour as hex ffmpeg understands', () => {
    expect(buildDrawtextFilter(caption.text, caption, context)).toContain('fontcolor=0xfcd34d');
  });

  it('places the block where it was dragged and clamps both axes to the frame', () => {
    const filter = buildDrawtextFilter(caption.text, caption, context);
    // Horizontal centre at xPct, vertical centre at yPct, each clamped so no
    // line can leave the frame.
    expect(filter).toContain('x=min(max(w*0.5000-text_w/2\\,w*0.01)\\,w-text_w-w*0.01)');
    expect(filter).toContain('h*0.8500');
    expect(filter).toContain('min(');
    expect(filter).toContain('max(');
  });

  it('honours a caption dragged off the centre line', () => {
    const filter = buildDrawtextFilter(caption.text, { ...caption, xPct: 22 }, context);
    expect(filter).toContain('w*0.2200-text_w/2');
  });

  it('draws at the centre rather than nowhere when xPct is missing entirely', () => {
    // Not reachable through the API (everything is parsed first), but a
    // "w*NaN" expression is a filter ffmpeg accepts and draws nothing from,
    // which would look like a caption that silently vanished.
    const { xPct: _dropped, ...withoutX } = caption;
    const filter = buildDrawtextFilter(caption.text, withoutX as typeof caption, context);
    expect(filter).toContain('w*0.5000-text_w/2');
    expect(filter).not.toContain('NaN');
  });

  it('still centres text whose spec predates horizontal placement', () => {
    // Rows written before the editor could drag sideways carry no xPct; the
    // schema's default must land them exactly where they have always been.
    const legacy = captionsSchema.parse([
      { text: 'Hi', font: 'sans', sizePct: 5, color: '#ffffff', yPct: 50 },
    ])[0]!;
    expect(legacy.xPct).toBe(50);
    // At 50 the clamp reduces to the old (w-text_w)/2 for any text that fits
    // inside the margins: w*0.5-text_w/2 is exactly that expression.
    expect(buildDrawtextFilter('Hi', legacy, context)).toContain('w*0.5000-text_w/2');
  });

  it('shifts wrapped lines around the block centre', () => {
    // fontsize 65 → line height 75; half a line is 37.5px, and Math.round
    // rounds halves toward +∞, hence the asymmetric -37/+38.
    expect(buildDrawtextFilter('a', caption, { ...context, lineOffset: -0.5 })).toContain('h*0.8500-37');
    expect(buildDrawtextFilter('b', caption, { ...context, lineOffset: 0.5 })).toContain('h*0.8500+38');
  });

  it('adds a dark outline scaled to the text, and omits it when off', () => {
    expect(buildDrawtextFilter(caption.text, caption, context)).toContain('borderw=5');
    expect(buildDrawtextFilter(caption.text, { ...caption, outline: false }, context)).not.toContain('borderw');
  });

  it('never lets tiny frames produce unreadable text', () => {
    const filter = buildDrawtextFilter(caption.text, { ...caption, sizePct: 2 }, { ...context, videoHeight: 144 });
    expect(filter).toContain('fontsize=8');
  });
});

describe('caption line wrapping', () => {
  it('derives the same line budget from the frame shape alone', () => {
    // 16:9 bold at 6%: .92 * 1.7778 * 100 / (0.53 * 6) ≈ 51.
    expect(maxCharsPerLine('bold', 6, 16 / 9)).toBe(51);
    // Portrait frames fit far fewer characters.
    expect(maxCharsPerLine('bold', 6, 9 / 16)).toBeLessThan(20);
  });

  it('breaks lines on the text column the editor drew', () => {
    // Half the frame's width fits about half as many characters.
    const full = maxCharsPerLine('bold', 6, 16 / 9, 50, 92);
    const half = maxCharsPerLine('bold', 6, 16 / 9, 50, 46);
    expect(half).toBeLessThan(full);
    expect(half).toBeGreaterThan(full / 2 - 2);
  });

  it('keeps the same words on the same lines when text is scaled', () => {
    // A design tool grows the column and the type together; the line budget
    // is the ratio between them, so the breaks must not move.
    // Double both and the budget is identical, so the wrap is identical.
    expect(maxCharsPerLine('bold', 3, 16 / 9, 50, 30)).toBe(maxCharsPerLine('bold', 6, 16 / 9, 50, 60));
    expect(maxCharsPerLine('mono', 4, 4 / 5, 50, 24)).toBe(maxCharsPerLine('mono', 8, 4 / 5, 50, 48));

    // Scaling stops where the frame does: a column cannot grow past the room
    // it has, so the last part of a very large scale does re-wrap. Better
    // that than text the renderer would slide back into frame.
    expect(maxCharsPerLine('bold', 12, 16 / 9, 50, 200)).toBe(maxCharsPerLine('bold', 12, 16 / 9, 50, 92));
  });

  it('gives text near an edge the room it actually has', () => {
    // A block centred at 15% can only be 28% of the frame wide before the
    // renderer's clamp would drag it back toward the middle — so it wraps
    // sooner, and the preview never shows a line that would move.
    const centred = maxCharsPerLine('bold', 6, 16 / 9, 50);
    const nearEdge = maxCharsPerLine('bold', 6, 16 / 9, 15);
    expect(nearEdge).toBeLessThan(centred);
    expect(usableWidthFraction(15)).toBeCloseTo(0.28, 5);
    // Symmetric: the right edge is no different from the left.
    expect(maxCharsPerLine('bold', 6, 16 / 9, 85)).toBe(nearEdge);
    // The middle keeps the full budget it always had.
    expect(usableWidthFraction(50)).toBe(0.92);
  });

  it('wraps on word boundaries and never emits an overlong line', () => {
    const lines = wrapCaptionText('the quick brown fox jumps over the lazy dog', 15);
    expect(lines.every((line) => line.length <= 15)).toBe(true);
    expect(lines.join(' ')).toBe('the quick brown fox jumps over the lazy dog');
  });

  it('breaks a single word longer than the line rather than running off frame', () => {
    const lines = wrapCaptionText('Donaudampfschifffahrtsgesellschaft', 10);
    expect(lines.every((line) => line.length <= 10)).toBe(true);
    expect(lines.join('')).toBe('Donaudampfschifffahrtsgesellschaft');
  });

  it('never returns zero lines', () => {
    expect(wrapCaptionText('   ', 10).length).toBeGreaterThan(0);
  });
});

describe('captionsSchema', () => {
  it('accepts a sane spec and applies the outline default', () => {
    const parsed = captionsSchema.parse([{ text: 'Hi', font: 'sans', sizePct: 5, color: '#ffffff', yPct: 50 }]);
    expect(parsed[0]!.outline).toBe(true);
  });

  it('rejects colours that are not #rrggbb', () => {
    for (const color of ['white', '#fff', '#gggggg', 'red;rm -rf /', "0xffffff'"]) {
      expect(captionsSchema.safeParse([{ ...caption, color }]).success).toBe(false);
    }
  });

  it('rejects empty text, silly sizes, off-frame positions, unknown fonts', () => {
    expect(captionsSchema.safeParse([{ ...caption, text: '  ' }]).success).toBe(false);
    expect(captionsSchema.safeParse([{ ...caption, sizePct: 40 }]).success).toBe(false);
    expect(captionsSchema.safeParse([{ ...caption, yPct: 120 }]).success).toBe(false);
    expect(captionsSchema.safeParse([{ ...caption, font: 'comic-sans' }]).success).toBe(false);
  });

  it('bounds how many captions one clip can carry', () => {
    expect(captionsSchema.safeParse(Array.from({ length: 7 }, () => caption)).success).toBe(false);
  });
});
