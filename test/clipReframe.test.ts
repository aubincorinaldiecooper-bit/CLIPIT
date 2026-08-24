import { describe, expect, it } from 'vitest';
import { clipFormatSchema, planReframe } from '../src/services/media/reframe.js';

/**
 * Reframing decides which pixels of a source survive into a post. The tests
 * care that the window is the largest the source allows, that it never
 * leaves the frame however it is aimed, that every dimension an encoder
 * receives is even, and — most of all — that a clip nobody reframed is left
 * exactly as it was shot.
 */

const landscape = { width: 1920, height: 1080 };
const portrait = { width: 1080, height: 1920 };

describe('planReframe', () => {
  it('leaves a clip nobody reframed exactly as it was shot', () => {
    expect(planReframe(undefined, landscape).filter).toBeNull();
    expect(planReframe(null, landscape).filter).toBeNull();
    expect(planReframe({ aspect: 'source', focusPct: 20 }, landscape).filter).toBeNull();
  });

  it('does not cut a source that is already the right shape', () => {
    // A pointless crop would re-encode every pixel to no purpose.
    expect(planReframe({ aspect: '16:9', focusPct: 50 }, landscape).filter).toBeNull();
    expect(planReframe({ aspect: '9:16', focusPct: 50 }, portrait).filter).toBeNull();
  });

  it('keeps the full height when narrowing a landscape frame to 9:16', () => {
    const plan = planReframe({ aspect: '9:16', focusPct: 50 }, landscape);
    // 1080 * 9/16 = 607.5 → 606 (even, and never rounded up past the source).
    expect(plan.outputWidth).toBe(606);
    expect(plan.outputHeight).toBe(1080);
    expect(plan.filter).toBe('crop=606:1080:657:0');
  });

  it('keeps the full width when shortening a portrait frame to 16:9', () => {
    const plan = planReframe({ aspect: '16:9', focusPct: 50 }, portrait);
    expect(plan.outputWidth).toBe(1080);
    expect(plan.outputHeight).toBe(606);
    expect(plan.filter).toBe('crop=1080:606:0:657');
  });

  it('slides the window to what the user pointed at', () => {
    const left = planReframe({ aspect: '9:16', focusPct: 10 }, landscape);
    const right = planReframe({ aspect: '9:16', focusPct: 90 }, landscape);
    // Both clamp inside the frame; left sits at the edge, right at the far one.
    expect(left.filter).toBe('crop=606:1080:0:0');
    expect(right.filter).toBe(`crop=606:1080:${1920 - 606}:0`);
  });

  it('never lets the window leave the frame, however it is aimed', () => {
    for (const focusPct of [0, 1, 33, 50, 67, 99, 100]) {
      const plan = planReframe({ aspect: '1:1', focusPct }, landscape);
      const [, , x] = plan.filter!.replace('crop=', '').split(':').map(Number);
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + plan.outputWidth).toBeLessThanOrEqual(landscape.width);
    }
  });

  it('only ever hands an encoder even dimensions', () => {
    // H.264 chroma subsampling cannot encode an odd width or height.
    const odd = { width: 1919, height: 1079 };
    for (const aspect of ['9:16', '1:1', '4:5', '16:9'] as const) {
      const plan = planReframe({ aspect, focusPct: 37 }, odd);
      expect(plan.outputWidth % 2).toBe(0)
      expect(plan.outputHeight % 2).toBe(0)
    }
  });

  it('crops 4:5 — the tallest shape a feed post allows', () => {
    const plan = planReframe({ aspect: '4:5', focusPct: 50 }, landscape);
    expect(plan.outputHeight).toBe(1080);
    expect(plan.outputWidth).toBe(864);
  });

  it('survives a source whose probe knew nothing', () => {
    const plan = planReframe({ aspect: '9:16', focusPct: 50 }, { width: 0, height: 0 });
    expect(plan.filter).toBeNull();
  });
});

describe('clipFormatSchema', () => {
  it('defaults to the source shape, centred', () => {
    const parsed = clipFormatSchema.parse({});
    expect(parsed.aspect).toBe('source');
    expect(parsed.focusPct).toBe(50);
  });

  it('refuses a shape it cannot cut and a focus off the frame', () => {
    expect(clipFormatSchema.safeParse({ aspect: '21:9' }).success).toBe(false);
    expect(clipFormatSchema.safeParse({ aspect: '9:16', focusPct: 140 }).success).toBe(false);
    expect(clipFormatSchema.safeParse({ aspect: '9:16', focusPct: -1 }).success).toBe(false);
  });
});
