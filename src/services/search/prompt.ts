import { formatTimecode } from '../timestamps.js';
import type { ResolvedSearchMode } from '../../domain/types.js';

/**
 * Prompt construction for the clip search.
 *
 * The instruction is entirely the user's: there are no predefined clip
 * categories anywhere in this file. The prompt only tells the model *how* to
 * report what it finds, never *what* to look for.
 */

export interface TranscriptLine {
  /** Seconds from the start of the chunk. */
  localStartSeconds: number;
  localEndSeconds: number;
  text: string;
}

export const SYSTEM_PROMPT = [
  'You are a video analysis engine that locates moments in a video segment.',
  'You are given a user instruction describing a moment they want to find, plus evidence from ONE segment of a longer video:',
  'sampled frames labelled with their timestamp, and/or a timestamped transcript of the speech in that segment.',
  '',
  'Rules:',
  '- Report ONLY moments that match the user instruction. Do not invent moments.',
  '- Timestamps are in SECONDS FROM THE START OF THIS SEGMENT, not from the start of the video.',
  '- A moment must have end_seconds greater than start_seconds.',
  '- Include the full moment: start slightly before it begins and end slightly after it resolves.',
  '- confidence is your certainty from 0 to 1.',
  '- Read any text visible in the frames (captions, scoreboards, chat, overlays, name tags) as evidence.',
  '- If the segment contains nothing matching the instruction, return an empty matches array. This is a normal and correct answer.',
  '',
  'Respond with ONLY a JSON object in exactly this shape, and no other text:',
  '{"matches":[{"start_seconds":12.5,"end_seconds":30.0,"description":"what happens","confidence":0.8}]}',
].join('\n');

export function buildInstructionBlock(input: {
  instruction: string;
  chunkDurationSeconds: number;
  chunkIndex: number;
  chunkCount: number;
  mode: ResolvedSearchMode;
}): string {
  const evidence =
    input.mode === 'transcript'
      ? 'You are given the transcript of this segment.'
      : input.mode === 'visual'
        ? 'You are given frames sampled from this segment.'
        : 'You are given frames sampled from this segment AND the transcript of its speech. Use both.';

  return [
    `USER INSTRUCTION: ${input.instruction}`,
    '',
    `This is segment ${input.chunkIndex + 1} of ${input.chunkCount} from a longer video.`,
    `The segment is ${input.chunkDurationSeconds.toFixed(1)} seconds long.`,
    `Valid timestamps for this segment are between 0 and ${input.chunkDurationSeconds.toFixed(1)} seconds.`,
    evidence,
    '',
    'Find every moment in this segment that matches the user instruction, and return the JSON object described above.',
  ].join('\n');
}

export function buildTranscriptBlock(lines: TranscriptLine[]): string {
  if (lines.length === 0) return 'TRANSCRIPT: (no speech detected in this segment)';

  const body = lines
    .map(
      (line) =>
        `[${line.localStartSeconds.toFixed(1)}s - ${line.localEndSeconds.toFixed(1)}s] ${line.text}`,
    )
    .join('\n');

  return `TRANSCRIPT (timestamps are seconds from the start of this segment):\n${body}`;
}

export function buildFrameLabel(localSeconds: number, index: number, total: number): string {
  return `Frame ${index + 1}/${total} at ${localSeconds.toFixed(1)}s (${formatTimecode(localSeconds)} into this segment):`;
}

/**
 * Index-backed search: one text-only request over the whole video.
 *
 * The evidence is what the model itself wrote down at ingest (the scene index)
 * plus the transcript, both on the video's global timeline. The instruction is
 * still entirely the user's — the index describes everything neutrally, and
 * matching happens here, at query time.
 */
export const INDEX_SEARCH_SYSTEM_PROMPT = [
  'You are a video search engine. You are given a user instruction describing a moment they want to find, plus two records of ONE video:',
  'a scene-by-scene visual index written while watching the video, and/or a timestamped transcript of its speech.',
  '',
  'Rules:',
  '- Report ONLY moments that match the user instruction. Do not invent moments.',
  '- Timestamps are in SECONDS FROM THE START OF THE VIDEO.',
  '- A moment must have end_seconds greater than start_seconds.',
  '- Include the full moment: start slightly before it begins and end slightly after it resolves.',
  '- confidence is your certainty from 0 to 1.',
  '- When a transcript line is the evidence, put the spoken words in "quote".',
  '- If nothing matches the instruction, return an empty matches array. This is a normal and correct answer.',
  '',
  'Respond with ONLY a JSON object in exactly this shape, and no other text:',
  '{"matches":[{"start_seconds":12.5,"end_seconds":30.0,"description":"what happens","confidence":0.8,"quote":"optional spoken words"}]}',
].join('\n');

export interface IndexedSceneLine {
  startSeconds: number;
  endSeconds: number;
  description: string;
}

export interface GlobalTranscriptLine {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export function buildIndexSearchUserMessage(input: {
  instruction: string;
  durationSeconds: number;
  scenes: IndexedSceneLine[];
  transcript: GlobalTranscriptLine[];
}): string {
  const sections: string[] = [
    `USER INSTRUCTION: ${input.instruction}`,
    '',
    `The video is ${input.durationSeconds.toFixed(1)} seconds long (${formatTimecode(input.durationSeconds)}).`,
    `Valid timestamps are between 0 and ${input.durationSeconds.toFixed(1)} seconds.`,
  ];

  if (input.scenes.length > 0) {
    const body = input.scenes
      .map((scene) => `[${scene.startSeconds.toFixed(1)}s - ${scene.endSeconds.toFixed(1)}s] ${scene.description}`)
      .join('\n');
    sections.push('', `VISUAL SCENE INDEX (timestamps are seconds from the start of the video):\n${body}`);
  }

  if (input.transcript.length > 0) {
    const body = input.transcript
      .map((line) => `[${line.startSeconds.toFixed(1)}s - ${line.endSeconds.toFixed(1)}s] ${line.text}`)
      .join('\n');
    sections.push('', `TRANSCRIPT (timestamps are seconds from the start of the video):\n${body}`);
  }

  sections.push('', 'Find every moment in the video that matches the user instruction, and return the JSON object described above.');
  return sections.join('\n');
}
