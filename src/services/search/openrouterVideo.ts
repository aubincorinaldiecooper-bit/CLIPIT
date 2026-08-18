import { readFile, stat } from 'node:fs/promises';
import { env } from '../../config/env.js';
import { Semaphore, sleep } from '../../lib/concurrency.js';
import { ExternalServiceError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { ResolvedSearchMode } from '../../domain/types.js';
import { parseModelMatches, type ParsedMatch } from './modelResponse.js';
import { SYSTEM_PROMPT, buildInstructionBlock, buildTranscriptBlock, type TranscriptLine } from './prompt.js';

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'video_url'; video_url: { url: string } };

interface CompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
  provider?: string;
}

export interface VideoSearchInput {
  instruction: string;
  mode: ResolvedSearchMode;
  chunkIndex: number;
  chunkCount: number;
  chunkDurationSeconds: number;
  videoPath?: string;
  transcript: TranscriptLine[];
}

export interface VideoSearchResult {
  matches: ParsedMatch[];
  warnings: string[];
  rawResponse: string;
}

const limiter = new Semaphore(env.OPENROUTER_VIDEO_CONCURRENCY);
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    ...(env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': env.OPENROUTER_SITE_URL } : {}),
    ...(env.OPENROUTER_APP_NAME ? { 'X-Title': env.OPENROUTER_APP_NAME } : {}),
  };
}

async function buildContent(input: VideoSearchInput): Promise<{ parts: ContentPart[]; videoBytes: number }> {
  const parts: ContentPart[] = [{
    type: 'text',
    text: buildInstructionBlock(input),
  }];

  let videoBytes = 0;
  if (input.mode !== 'transcript') {
    if (!input.videoPath) throw new Error('Actual video is required for visual search');
    const [video, info] = await Promise.all([readFile(input.videoPath), stat(input.videoPath)]);
    videoBytes = info.size;
    parts.push({
      type: 'video_url',
      video_url: { url: `data:video/mp4;base64,${video.toString('base64')}` },
    });
  }

  if (input.mode !== 'visual') {
    parts.push({ type: 'text', text: buildTranscriptBlock(input.transcript) });
  }

  return { parts, videoBytes };
}

async function requestCompletion(input: VideoSearchInput): Promise<VideoSearchResult> {
  const { parts, videoBytes } = await buildContent(input);
  const body = JSON.stringify({
    model: env.OPENROUTER_VIDEO_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: parts },
    ],
    max_tokens: env.OPENROUTER_VIDEO_MAX_TOKENS,
    temperature: env.OPENROUTER_VIDEO_TEMPERATURE,
    stream: false,
  });
  const payloadBytes = Buffer.byteLength(body);
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.OPENROUTER_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${env.OPENROUTER_API_BASE_URL.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: headers(),
      body,
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = (error as Error).name === 'AbortError';
    throw new ExternalServiceError(
      'openrouter-video',
      aborted ? 'Video request timed out' : `Video request failed: ${(error as Error).message}`,
      { retryable: true, cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }

  const latencyMs = Math.round(performance.now() - startedAt);
  if (!response.ok) {
    const responseBody = await response.text().catch(() => '');
    logger.warn('OpenRouter video request failed', {
      model: env.OPENROUTER_VIDEO_MODEL,
      chunkIndex: input.chunkIndex,
      videoDurationSeconds: input.chunkDurationSeconds,
      videoBytes,
      payloadBytes,
      latencyMs,
      status: response.status,
    });
    throw new ExternalServiceError(
      'openrouter-video',
      `Video request failed with status ${response.status}: ${responseBody.slice(0, 400)}`,
      { retryable: RETRYABLE_STATUS.has(response.status) },
    );
  }

  const payload = (await response.json()) as CompletionResponse;
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new ExternalServiceError('openrouter-video', 'Video response contained no message content', {
      retryable: false,
    });
  }

  logger.info('OpenRouter video request complete', {
    model: env.OPENROUTER_VIDEO_MODEL,
    provider: payload.provider,
    chunkIndex: input.chunkIndex,
    videoDurationSeconds: input.chunkDurationSeconds,
    videoBytes,
    payloadBytes,
    latencyMs,
    promptTokens: payload.usage?.prompt_tokens,
    completionTokens: payload.usage?.completion_tokens,
    totalTokens: payload.usage?.total_tokens,
    costUsd: payload.usage?.cost,
  });

  const parsed = parseModelMatches(content);
  return { ...parsed, rawResponse: content };
}

/** Searches one chunk with the single configured Qwen model; no fallback or escalation. */
export async function searchVideoChunk(input: VideoSearchInput): Promise<VideoSearchResult> {
  return limiter.run(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= env.OPENROUTER_MAX_RETRIES; attempt += 1) {
      try {
        return await requestCompletion(input);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ExternalServiceError && error.retryable;
        if (!retryable || attempt === env.OPENROUTER_MAX_RETRIES) break;
        const delayMs = Math.min(30_000, 1_000 * 2 ** attempt);
        logger.warn('retrying OpenRouter video request', {
          model: env.OPENROUTER_VIDEO_MODEL,
          chunkIndex: input.chunkIndex,
          attempt: attempt + 1,
          delayMs,
        });
        await sleep(delayMs);
      }
    }
    throw lastError;
  });
}
