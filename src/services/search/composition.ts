import { z } from 'zod';
import { logger } from '../../lib/logger.js';
import type { CompositionMode } from '../media/composition.js';

/**
 * Asking MiniCPM the only question FFmpeg cannot answer: what has to stay
 * visible for this moment to still make sense?
 *
 * Deliberately NOT "where is the face". A face detector would centre a
 * presenter and cut away the product they are holding, keep one podcast guest
 * and delete the person they are talking to, and crop a screen recording down
 * to a third of the text. The model already understands the moment; this asks
 * it to judge the framing, which is a question about MEANING and belongs
 * nowhere near a bounding box.
 *
 * The model may only decide two things: whether a 9:16 crop is safe, and where
 * the visual centre of gravity is. Everything downstream of that is arithmetic.
 *
 * This is a classification call, not a description call: one short JSON object,
 * a small token budget, and one targeted look at the selected moment. It must
 * never become a second full read of the source.
 */

export const COMPOSITION_SYSTEM_PROMPT = `You judge how a video moment should be framed for vertical short-form publishing.

Answer with JSON only. No prose, no markdown, no code fences.`;

export const COMPOSITION_INSTRUCTION = `Determine the best vertical presentation for this selected video moment.

The final output will be 9:16 for short-form publishing.

Identify whether the important visual content can safely fit inside a stable 9:16 crop.

Return smart_crop only if cropping to 9:16 will preserve the important subject, objects, context, and meaning of the moment.

If the important visual content is spread too widely, multiple subjects matter, important text/UI would be lost, or a stable crop is unsafe, return blurred_background.

If smart_crop is safe, return a normalized focal_x and focal_y between 0 and 1 describing the visual point that should remain near the center of the crop.

Return JSON only:
{"composition_mode":"smart_crop","crop_safe":true,"focal_x":0.5,"focal_y":0.45}
or
{"composition_mode":"blurred_background","crop_safe":false}`;

/**
 * What a valid answer looks like. Anything that fails this becomes
 * blurred_background — see decideFromResponse.
 */
const compositionSchema = z.object({
  composition_mode: z.enum(['smart_crop', 'blurred_background']),
  crop_safe: z.boolean(),
  focal_x: z.number().optional(),
  focal_y: z.number().optional(),
  /** Diagnostics only. Never shown to anyone using the app. */
  reason: z.string().max(300).optional(),
});

export interface CompositionDecision {
  mode: CompositionMode;
  /** Present only for smart_crop; normalized 0..1 against the source frame. */
  focalX: number | null;
  focalY: number | null;
  /** Why this decision was reached, for logs. Never returned to a client. */
  reason: string | null;
  /** True when the model was not usable and the safe default was taken. */
  fellBack: boolean;
}

/** The safe answer. Preserves the entire source frame, always. */
export const SAFE_COMPOSITION: CompositionDecision = {
  mode: 'blurred_background',
  focalX: null,
  focalY: null,
  reason: null,
  fellBack: true,
};

/**
 * Model output is untrusted input (CLAUDE.md), and this one governs whether a
 * person's footage gets cut in half. Every failure lands on the same side:
 * blurred_background keeps the whole frame, so a wrong parse costs a less
 * pretty clip, never lost content.
 *
 * Refused, deliberately:
 *  - anything that is not a JSON object of the expected shape;
 *  - smart_crop without both coordinates — "crop here" with no "here";
 *  - coordinates outside 0..1, which mean the model was working in pixels or
 *    guessing, and would slide the window to an edge;
 *  - smart_crop with crop_safe false, which is the model contradicting itself.
 */
export function decideFromResponse(raw: string | null | undefined): CompositionDecision {
  if (typeof raw !== 'string' || raw.trim() === '') return SAFE_COMPOSITION;

  // Models wrap JSON in fences and prose even when told not to. Take the
  // outermost object and let the schema reject anything that is not one.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return SAFE_COMPOSITION;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return SAFE_COMPOSITION;
  }

  const result = compositionSchema.safeParse(parsed);
  if (!result.success) return SAFE_COMPOSITION;
  const value = result.data;

  if (value.composition_mode === 'blurred_background' || value.crop_safe === false) {
    return {
      mode: 'blurred_background',
      focalX: null,
      focalY: null,
      reason: value.reason ?? null,
      // Not a fallback: this is the model deciding, which is the system
      // working. The distinction matters for reading the logs later.
      fellBack: false,
    };
  }

  const { focal_x: focalX, focal_y: focalY } = value;
  const usable =
    typeof focalX === 'number' &&
    typeof focalY === 'number' &&
    Number.isFinite(focalX) &&
    Number.isFinite(focalY) &&
    focalX >= 0 &&
    focalX <= 1 &&
    focalY >= 0 &&
    focalY <= 1;

  if (!usable) return SAFE_COMPOSITION;

  return {
    mode: 'smart_crop',
    focalX: Number(focalX.toFixed(4)),
    focalY: Number(focalY.toFixed(4)),
    reason: value.reason ?? null,
    fellBack: false,
  };
}

/** Log the decision without ever leaking the model's prose to a client. */
export function logComposition(fields: Record<string, unknown>): void {
  logger.info('composition decided', fields);
}
