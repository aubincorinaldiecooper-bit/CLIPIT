import { z } from 'zod';
import { formatTimecode } from '../timestamps.js';
import { extractJsonObject } from './modelResponse.js';
import { buildFrameLabel } from './prompt.js';
import { frameToDataUrl, type ChatMessage, type ContentPart } from './minicpm.js';

/**
 * Ingest-time scene indexing.
 *
 * The model reads a batch of timestamped frames ONCE, at upload, and writes
 * down everything it sees as timestamped scene descriptions — the way an LLM
 * ingests a book before being asked about it. Descriptions are exhaustive and
 * neutral: no user instruction exists yet, so nothing here may filter or
 * interpret toward any particular kind of moment.
 */

export const SCENE_INDEX_SYSTEM_PROMPT = [
  'You are a video indexing engine. You are given frames sampled from ONE portion of a longer video, each labelled with its timestamp.',
  'Write a scene-by-scene account of everything that happens, so that ANY future question about this video can be answered from your descriptions alone.',
  '',
  'Rules:',
  '- Describe every distinct scene, action, or event; do not skip uneventful stretches — summarize them.',
  '- Be concrete: name visible people (or describe them), objects, settings, actions, and anything notable that appears or changes.',
  '- Transcribe on-screen text you can read: captions, titles, scoreboards, signs, chat messages, name tags.',
  '- Timestamps are in SECONDS, using the same clock as the frame labels.',
  '- A scene must have end_seconds greater than start_seconds, and scenes should cover the whole span of the frames you were given.',
  '- Do not invent anything that is not visible in the frames.',
  '',
  'Respond with ONLY a JSON object in exactly this shape, and no other text:',
  '{"scenes":[{"start_seconds":12.5,"end_seconds":30.0,"description":"what happens"}]}',
].join('\n');

export interface SceneIndexFrame {
  /** Seconds from the start of the CHUNK (the labels the model sees). */
  localSeconds: number;
  filePath: string;
}

export interface SceneIndexBatchInput {
  chunkIndex: number;
  chunkCount: number;
  frames: SceneIndexFrame[];
}

/** One model request describing one batch of frames from one chunk. */
export async function buildSceneIndexMessages(input: SceneIndexBatchInput): Promise<ChatMessage[]> {
  const first = input.frames[0]!.localSeconds;
  const last = input.frames.at(-1)!.localSeconds;

  const parts: ContentPart[] = [
    {
      type: 'text',
      text: [
        `These frames come from segment ${input.chunkIndex + 1} of ${input.chunkCount} of the video.`,
        `They span ${first.toFixed(1)}s (${formatTimecode(first)}) to ${last.toFixed(1)}s (${formatTimecode(last)}) of this segment.`,
        `Valid scene timestamps are between ${first.toFixed(1)} and ${last.toFixed(1)} seconds.`,
        '',
        'Describe every scene in this span, then return the JSON object described above.',
      ].join('\n'),
    },
  ];

  for (const [index, frame] of input.frames.entries()) {
    parts.push({ type: 'text', text: buildFrameLabel(frame.localSeconds, index, input.frames.length) });
    parts.push({ type: 'image_url', image_url: { url: await frameToDataUrl(frame.filePath) } });
  }

  return [
    { role: 'system', content: SCENE_INDEX_SYSTEM_PROMPT },
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

const rawSceneSchema = z
  .object({
    start_seconds: numberish,
    end_seconds: numberish,
    description: z.string().optional().default(''),
  })
  .passthrough();

const rawSceneResponseSchema = z.object({
  scenes: z.array(z.unknown()).nullish(),
});

export interface ParsedScene {
  startSeconds: number;
  endSeconds: number;
  description: string;
}

export interface SceneParseResult {
  scenes: ParsedScene[];
  warnings: string[];
}

/**
 * Turns raw model text into validated scenes. Never throws: like the match
 * parser, an unusable response yields zero scenes plus warnings, so one bad
 * batch degrades the index instead of failing the video.
 */
export function parseSceneResponse(rawText: string): SceneParseResult {
  const warnings: string[] = [];

  const json = extractJsonObject(rawText ?? '');
  if (!json) return { scenes: [], warnings: ['response contained no JSON object'] };

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(json);
  } catch {
    return { scenes: [], warnings: ['response JSON failed to parse'] };
  }

  const envelope = rawSceneResponseSchema.safeParse(parsedJson);
  if (!envelope.success || envelope.data.scenes === undefined || envelope.data.scenes === null) {
    return { scenes: [], warnings: ['response did not contain a "scenes" array'] };
  }

  const scenes: ParsedScene[] = [];

  for (const [index, rawScene] of envelope.data.scenes.entries()) {
    const parsed = rawSceneSchema.safeParse(rawScene);
    if (!parsed.success) {
      warnings.push(`scene ${index} rejected: ${parsed.error.issues.map((issue) => issue.message).join(', ')}`);
      continue;
    }

    const { start_seconds: start, end_seconds: end, description } = parsed.data;
    const text = description.trim();
    if (!text) {
      warnings.push(`scene ${index} rejected: empty description`);
      continue;
    }

    scenes.push({
      startSeconds: start,
      endSeconds: end,
      description: text.slice(0, 1000),
    });
  }

  return { scenes, warnings };
}
