import { z } from 'zod';

/**
 * Parsing and validation of untrusted video-model output.
 *
 * Model output is untrusted input. It arrives as free text that is *supposed*
 * to be JSON, and in practice can be wrapped in prose, fenced in markdown,
 * truncated, or shaped slightly differently from the contract. Nothing reaches
 * the database without passing through here.
 */

const numberish = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(parsed)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a finite number' });
    return z.NEVER;
  }
  return parsed;
});

const rawMatchSchema = z
  .object({
    start_seconds: numberish,
    end_seconds: numberish,
    description: z.string().optional().default(''),
    confidence: numberish.optional().default(0.5),
    quote: z.string().optional(),
  })
  .passthrough();

const rawResponseSchema = z.object({
  matches: z.array(z.unknown()).nullish(),
});

export interface ParsedMatch {
  startSeconds: number;
  endSeconds: number;
  description: string;
  confidence: number;
  quote: string | null;
}

export interface ParseResult {
  matches: ParsedMatch[];
  /** Non-fatal problems, surfaced in logs to make bad prompting visible. */
  warnings: string[];
}

/** Pulls the first balanced JSON object out of a possibly chatty response. */
export function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const withoutFences = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  const candidates = [trimmed, withoutFences];
  for (const candidate of candidates) {
    if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate;
  }

  const source = withoutFences;
  const start = source.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;

    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  return null;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  // Some models answer on a 0-100 scale.
  const normalized = value > 1 && value <= 100 ? value / 100 : value;
  return Math.min(1, Math.max(0, Number(normalized.toFixed(4))));
}

/**
 * Turns raw model text into validated matches. Never throws: a response that
 * cannot be understood yields zero matches plus warnings, which is the same
 * outcome as "this chunk contains nothing" and keeps one bad chunk from
 * failing a search.
 */
export function parseModelMatches(rawText: string): ParseResult {
  const warnings: string[] = [];

  const json = extractJsonObject(rawText ?? '');
  if (!json) {
    // "no matches" is a legitimate, common answer in plain prose.
    if (/\bno\b.*\b(match|moment|instance|occurrence)/i.test(rawText ?? '')) {
      return { matches: [], warnings: ['model answered in prose with no matches'] };
    }
    return { matches: [], warnings: ['response contained no JSON object'] };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    return { matches: [], warnings: ['response JSON failed to parse'] };
  }

  const envelope = rawResponseSchema.safeParse(parsedJson);
  if (!envelope.success) {
    return { matches: [], warnings: ['response did not contain a "matches" array'] };
  }

  // A response without the key at all still means "nothing found", but it is
  // worth surfacing: it usually indicates the prompt contract was ignored.
  if (envelope.data.matches === undefined || envelope.data.matches === null) {
    const absent = typeof parsedJson === 'object' && parsedJson !== null && !('matches' in parsedJson);
    return { matches: [], warnings: absent ? ['response did not contain a "matches" array'] : [] };
  }

  const matches: ParsedMatch[] = [];

  for (const [index, rawMatch] of (envelope.data.matches ?? []).entries()) {
    const parsed = rawMatchSchema.safeParse(rawMatch);
    if (!parsed.success) {
      warnings.push(`match ${index} rejected: ${parsed.error.issues.map((issue) => issue.message).join(', ')}`);
      continue;
    }

    const { start_seconds: start, end_seconds: end, description, confidence, quote } = parsed.data;

    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      warnings.push(`match ${index} rejected: non-finite timestamps`);
      continue;
    }

    matches.push({
      startSeconds: start,
      endSeconds: end,
      description: description.trim().slice(0, 500),
      confidence: clampConfidence(confidence),
      quote: quote?.trim().slice(0, 1000) || null,
    });
  }

  return { matches, warnings };
}

/**
 * One pair of refined boundaries, validated with the same distrust as every
 * other model answer. `null` means the answer was unusable — the caller
 * treats that as a failed Re-clip, never as "no change".
 */
export function parseReclipBoundaries(
  rawText: string,
  segmentDurationSeconds: number,
): { startSeconds: number; endSeconds: number } | null {
  const json = extractJsonObject(rawText);
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const start = Number((parsed as Record<string, unknown>).start_seconds);
  const end = Number((parsed as Record<string, unknown>).end_seconds);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  // Clamp into the segment rather than reject: a model answering 0.0 or a
  // hair past the end is giving a usable boundary sloppily, and the clamp is
  // exactly what a human editor would do with it.
  const clampedStart = Math.min(Math.max(start, 0), segmentDurationSeconds);
  const clampedEnd = Math.min(Math.max(end, 0), segmentDurationSeconds);
  if (clampedEnd <= clampedStart) return null;

  return {
    startSeconds: Number(clampedStart.toFixed(3)),
    endSeconds: Number(clampedEnd.toFixed(3)),
  };
}
