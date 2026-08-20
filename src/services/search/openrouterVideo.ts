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
  choices?: Array<{
    message?: { content?: string | null };
    /**
     * `length` here is the tell that the model was cut off rather than done.
     * Without it an empty answer and a deliberate "no matches" look identical.
     */
    finish_reason?: string | null;
    native_finish_reason?: string | null;
  }>;
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
  /**
   * True when the first attempt returned no answer and the chunk was recovered
   * by asking again with thinking switched off. The matches are real; what is
   * worth knowing is that this chunk was answered without deliberation.
   */
  reasoningDisabled?: boolean;
}

/**
 * How much thinking this attempt is allowed.
 *
 * `off` exists for exactly one situation: a model that spent its whole budget
 * reasoning and returned an empty answer. Retrying identically would spend the
 * same budget the same way, so the retry has to differ.
 */
type ReasoningPolicy = 'budgeted' | 'off';

const limiter = new Semaphore(env.OPENROUTER_VIDEO_CONCURRENCY);
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Recognises a provider refusing the input on content-policy grounds.
 *
 * Alibaba answers `data_inspection_failed` / "Input text data may contain
 * inappropriate content" — on an ordinary business podcast transcript. It is a
 * 400 like any other, but unlike a malformed request it is worth retrying
 * WITHOUT the text, so it has to be told apart from the rest.
 */
export function isContentFilterRejection(error: unknown): boolean {
  if (!(error instanceof ExternalServiceError)) return false;
  return /data_inspection_failed|inappropriate content|content[_ ]?(policy|filter)/i.test(error.message);
}

/** Prefix of the error raised when a billed 200 ran out of room to answer. */
const EXHAUSTED_ANSWER = 'Video response ran out of room';

/**
 * Recognises a request that succeeded, was billed, and did not finish saying
 * what it saw.
 *
 * Two shapes, one cause. The model can stop before writing anything, or stop
 * partway through the JSON — and the truncated one is the more dangerous,
 * because `parseModelMatches` never throws: a half-written object yields zero
 * matches and warnings, which downstream is indistinguishable from a
 * considered "there is nothing here". On the run that exposed this, the chunk
 * covering 00:16:01-00:18:01 was lost exactly that quietly.
 */
export function isExhaustedAnswer(error: unknown): boolean {
  return error instanceof ExternalServiceError && error.message.startsWith(EXHAUSTED_ANSWER);
}

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

