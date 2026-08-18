import { z } from 'zod';
import { formatTimecode } from '../timestamps.js';
import { extractJsonObject } from './modelResponse.js';
import { frameToDataUrl, type ChatMessage, type ContentPart } from './minicpm.js';

/**
 * Match verification — the agentic step.
 *
 * The index search proposes moments from text written at ingest, which
 * carries the index's frame-sampling granularity. Before a moment is
 * reported, the frames actually on screen in its window are pulled and shown
 * to the model with one question: is the thing the user asked for really
 * here, and exactly when? A confirmed match gets its timestamps refined to
 * what the footage shows; an unconfirmed one loses most of its confidence.
 */

export const VERIFY_SYSTEM_PROMPT = [
  'You are verifying a claimed moment in a video. You are given the user instruction that produced the claim, and frames sampled from the claimed window, each labelled with its timestamp.',
  '',
  'Rules:',
  '- Decide from the frames alone whether the instruction is genuinely visible in this window. Do not give the claim the benefit of the doubt.',
  '- If it is there, report the tightest start_seconds and end_seconds that contain it, on the same clock as the frame labels.',
  '- end_seconds must be greater than start_seconds.',
  '- confidence is your certainty from 0 to 1.',
  '',
  'Respond with ONLY a JSON object in exactly this shape, and no other text:',
  '{"confirmed":true,"start_seconds":612.0,"end_seconds":631.5,"confidence":0.9}',
].join('\n');

export interface VerifyFrame {
  /** GLOBAL seconds — the video's own clock, matching the labels. */
  globalSeconds: number;
  filePath: string;
}

export async function buildVerifyMessages(input: {
  instruction: string;
  claimDescription: string;
  windowStartSeconds: number;
  windowEndSeconds: number;
  frames: VerifyFrame[];
}): Promise<ChatMessage[]> {
  const parts: ContentPart[] = [
    {
      type: 'text',
      text: [
        `USER INSTRUCTION: ${input.instruction}`,
        '',
        `CLAIM UNDER VERIFICATION: between ${input.windowStartSeconds.toFixed(1)}s and ${input.windowEndSeconds.toFixed(1)}s — "${input.claimDescription}"`,
        '',
        'The frames below are what is actually on screen in that window. Verify the claim and return the JSON object described above.',
      ].join('\n'),
    },
  ];

  for (const [index, frame] of input.frames.entries()) {
    parts.push({
      type: 'text',
      text: `Frame ${index + 1}/${input.frames.length} at ${frame.globalSeconds.toFixed(1)}s (${formatTimecode(frame.globalSeconds)}):`,
    });
    parts.push({ type: 'image_url', image_url: { url: await frameToDataUrl(frame.filePath) } });
  }

  return [
    { role: 'system', content: VERIFY_SYSTEM_PROMPT },
    { role: 'user', content: parts },
  ];
}

const numberish = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(parsed)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a finite number' });
    return z.NEVER;
  }
  return parsed;
});

const boolish = z.union([z.boolean(), z.string()]).transform((value) => {
  if (typeof value === 'boolean') return value;
  return ['true', 'yes', '1'].includes(value.trim().toLowerCase());
});

const rawVerdictSchema = z
  .object({
    confirmed: boolish,
    start_seconds: numberish.optional(),
    end_seconds: numberish.optional(),
    confidence: numberish.optional(),
  })
  .passthrough();

export interface Verdict {
  confirmed: boolean;
  startSeconds: number | null;
  endSeconds: number | null;
  confidence: number | null;
}

/**
 * Parses a verification reply. Never throws; an unreadable reply returns
 * null, and the caller keeps the unverified match rather than losing it to a
 * formatting failure.
 */
export function parseVerifyResponse(rawText: string): Verdict | null {
  const json = extractJsonObject(rawText ?? '');
  if (!json) return null;

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    return null;
  }

  const parsed = rawVerdictSchema.safeParse(parsedJson);
  if (!parsed.success) return null;

  const { confirmed, start_seconds: start, end_seconds: end, confidence } = parsed.data;
  const hasRange = start !== undefined && end !== undefined && end > start;

  return {
    confirmed,
    startSeconds: hasRange ? start : null,
    endSeconds: hasRange ? end : null,
    confidence: confidence !== undefined ? Math.min(1, Math.max(0, confidence > 1 && confidence <= 100 ? confidence / 100 : confidence)) : null,
  };
}
