import { describe, expect, it } from 'vitest';
import { buildDrawtextFilter, captionsSchema } from '../src/services/media/captions.js';

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
  outline: true,
};

const context = { fontFile: '/fonts/LiberationSans-Bold.ttf', textFile: '/work/caption-0.txt', videoHeight: 1080 };

describe('buildDrawtextFilter', () => {
  it('sizes text against the real frame height', () => {
    const filter = buildDrawtextFilter(caption, context);
    // 6% of 1080 = 64.8 → 65px.
    expect(filter).toContain('fontsize=65');
  });

  it('references the text by file, never inline', () => {
    const filter = buildDrawtextFilter(caption, context);
    expect(filter).toContain("textfile='/work/caption-0.txt'");
    expect(filter).not.toContain('CROWD');
  });

  it('passes colour as hex ffmpeg understands', () => {
    expect(buildDrawtextFilter(caption, context)).toContain('fontcolor=0xfcd34d');
  });

  it('centres horizontally and clamps the vertical position to the frame', () => {
    const filter = buildDrawtextFilter(caption, context);
    expect(filter).toContain('x=(w-text_w)/2');
    expect(filter).toContain('h*0.8500');
    expect(filter).toContain('min(');
    expect(filter).toContain('max(');
  });

  it('adds a dark outline scaled to the text, and omits it when off', () => {
    expect(buildDrawtextFilter(caption, context)).toContain('borderw=5');
    expect(buildDrawtextFilter({ ...caption, outline: false }, context)).not.toContain('borderw');
  });

  it('never lets tiny frames produce unreadable text', () => {
    const filter = buildDrawtextFilter({ ...caption, sizePct: 2 }, { ...context, videoHeight: 144 });
    expect(filter).toContain('fontsize=8');
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
