import { describe, expect, it } from 'vitest';
import {
  aspectRatioLabel,
  blurredBackgroundFilter,
  focusPctForCrop,
  cropMeetsQualityFloor,
  posterOffsetSeconds,
  verticalCanvasFor,
} from '../src/services/media/composition.js';
import { decideFromResponse, SAFE_COMPOSITION } from '../src/services/search/composition.js';
import { presentationTargetFor } from '../src/services/search/presentationTarget.js';
import { planReframe } from '../src/services/media/reframe.js';

/**
 * The division this whole feature rests on: MiniCPM decides what must stay
 * visible, FFmpeg decides how. These tests hold both halves — the arithmetic
 * exactly, and the model's answer only insofar as every bad answer lands on
 * the side that keeps the person's whole frame.
 */

describe('posterOffsetSeconds — a quarter in, never the edges', () => {
  it('takes a quarter of the way into an ordinary clip', () => {
    expect(posterOffsetSeconds(20)).toBe(5);
    expect(posterOffsetSeconds(32)).toBe(8);
  });

  it('never lands on frame zero, where cuts open on fades and title cards', () => {
    expect(posterOffsetSeconds(0.4)).toBeGreaterThan(0);
  });

  it('stays inside a very short clip rather than seeking past its end', () => {
    const duration = 0.6;
    const offset = posterOffsetSeconds(duration);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(duration);
  });

  it('refuses to invent an offset for a clip with no duration', () => {
    expect(posterOffsetSeconds(0)).toBe(0);
    expect(posterOffsetSeconds(Number.NaN)).toBe(0);
  });
});

describe('aspectRatioLabel — measured pixels only', () => {
  it('names the common shapes', () => {
    expect(aspectRatioLabel(1920, 1080)).toBe('16:9');
    expect(aspectRatioLabel(1080, 1920)).toBe('9:16');
    expect(aspectRatioLabel(1080, 1080)).toBe('1:1');
    expect(aspectRatioLabel(640, 480)).toBe('4:3');
  });

  it('snaps a real encode that is not arithmetically exact', () => {
    expect(aspectRatioLabel(1918, 1080)).toBe('16:9');
  });

  it('reduces an unusual shape honestly instead of forcing a familiar name', () => {
    expect(aspectRatioLabel(1000, 300)).toBe('10:3');
  });

  it('returns null rather than guessing when the probe knew nothing', () => {
    expect(aspectRatioLabel(0, 0)).toBeNull();
    expect(aspectRatioLabel(null, null)).toBeNull();
  });
});

describe('focusPctForCrop — the model travels along the axis being cut', () => {
  const landscape = { width: 1920, height: 1080 };
  const portrait = { width: 1080, height: 1920 };

  it('uses focal_x on a landscape source, where the width is what gets narrowed', () => {
    // focal_y is deliberately absurd: it must be ignored on this axis.
    expect(focusPctForCrop(0.25, 0.99, landscape, 9 / 16)).toBe(25);
  });

  it('uses focal_y on a portrait source, where the height is what gets shortened', () => {
    expect(focusPctForCrop(0.99, 0.25, portrait, 16 / 9)).toBe(25);
  });

  it('clamps a coordinate outside the frame instead of sliding off it', () => {
    expect(focusPctForCrop(-3, 0.5, landscape, 9 / 16)).toBe(0);
    expect(focusPctForCrop(9, 0.5, landscape, 9 / 16)).toBe(100);
  });
});

