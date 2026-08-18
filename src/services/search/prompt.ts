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
  'You are given a user instruction describing a moment they want to find, plus an actual MP4 segment of a longer video and, when available, its timestamped transcript.',
  '',
  'Rules:',
  '- Report ONLY moments that match the user instruction. Do not invent moments.',
  '- Timestamps are in SECONDS FROM THE START OF THIS SEGMENT, not from the start of the video.',
  '- A moment must have end_seconds greater than start_seconds.',
  '- Include the full moment: start slightly before it begins and end slightly after it resolves.',
  '- confidence is your certainty from 0 to 1.',
  '- Inspect the full video over time, including actions, objects, people, scene changes, and spatial relationships.',
  '- Read on-screen text (captions, signs, scoreboards, chat, overlays, and name tags) as evidence.',
  '- For mixed queries, require all requested visual, on-screen-text, and speech conditions to be satisfied.',
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
        ? 'You are given the actual MP4 video segment. Inspect it over time.'
        : 'You are given the actual MP4 video segment AND the transcript of its speech. Use both.';

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
