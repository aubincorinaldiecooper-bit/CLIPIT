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
  '- Mark the exact matching moment: start when the requested event begins and end when it ends. Do not add lead-in, aftermath, or unrelated context.',
  '- confidence is your certainty from 0 to 1.',
  '- description is a terse label of at most 12 words, not a sentence or explanation.',
  '- Return only the JSON. Do not explain your reasoning, before or after it.',
  '- Inspect the full video over time, including actions, objects, people, scene changes, and spatial relationships.',
  '- Read on-screen text (captions, signs, scoreboards, chat, overlays, and name tags) as evidence.',
  '- For mixed queries, require all requested conditions to be satisfied.',
  '- A quoted phrase may be SPOKEN or may appear as ON-SCREEN TEXT. Unless the instruction says which, either one satisfies it. Do not reject a moment because a phrase you can see is absent from the transcript.',
  '- "say" or "says" applied to an object — a sign, a car, a shirt, a screen, a slide — means text visible on that object, not speech.',
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

/**
 * The prompt for reading a video at upload, before anyone has asked anything.
 *
 * Deliberately open: at index time there is no question to look for, so the
 * only useful instruction is to write down what is there. What gets omitted
 * here can never be recalled later without going back to the footage, and the
 * things users ask about — text on a sign, a make of car, who is on screen —
 * are exactly the details a summary drops first.
 */
export const INDEX_SYSTEM_PROMPT = [
  'You are a video indexer. You are given an actual MP4 segment of a longer video.',
  'Write down what happens in it, as a series of scenes, so that someone who cannot watch the video can later find moments in it from your notes alone.',
  '',
  'Rules:',
  '- Cover the WHOLE segment. Every second should fall inside some scene.',
  '- A scene is a stretch where the same thing is happening. Start a new one when the subject, location, or action changes.',
  '- Timestamps are in SECONDS FROM THE START OF THIS SEGMENT, not from the start of the video.',
  '- Be concrete and specific. Name what is visible: objects, vehicles, people and what they are doing, places, actions, and any change on screen.',
  '- Transcribe on-screen text exactly — signs, captions, overlays, labels, screens, clothing, number plates. Quote it.',
  '- Prefer plain nouns over categories: "red pickup truck", not "a vehicle".',
  '- Do not editorialise, rate, or summarise the video as a whole. Describe what is there.',
  '- Return only the JSON. Do not explain your reasoning, before or after it.',
  '',
  'Respond with ONLY a JSON object in exactly this shape, and no other text:',
  '{"scenes":[{"start_seconds":0,"end_seconds":14.5,"description":"what is happening and what is visible"}]}',
].join('\n');

export function buildIndexInstruction(input: {
  chunkDurationSeconds: number;
  chunkIndex: number;
  chunkCount: number;
}): string {
  return [
    `This is segment ${input.chunkIndex + 1} of ${input.chunkCount} from a longer video.`,
    `The segment is ${input.chunkDurationSeconds.toFixed(1)} seconds long.`,
    `Valid timestamps for this segment are between 0 and ${input.chunkDurationSeconds.toFixed(1)} seconds.`,
    '',
    'Describe this segment as scenes.',
  ].join('\n');
}

/**
 * The prompt for answering from the notes rather than the footage.
 *
 * The notes are what the indexer thought worth writing down while watching,
 * not a complete account of the video. Saying so in the prompt is the whole
 * difference between "the notes do not mention it" and "the video does not
 * contain it" — and only the first of those is something these notes can
 * actually support.
 */
export const NOTES_SYSTEM_PROMPT = [
  'You are answering a question about a video from notes taken while watching it.',
  'You cannot see the video itself. Each note is timestamped, and marked either "seen" for what was on screen or "said" for what was spoken aloud.',
  '',
  'Rules:',
  '- A "seen" note is a description of the picture. A "said" note is speech, quoted from the transcript. Match the instruction against whichever kind it is actually about.',
  '- Timestamps are in SECONDS FROM THE START OF THE VIDEO. Report them on that same timeline.',
  '- Report ONLY moments the notes actually support. Do not infer a moment from what would plausibly happen nearby.',
  '- A moment must have end_seconds greater than start_seconds.',
  '- confidence is how well the notes support this moment, from 0 to 1. Use a low number when a note is suggestive but not explicit.',
  '- description is a terse label of at most 12 words, taken from what the notes say.',
  '- If the notes do not describe anything matching the instruction, return an empty matches array.',
  '- Returning nothing is a correct answer. The notes are a summary, and something present in the video may simply not have been written down — that is not your problem to solve by guessing.',
  '- Return only the JSON. Do not explain your reasoning, before or after it.',
  '',
  'Respond with ONLY a JSON object in exactly this shape, and no other text:',
  '{"matches":[{"start_seconds":812.5,"end_seconds":830.0,"description":"what happens","confidence":0.8}]}',
].join('\n');

export interface NoteLine {
  /** Seconds from the start of the VIDEO, not of a chunk. */
  startSeconds: number;
  endSeconds: number;
  description: string;
  /**
   * Where the note came from. Speech and picture are different evidence, and a
   * question about one must not be answered from the other — "where do they
   * say the price" cannot be settled by a description of the room.
   */
  kind: 'seen' | 'said';
}

export function buildNotesBlock(input: { instruction: string; notes: NoteLine[] }): string {
  const lines = input.notes.map(
    (note) => `[${note.startSeconds.toFixed(1)}-${note.endSeconds.toFixed(1)}] (${note.kind}) ${note.description}`,
  );

  return [
    `USER INSTRUCTION: ${input.instruction}`,
    '',
    'NOTES FROM THE VIDEO:',
    ...lines,
    '',
    'Which of these moments match the instruction?',
  ].join('\n');
}
