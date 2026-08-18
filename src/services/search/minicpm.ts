import { readFile } from 'node:fs/promises';
import { env } from '../../config/env.js';
import { ExternalServiceError } from '../../lib/errors.js';
import { Semaphore, sleep } from '../../lib/concurrency.js';
import { logger } from '../../lib/logger.js';
import type { ResolvedSearchMode } from '../../domain/types.js';
import { parseModelMatches, type ParsedMatch } from './modelResponse.js';
import { SYSTEM_PROMPT, buildFrameLabel, buildInstructionBlock, buildTranscriptBlock, type TranscriptLine } from './prompt.js';

/**
 * MiniCPM-V client.
 *
 * Every call to the model happens here, server-side. The API key is read from
 * the environment and is never returned by, or reachable from, the public API.
 */

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user';
  content: string | ContentPart[];
}

/** Shared across the whole worker process, so MINICPM_CONCURRENCY is a real cap. */
const limiter = new Semaphore(env.MINICPM_CONCURRENCY);

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export interface FrameInput {
  localSeconds: number;
  filePath: string;
}

export interface SearchChunkInput {
  instruction: string;
  mode: ResolvedSearchMode;
  chunkIndex: number;
  chunkCount: number;
  chunkDurationSeconds: number;
  frames: FrameInput[];
  transcript: TranscriptLine[];
}

export interface SearchChunkResult {
  matches: ParsedMatch[];
  warnings: string[];
  rawResponse: string;
}

export async function frameToDataUrl(filePath: string): Promise<string> {
  const buffer = await readFile(filePath);
  return `data:image/jpeg;base64,${buffer.toString('base64')}`;
}

async function buildMessages(input: SearchChunkInput): Promise<ChatMessage[]> {
  const parts: ContentPart[] = [
    {
      type: 'text',
      text: buildInstructionBlock({
        instruction: input.instruction,
        chunkDurationSeconds: input.chunkDurationSeconds,
        chunkIndex: input.chunkIndex,
        chunkCount: input.chunkCount,
        mode: input.mode,
      }),
    },
  ];

  if (input.mode !== 'visual') {
    parts.push({ type: 'text', text: buildTranscriptBlock(input.transcript) });
  }

  if (input.mode !== 'transcript') {
    for (const [index, frame] of input.frames.entries()) {
      parts.push({ type: 'text', text: buildFrameLabel(frame.localSeconds, index, input.frames.length) });
      parts.push({ type: 'image_url', image_url: { url: await frameToDataUrl(frame.filePath) } });
    }
  }

  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: parts },
  ];
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

async function requestCompletion(messages: ChatMessage[]): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.MINICPM_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${env.MINICPM_API_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.MINICPM_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.MINICPM_MODEL,
        messages,
        max_tokens: env.MINICPM_MAX_TOKENS,
        temperature: env.MINICPM_TEMPERATURE,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = (error as Error).name === 'AbortError';
    throw new ExternalServiceError(
      'minicpm',
      aborted ? 'Model request timed out' : `Model request failed: ${(error as Error).message}`,
      { retryable: true, cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ExternalServiceError(
      'minicpm',
      `Model request failed with status ${response.status}: ${body.slice(0, 400)}`,
      { retryable: RETRYABLE_STATUS.has(response.status) },
    );
  }

  const payload = (await response.json()) as ChatCompletionResponse;
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new ExternalServiceError('minicpm', 'Model response contained no message content', { retryable: false });
  }
  return content;
}

/**
 * Runs one chat completion under the shared concurrency cap, retrying only
 * errors the API reported as transient. Every model call in the codebase —
 * query-time search and ingest-time indexing alike — goes through here.
 */
export async function completeWithRetry(
  messages: ChatMessage[],
  logContext: Record<string, unknown> = {},
): Promise<string> {
  return limiter.run(async () => {
    let lastError: unknown;

    for (let attempt = 0; attempt <= env.MINICPM_MAX_RETRIES; attempt += 1) {
      try {
        return await requestCompletion(messages);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ExternalServiceError ? error.retryable : false;
        if (!retryable || attempt === env.MINICPM_MAX_RETRIES) break;
        const delay = Math.min(30_000, 1_000 * 2 ** attempt);
        logger.warn('retrying model request', {
          attempt: attempt + 1,
          delayMs: delay,
          ...logContext,
        });
        await sleep(delay);
      }
    }

    throw lastError;
  });
}

/**
 * Asks the model whether the user's instruction occurs anywhere in one chunk.
 * Returns chunk-local timestamps; the caller maps them to source time.
 */
export async function searchChunk(input: SearchChunkInput): Promise<SearchChunkResult> {
  const messages = await buildMessages(input);
  const rawResponse = await completeWithRetry(messages, { chunkIndex: input.chunkIndex });
  const { matches, warnings } = parseModelMatches(rawResponse);
  return { matches, warnings, rawResponse };
}
