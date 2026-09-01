import { z } from 'zod';
import { env } from '../../config/env.js';
import { parseModelJson, REPAIRED_JSON_WARNING } from './modelResponse.js';
import { askVideoModel, videoPartFromFile, type VideoUsageReporter } from './openrouterVideo.js';
import { buildIndexInstruction, INDEX_SYSTEM_PROMPT } from './prompt.js';

/**
 * Reading a chunk of video into notes.
 *
 * This is the same model and the same transport as the search, asked a
 * different question: not "where is X" but "what is here". It runs once per
 * chunk at upload, so a question asked later can be answered from text.
 */

export interface ParsedScene {
  /** Seconds from the start of the chunk. */
  startSeconds: number;
  endSeconds: number;
  description: string;
}

export interface DescribeResult {
  scenes: ParsedScene[];
  warnings: string[];
  rawResponse: string;
}

const numberish = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (!Number.isFinite(parsed)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'not a finite number' });
    return z.NEVER;
  }
  return parsed;
});

const rawSceneSchema = z
  .object({
    start_seconds: numberish,
    end_seconds: numberish,
    description: z.string(),
  })
  .passthrough();

const rawIndexSchema = z.object({ scenes: z.array(z.unknown()).nullish() });

/** Longest a single description is stored at; the column is TEXT, this is sanity. */
const MAX_DESCRIPTION_CHARS = 2000;

/**
 * Turns raw model text into scenes, discarding anything that cannot be trusted
 * as a position in this chunk.
 *
 * Like the match parser, this never throws — but unlike it, an unparseable
 * answer here is NOT equivalent to "nothing is in this segment". The caller
 * must treat zero scenes as a failed read of that chunk, or a video would be
 * recorded as containing nothing and every later question answered from that.
 */
export function parseModelScenes(rawText: string, chunkDurationSeconds: number): Omit<DescribeResult, 'rawResponse'> {
  const warnings: string[] = [];
  const result = parseModelJson(rawText ?? '');
  if (!result.ok) {
    return {
      scenes: [],
      warnings: [result.stage === 'extract' ? 'response contained no JSON object' : 'response JSON failed to parse'],
    };
  }
  // Recovered, not fine: the repair keeps the chunk's minutes of footage from
  // being recorded as unreadable, and this warning keeps the model's
  // misbehaviour from being recorded as health.
  if (result.repaired) warnings.push(REPAIRED_JSON_WARNING);
  const parsedJson: unknown = result.value;

  const envelope = rawIndexSchema.safeParse(parsedJson);
  // `scenes` is nullish in the schema so a null does not fail the whole parse
  // — which means an object without the key at all passes too. Left there,
  // valid JSON of the wrong shape would return zero scenes and no warning: a
  // stretch of video recorded as read and containing nothing.
  if (!envelope.success || envelope.data.scenes === undefined || envelope.data.scenes === null) {
    return { scenes: [], warnings: ['response did not contain a "scenes" array'] };
  }

  const scenes: ParsedScene[] = [];

  for (const [index, raw] of envelope.data.scenes.entries()) {
    const parsed = rawSceneSchema.safeParse(raw);
    if (!parsed.success) {
      warnings.push(`scene ${index} rejected: ${parsed.error.issues.map((issue) => issue.message).join(', ')}`);
      continue;
    }

    const description = parsed.data.description.trim().slice(0, MAX_DESCRIPTION_CHARS);
    if (!description) {
      warnings.push(`scene ${index} rejected: empty description`);
      continue;
    }

    // Clamped rather than dropped. A model that overshoots the end of a
    // segment by a second still saw something real there; throwing the scene
    // away would lose the only note covering that stretch.
    const start = Math.max(0, Math.min(parsed.data.start_seconds, chunkDurationSeconds));
    const end = Math.max(0, Math.min(parsed.data.end_seconds, chunkDurationSeconds));

    if (!(end > start)) {
      warnings.push(`scene ${index} rejected: end is not after start`);
      continue;
    }

    scenes.push({ startSeconds: start, endSeconds: end, description });
  }

  return { scenes, warnings };
}

export interface DescribeChunkInput {
  chunkIndex: number;
  chunkCount: number;
  chunkDurationSeconds: number;
  videoPath: string;
  /** Storage key of the same chunk, for providers that take a URL. */
  videoStorageKey?: string;
  onUsage?: VideoUsageReporter;
}

/** Reads one chunk of video into scenes. */
export async function describeVideoChunk(input: DescribeChunkInput): Promise<DescribeResult> {
  // Same rule as search: when the provider takes a URL, the local bytes are
  // not read at all.
  const carriedByUrl = env.VIDEO_PROVIDER === 'minicpm' && Boolean(input.videoStorageKey);
  const video = carriedByUrl ? null : await videoPartFromFile(input.videoPath);

  const answer = await askVideoModel({
    chunkIndex: input.chunkIndex,
    chunkDurationSeconds: input.chunkDurationSeconds,
    systemPrompt: INDEX_SYSTEM_PROMPT,
    parts: video
      ? [{ type: 'text', text: buildIndexInstruction(input) }, video.part]
      : [{ type: 'text', text: buildIndexInstruction(input) }],
    videoBytes: video?.bytes ?? 0,
    // Descriptions of everything in two minutes run far longer than a list of
    // matching moments, and an answer cut off mid-scene loses the tail of the
    // chunk — which is a hole in the notes nobody would ever see.
    answerMaxTokens: env.INDEX_ANSWER_MAX_TOKENS,
    purpose: 'index',
    ...(input.onUsage ? { onUsage: input.onUsage } : {}),
    ...(input.videoStorageKey ? { videoStorageKey: input.videoStorageKey } : {}),
  });

  return { ...parseModelScenes(answer.content, input.chunkDurationSeconds), rawResponse: answer.content };
}
