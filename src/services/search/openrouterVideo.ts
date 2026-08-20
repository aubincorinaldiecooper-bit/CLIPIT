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
    /**
     * Reasoning is billed inside `completion_tokens`, so this is the only way
     * to tell a model that thought at length from one that simply answered at
     * length. The two look identical in the total and need opposite fixes.
     */
    completion_tokens_details?: { reasoning_tokens?: number };
  };
  provider?: string;
}

/**
 * Reports one call's cost. The caller decides where it goes, so this service
 * keeps no dependency on the database.
 */
export type VideoUsageReporter = (usage: {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number | null;
  latencyMs: number;
  provider: string;
  model: string;
}) => void;

export interface VideoSearchInput {
  instruction: string;
  mode: ResolvedSearchMode;
  chunkIndex: number;
  chunkCount: number;
  chunkDurationSeconds: number;
  videoPath?: string;
  transcript: TranscriptLine[];
  /** Optional: called once per completed request with its tokens and cost. */
  onUsage?: VideoUsageReporter;
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
    // Locating a moment is not a reasoning task: the answer is a short JSON
    // array of timestamps. Thinking tokens are billed as output and are
    // generated one at a time, so they cost money AND wall clock — one chunk
    // spent 13,431 completion tokens against a 1,024 cap, because the cap
    // bounds visible content while thinking runs on its own budget.
    reasoning: { enabled: false, exclude: true },
  });
  const payloadBytes = Buffer.byteLength(body);
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.OPENROUTER_REQUEST_TIMEOUT_MS);

  try {
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
    }

    /**
     * Headers only. fetch resolves as soon as they arrive, while the model is
     * still generating, so this measures upload plus time-to-first-byte and
     * NOT the work. Reading the body is where generation actually lands, and
     * conflating the two hid four minutes of a four-and-a-half-minute search.
     */
    const headersMs = Math.round(performance.now() - startedAt);

    if (!response.ok) {
      const responseBody = await response.text().catch(() => '');
      logger.warn('OpenRouter video request failed', {
        model: env.OPENROUTER_VIDEO_MODEL,
        chunkIndex: input.chunkIndex,
        videoDurationSeconds: input.chunkDurationSeconds,
        videoBytes,
        payloadBytes,
        headersMs,
        status: response.status,
      });
      throw new ExternalServiceError(
        'openrouter-video',
        `Video request failed with status ${response.status}: ${responseBody.slice(0, 400)}`,
        { retryable: RETRYABLE_STATUS.has(response.status) },
      );
    }

    const bodyStartedAt = performance.now();
    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError';
      throw new ExternalServiceError(
        'openrouter-video',
        aborted
          ? 'Video response timed out while the model was still generating'
          : `Video response failed mid-body: ${(error as Error).message}`,
        { retryable: true, cause: error },
      );
    }
    const bodyMs = Math.round(performance.now() - bodyStartedAt);
    const latencyMs = Math.round(performance.now() - startedAt);

    let payload: CompletionResponse;
    try {
      payload = JSON.parse(raw) as CompletionResponse;
    } catch (error) {
      throw new ExternalServiceError('openrouter-video', 'Video response was not JSON', {
        retryable: false,
        cause: error,
      });
    }

    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new ExternalServiceError('openrouter-video', 'Video response contained no message content', {
        retryable: false,
      });
    }

    const reasoningTokens = payload.usage?.completion_tokens_details?.reasoning_tokens;

    logger.info('OpenRouter video request complete', {
      model: env.OPENROUTER_VIDEO_MODEL,
      provider: payload.provider,
      chunkIndex: input.chunkIndex,
      videoDurationSeconds: input.chunkDurationSeconds,
      videoBytes,
      payloadBytes,
      // Split so a slow chunk can be attributed: upload/TTFB versus generation.
      headersMs,
      bodyMs,
      latencyMs,
      promptTokens: payload.usage?.prompt_tokens,
      completionTokens: payload.usage?.completion_tokens,
      // Separates a model that thought at length from one that merely answered
      // at length. Both inflate completion_tokens; only one is fixed by
      // turning reasoning off.
      reasoningTokens,
      totalTokens: payload.usage?.total_tokens,
      costUsd: payload.usage?.cost,
    });

    // Logs answer "what did this call cost"; the usage table answers "what did
    // this video cost" and "what did this search cost", which is the question
    // that actually shapes pricing. Reported after a successful response so a
    // retried failure is not counted twice.
    if (input.onUsage && payload.usage) {
      const promptTokens = Math.max(0, Math.round(payload.usage.prompt_tokens ?? 0));
      const completionTokens = Math.max(0, Math.round(payload.usage.completion_tokens ?? 0));
      const totalTokens = Math.max(0, Math.round(payload.usage.total_tokens ?? promptTokens + completionTokens));
      if (totalTokens > 0 || typeof payload.usage.cost === 'number') {
        input.onUsage({
          promptTokens,
          completionTokens,
          totalTokens,
          costUsd: typeof payload.usage.cost === 'number' ? payload.usage.cost : null,
          latencyMs,
          provider: payload.provider ?? 'openrouter.ai',
          model: env.OPENROUTER_VIDEO_MODEL,
        });
      }
    }

    const parsed = parseModelMatches(content);
    return { ...parsed, rawResponse: content };
  } finally {
    // Cleared only once the body has been read. Clearing it when headers
    // arrived left generation uncancellable: a model that never stopped
    // producing tokens would have hung the chunk forever, with the request
    // timeout already disarmed and no log line to show for it.
    clearTimeout(timeout);
  }
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
