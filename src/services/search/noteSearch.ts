import { env } from '../../config/env.js';
import { mapWithConcurrency } from '../../lib/concurrency.js';
import { parseModelMatches, type ParsedMatch } from './modelResponse.js';
import { askVideoModel, type VideoUsageReporter } from './openrouterVideo.js';
import { buildNotesBlock, NOTES_SYSTEM_PROMPT, type NoteLine } from './prompt.js';

/**
 * Answering a question from what was written down at upload.
 *
 * This is the fast path and the common one: text in, text out, no video sent,
 * a second or so and a fraction of a cent. It is not the authority on what the
 * video contains — the notes are a summary, and their silence is not evidence
 * of absence. A caller that gets nothing back from here has learned that the
 * notes do not mention it, which is a different fact from the video not
 * containing it, and must go to the footage before saying otherwise.
 */

export interface NoteSearchResult {
  /** Moments on the VIDEO's timeline, not a chunk's. */
  matches: ParsedMatch[];
  warnings: string[];
  /** How many lookups it took; one per batch of notes. */
  lookups: number;
  /**
   * Which service answered, for attribution on the stored matches. Notes
   * lookups stay on the OpenRouter text lane under either video provider,
   * and the rows should say so rather than inherit the video lane's name.
   */
  provider: string;
  model: string;
  promptVersion: string;
}

export interface NoteSearchInput {
  instruction: string;
  notes: NoteLine[];
  onUsage?: VideoUsageReporter;
}

/**
 * Splits notes into prompt-sized batches.
 *
 * Every note is looked at. Truncating a long video's notes to fit one request
 * would make the end of that video quietly unsearchable — the lookup would
 * succeed, report nothing, and never mention that it had stopped reading
 * halfway through.
 */
function batchNotes(notes: NoteLine[], size: number): NoteLine[][] {
  const batches: NoteLine[][] = [];
  for (let offset = 0; offset < notes.length; offset += size) {
    batches.push(notes.slice(offset, offset + size));
  }
  return batches;
}

export async function searchNotes(input: NoteSearchInput): Promise<NoteSearchResult> {
  if (input.notes.length === 0) {
    return {
      matches: [],
      warnings: ['no notes for this video'],
      lookups: 0,
      provider: 'openrouter',
      model: env.OPENROUTER_VIDEO_MODEL,
      promptVersion: '',
    };
  }

  const batches = batchNotes(input.notes, env.NOTES_PER_LOOKUP);

  const results = await mapWithConcurrency(batches, env.OPENROUTER_TEXT_CONCURRENCY, async (batch, index) => {
    const answer = await askVideoModel({
      chunkIndex: index,
      // The batch's own span, so the model is told what stretch it is reading
      // about rather than inferring it from the timestamps.
      chunkDurationSeconds: (batch.at(-1)?.endSeconds ?? 0) - (batch[0]?.startSeconds ?? 0),
      systemPrompt: NOTES_SYSTEM_PROMPT,
      parts: [{ type: 'text', text: buildNotesBlock({ instruction: input.instruction, notes: batch }) }],
      videoBytes: 0,
      answerMaxTokens: env.NOTES_ANSWER_MAX_TOKENS,
      purpose: 'notes',
      ...(input.onUsage ? { onUsage: input.onUsage } : {}),
    });

    return { parsed: parseModelMatches(answer.content), answer };
  });

  const matches: ParsedMatch[] = [];
  const warnings: string[] = [];
  let identity: { provider: string; model: string; promptVersion: string } | null = null;

  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      // A batch that failed is a stretch of notes nobody read. Recorded, so
      // the caller can tell an incomplete lookup from an empty answer.
      warnings.push(`notes batch ${index} failed: ${(result.reason as Error)?.message ?? 'unknown error'}`);
      continue;
    }
    matches.push(...result.value.parsed.matches);
    warnings.push(...result.value.parsed.warnings);
    identity ??= {
      provider: result.value.answer.provider,
      model: result.value.answer.model,
      promptVersion: result.value.answer.promptVersion,
    };
  }

  return {
    matches,
    warnings,
    lookups: batches.length,
    provider: identity?.provider ?? 'openrouter',
    model: identity?.model ?? env.OPENROUTER_VIDEO_MODEL,
    promptVersion: identity?.promptVersion ?? '',
  };
}