describe('verticalCanvasFor — never invent a pixel, and agree with reframe.ts', () => {
  it('produces exactly the width planReframe crops to, for the same source', () => {
    // The two must not disagree: one governs smart_crop, the other the
    // blurred-background canvas, and a person gets both from one video.
    const canvas = verticalCanvasFor({ width: 1920, height: 1080 });
    const plan = planReframe({ aspect: '9:16', focusPct: 50 }, { width: 1920, height: 1080 });
    expect(canvas).toEqual({ width: plan.outputWidth, height: plan.outputHeight });
  });

  it('keeps full source height and narrows the width for a 1080p landscape', () => {
    // 606x1080, not 1080x1920: upscaling would fabricate most of the frame.
    // 606 not 608 because reframe.ts floors to even, and the two must agree —
    // a smart_crop and a blurred_background of the same source have to come
    // out the same size.
    expect(verticalCanvasFor({ width: 1920, height: 1080 })).toEqual({ width: 606, height: 1080 });
  });

  it('produces an even-dimensioned canvas, which H.264 requires', () => {
    const canvas = verticalCanvasFor({ width: 1280, height: 719 });
    expect(canvas.width % 2).toBe(0);
    expect(canvas.height % 2).toBe(0);
  });

  it('shrinks rather than widening a source narrower than the canvas', () => {
    const canvas = verticalCanvasFor({ width: 300, height: 1080 });
    expect(canvas.width).toBeLessThanOrEqual(300);
  });
});

describe('blurredBackgroundFilter — a full frame over a filled canvas', () => {
  const filter = blurredBackgroundFilter({ width: 608, height: 1080 });

  it('covers and crops the background so no black bar can survive', () => {
    expect(filter).toContain('force_original_aspect_ratio=increase');
    expect(filter).toContain('crop=608:1080');
    expect(filter).toContain('gblur');
  });

  it('fits the foreground ENTIRELY inside the canvas — nothing cropped away', () => {
    // decrease is the whole point: the complete source frame survives.
    expect(filter).toContain('force_original_aspect_ratio=decrease');
  });

  it('centres the foreground over the background', () => {
    expect(filter).toContain('overlay=(W-w)/2:(H-h)/2');
  });
});

describe('decideFromResponse — every bad answer keeps the whole frame', () => {
  it('accepts a well-formed smart_crop with coordinates', () => {
    const decision = decideFromResponse('{"composition_mode":"smart_crop","crop_safe":true,"focal_x":0.48,"focal_y":0.44}');
    expect(decision).toMatchObject({ mode: 'smart_crop', focalX: 0.48, focalY: 0.44, fellBack: false });
  });

  it('reads through the fences and prose models add despite being told not to', () => {
    const decision = decideFromResponse('Sure!\n```json\n{"composition_mode":"smart_crop","crop_safe":true,"focal_x":0.5,"focal_y":0.5}\n```');
    expect(decision.mode).toBe('smart_crop');
  });

  it('honours the model choosing blurred_background — that is the system working, not a fallback', () => {
    const decision = decideFromResponse('{"composition_mode":"blurred_background","crop_safe":false,"reason":"two speakers on opposite sides"}');
    expect(decision.mode).toBe('blurred_background');
    expect(decision.fellBack).toBe(false);
    expect(decision.reason).toBe('two speakers on opposite sides');
  });

  it('refuses smart_crop with no focal point — "crop here" with no here', () => {
    expect(decideFromResponse('{"composition_mode":"smart_crop","crop_safe":true}')).toEqual(SAFE_COMPOSITION);
  });

  it('refuses coordinates outside the frame, which mean pixels or guesswork', () => {
    expect(decideFromResponse('{"composition_mode":"smart_crop","crop_safe":true,"focal_x":960,"focal_y":540}')).toEqual(SAFE_COMPOSITION);
    expect(decideFromResponse('{"composition_mode":"smart_crop","crop_safe":true,"focal_x":-0.2,"focal_y":0.5}')).toEqual(SAFE_COMPOSITION);
  });

  it('refuses a self-contradiction: smart_crop with crop_safe false', () => {
    expect(decideFromResponse('{"composition_mode":"smart_crop","crop_safe":false,"focal_x":0.5,"focal_y":0.5}').mode).toBe('blurred_background');
  });

  it('falls back on prose, on empty, and on nothing at all', () => {
    expect(decideFromResponse('The subject is on the left.')).toEqual(SAFE_COMPOSITION);
    expect(decideFromResponse('')).toEqual(SAFE_COMPOSITION);
    expect(decideFromResponse(null)).toEqual(SAFE_COMPOSITION);
    expect(decideFromResponse('{"composition_mode":"zoom_out"}')).toEqual(SAFE_COMPOSITION);
  });
});