async function requestCompletion(
  input: VideoSearchInput,
  policy: ReasoningPolicy = 'budgeted',
): Promise<VideoSearchResult> {
  const { parts, videoBytes } = await buildContent(input);
  const reasoningBudget = policy === 'off' ? 0 : env.OPENROUTER_VIDEO_REASONING_MAX_TOKENS;
  const body = JSON.stringify({
    model: env.OPENROUTER_VIDEO_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: parts },
    ],
    // Deliberately the sum, not the answer budget alone, and the same ceiling
    // under both policies. Providers differ on whether reasoning is charged
    // against `max_tokens`; on the ones that charge it, sending the answer
    // budget by itself hands the model a ceiling it can exhaust before
    // answering at all. Holding the ceiling fixed is also what makes the
    // no-thinking retry an improvement rather than a smaller second chance:
    // the whole allowance becomes available to the answer.
    max_tokens: env.OPENROUTER_VIDEO_MAX_TOKENS + env.OPENROUTER_VIDEO_REASONING_MAX_TOKENS,
    temperature: env.OPENROUTER_VIDEO_TEMPERATURE,
    stream: false,
    // Bounded, not disabled.
    //
    // Reasoning was briefly turned off as a cost fix and put back when the
    // numbers showed it was doing real work: the chunks that found moments
    // were the ones that spent tokens thinking. A full run then showed the
    // other half of the picture — the spend that finds things sits in a band
    // (438-1,700 tokens), and past it are only runaways. One chunk thought for
    // 7,692 tokens across 142 seconds and found nothing; another never
    // produced an answer at all and cost the search two minutes of the video.
    //
    // So the trade is not "cheaper versus better". Above the band, more
    // thinking bought nothing and lost coverage, and a budget is what keeps
    // both. `exclude` drops the reasoning text from the response — it is
    // billed either way, and we have never read it.
    reasoning: policy === 'off' ? { enabled: false, exclude: true } : { max_tokens: reasoningBudget, exclude: true },
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

    const choice = payload.choices?.[0];
    const content = choice?.message?.content;
    const finishReason = choice?.finish_reason ?? choice?.native_finish_reason ?? null;
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
      // The two facts that separate "found nothing" from "never answered".
      finishReason,
      answerChars: typeof content === 'string' ? content.length : 0,
      reasoningPolicy: policy,
    });

    // Logs answer "what did this call cost"; the usage table answers "what did
    // this video cost" and "what did this search cost", which is the question
    // that actually shapes pricing. Recorded before the answer is validated,
    // because a 200 that thought for 7,000 tokens and returned nothing was
    // still billed — accounting for it only on success understated the true
    // cost of exactly the calls worth knowing about.
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

    // Validated last, so a billed call is always accounted for even when it
    // answered nothing.
    const where = `finish_reason=${finishReason ?? 'none'}, reasoning_tokens=${reasoningTokens ?? 0}`;

    // A blank string is not "no moments here": `""` parses to zero matches and
    // would be stored as a considered negative result.
    if (typeof content !== 'string' || content.trim() === '') {
      throw new ExternalServiceError('openrouter-video', `${EXHAUSTED_ANSWER}: nothing was written (${where})`, {
        retryable: false,
      });
    }

    // Nor is a half-written one. `length` means the model was cut off, and a
    // truncated `{"matches":[{...` has no balanced closing brace — the parser
    // shrugs and returns zero matches, so the chunk records as searched and
    // found nothing. Worth a second call while thinking can still be traded
    // for room; on the retry there is nothing left to trade, so partial
    // matches are kept rather than thrown away.
    if (finishReason === 'length') {
      if (policy !== 'off') {
        throw new ExternalServiceError('openrouter-video', `${EXHAUSTED_ANSWER}: answer cut off (${where})`, {
          retryable: false,
        });
      }
      logger.warn('answer was cut off even with thinking disabled; keeping what parsed', {
        model: env.OPENROUTER_VIDEO_MODEL,
        chunkIndex: input.chunkIndex,
        answerChars: content.length,
        maxTokens: env.OPENROUTER_VIDEO_MAX_TOKENS + env.OPENROUTER_VIDEO_REASONING_MAX_TOKENS,
      });
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

/**
 * The rule: a chunk is never lost because the model spent its budget thinking.
 *
 * A 200 that ran out of room is not a failure the outer retry loop can help
 * with — the same request would think its way to the same place, at the same
 * price. The only retry worth making is a different one, so this asks again
 * with thinking off, where the whole ceiling belongs to the answer.
 *
 * Deliberately one extra call, not a ladder. If a chunk cannot answer with its
 * entire budget available for answering, the problem is not the budget.
 */
async function completeOrAnswerWithoutThinking(input: VideoSearchInput): Promise<VideoSearchResult> {
  try {
    return await requestCompletion(input, 'budgeted');
  } catch (error) {
    if (!isExhaustedAnswer(error)) throw error;

    logger.warn('chunk ran out of room to answer; asking again without thinking', {
      model: env.OPENROUTER_VIDEO_MODEL,
      chunkIndex: input.chunkIndex,
      reason: (error as Error).message,
    });

    const result = await requestCompletion(input, 'off');
    return { ...result, reasoningDisabled: true };
  }
}

/** Searches one chunk with the single configured Qwen model; no fallback or escalation. */
export async function searchVideoChunk(input: VideoSearchInput): Promise<VideoSearchResult> {
  return limiter.run(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= env.OPENROUTER_MAX_RETRIES; attempt += 1) {
      try {
        return await completeOrAnswerWithoutThinking(input);
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