describe('presentationTargetFor — what shape was actually asked for', () => {
  it('reads the platforms that mean vertical', () => {
    expect(presentationTargetFor('Find me 3 moments I can post on TikTok').target).toBe('vertical');
    expect(presentationTargetFor('clips for instagram reels').target).toBe('vertical');
    expect(presentationTargetFor('something for YouTube Shorts').target).toBe('vertical');
  });

  it('does not invent a vertical request from an ordinary question', () => {
    expect(presentationTargetFor('Find the part where they introduce themselves').target).toBe('source');
    expect(presentationTargetFor('').target).toBe('source');
  });

  it('lets an explicit keep-the-framing instruction beat a platform word', () => {
    // "post the original framing to TikTok" is a coherent thing to want.
    const intent = presentationTargetFor('post to tiktok but keep the original framing');
    expect(intent.target).toBe('source');
    expect(intent.matched).toBe('keep the original framing');
  });

  it("honours don't-crop phrasing", () => {
    expect(presentationTargetFor("tiktok clips but don't crop them").target).toBe('source');
  });
});

describe('planReframe still owns the crop arithmetic', () => {
  it('produces a true 9:16 window from a landscape source at the focal point', () => {
    const plan = planReframe({ aspect: '9:16', focusPct: 25 }, { width: 1920, height: 1080 });
    expect(plan.outputHeight).toBe(1080);
    expect(plan.outputWidth).toBe(606);
    // 606/1080 is 9:16 within flooring to even pixels.
    expect(Math.abs(plan.outputWidth / plan.outputHeight - 9 / 16)).toBeLessThan(0.01);
    expect(plan.filter).toContain('crop=');
  });

  it('never lets the window leave the frame at an extreme focal point', () => {
    const left = planReframe({ aspect: '9:16', focusPct: 0 }, { width: 1920, height: 1080 });
    const right = planReframe({ aspect: '9:16', focusPct: 100 }, { width: 1920, height: 1080 });
    expect(left.filter).toContain(':0:0');
    expect(right.filter).toContain(`:${1920 - 606}:0`);
  });
});

describe('VERTICAL_DELIVERY — the shape is a platform fact, not a model output', () => {
  it('is fixed at 1080x1920', async () => {
    const { VERTICAL_DELIVERY } = await import('../src/services/media/composition.js');
    expect(VERTICAL_DELIVERY).toEqual({ width: 1080, height: 1920 });
    expect(VERTICAL_DELIVERY.width / VERTICAL_DELIVERY.height).toBeCloseTo(9 / 16, 6);
  });

  it('is separate from the source crop: 1920x1080 still crops ~606x1080 of REAL pixels', () => {
    // The reversal is only about delivery. Source selection still never
    // upscales, so the crop is unchanged and the scale-up is honest about
    // adding no detail.
    const plan = planReframe({ aspect: '9:16', focusPct: 50 }, { width: 1920, height: 1080 });
    expect(plan.outputWidth).toBe(606);
    expect(plan.outputHeight).toBe(1080);
  });
});

describe('cropMeetsQualityFloor — semantically safe is not the same as sharp enough', () => {
  it('passes a full-HD landscape crop', () => {
    // 1920x1080 -> 606x1080 of real pixels, comfortably above the floor.
    expect(cropMeetsQualityFloor({ width: 606, height: 1080 }, 540)).toBe(true);
  });

  it('fails a 640x360 source, where the crop is ~202px and would be scaled fivefold', () => {
    expect(cropMeetsQualityFloor({ width: 202, height: 360 }, 540)).toBe(false);
  });

  it('is arithmetic, not vision — it never overrides WHY, only HOW sharp', () => {
    // Exactly at the floor passes; one pixel under does not.
    expect(cropMeetsQualityFloor({ width: 540, height: 960 }, 540)).toBe(true);
    expect(cropMeetsQualityFloor({ width: 539, height: 960 }, 540)).toBe(false);
  });

  it('refuses a degenerate crop outright', () => {
    expect(cropMeetsQualityFloor({ width: 0, height: 0 }, 540)).toBe(false);
    expect(cropMeetsQualityFloor({ width: Number.NaN, height: 1080 }, 540)).toBe(false);
  });
});
