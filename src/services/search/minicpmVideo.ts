import { env } from '../../config/env.js';
import { Semaphore, sleep } from '../../lib/concurrency.js';
import { ExternalServiceError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { getStorage } from '../storage/s3.js';
import type { VideoModelAnswer, VideoModelRequest } from './openrouterVideo.js';

/**
 * The MiniCPM-V 4.6 provider: our own model, on our own Modal deployment,
 * reading actual video.
 *
 * This module is the only place in CLIPIT that knows the Modal endpoint
 * exists. It receives the same request the OpenRouter provider receives and
 * returns the same answer shape, so everything above the seam — prompt
 * building, JSON extraction, zod validation, timestamp clamping, coverage
 * accounting — is identical under either provider.
 *
 * The wire protocol is the endpoint's, not ours:
 *
 *     POST $MINICPM_VIDEO_URL
 *     { "video_url": "<signed chunk URL>", "prompt": "<text>" }
 *  →  { "model": "openbmb/MiniCPM-V-4.6", "result": "<free-form text>" }
 *
 * Two deliberate differences from the OpenRouter path:
 *
 * - The video travels as a SIGNED URL, not base64. Modal downloads the chunk
 *   itself, so request bodies stay small and a cold container can fetch at
 *   its own pace. The URL is signed fresh per call, lives exactly as long as
 *   the request timeout, and is never logged — a logged signed URL is a
 *   logged copy of someone's footage.
 *
 * - Retry-After is honoured. A GPU service that says "come back in 20s" means
 *   it; hammering it during a cold start only queues cost.
 *
 * MiniCPM reports no token counts, so usage rows carry zeros with a null
 * cost — the tally's callsMissingCost makes that visible instead of silently
 * pricing GPU seconds at zero. Latency and call counts are recorded, which is
 * what a later cost-per-source-hour calculation actually needs.
 */

interface MiniCpmResponse {
  model?: string;
  result?: string;
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * One gate for every call that can hold a GPU. Deliberately its own semaphore
 * rather than the OpenRouter one: the two providers have different cost
 * models, and a queue for one must not starve the other during a switchover.
 */
const minicpmLimiter = new Semaphore(env.MINICPM_VIDEO_CONCURRENCY);

/** Test seam: how long a Retry-After is trusted before the cap takes over. */
const RETRY_AFTER_CAP_MS = 60_000;

function retryAfterMs(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(RETRY_AFTER_CAP_MS, seconds * 1000);
  const at = Date.parse(header);
  if (!Number.isNaN(at)) return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, at - Date.now()));
  return null;
}

/**
 * The prompt is the request's text parts, joined under the system prompt. The
 * endpoint takes one string; the video part is carried by URL instead, and the
 * base64 body the OpenRouter path would have sent is simply not used here.
 */
function promptFromRequest(input: VideoModelRequest): string {
  const text = input.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
  return `${input.systemPrompt}\n\n${text}`;
}

export async function askMiniCpmVideo(
  input: VideoModelRequest & { videoStorageKey: string },
): Promise<VideoModelAnswer> {
  const endpoint = env.MINICPM_VIDEO_URL;
  if (!endpoint || !env.MODAL_PROXY_TOKEN_ID || !env.MODAL_PROXY_TOKEN_SECRET) {
    // Startup validation makes this unreachable in a real process; it exists
    // so a misconfigured test can never fall through to an open endpoint.
    throw new ExternalServiceError('minicpm-video', 'MiniCPM provider is not configured', { retryable: false });
  }

  return minicpmLimiter.run(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= env.MINICPM_MAX_RETRIES; attempt += 1) {
      try {
        return await requestOnce(input, endpoint);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ExternalServiceError && error.retryable;
        if (!retryable || attempt === env.MINICPM_MAX_RETRIES) break;
        const askedFor = error instanceof ExternalServiceError ? error.retryAfterMs : undefined;
        const delayMs = askedFor ?? Math.min(30_000, 1_000 * 2 ** attempt);
        logger.warn('retrying MiniCPM video request', {
          purpose: input.purpose,
          chunkIndex: input.chunkIndex,
          attempt: attempt + 1,
          delayMs,
          honouredRetryAfter: askedFor !== undefined,
        });
        await sleep(delayMs);
      }
    }
    throw lastError;
  });
}

async function requestOnce(
  input: VideoModelRequest & { videoStorageKey: string },
  endpoint: string,
): Promise<VideoModelAnswer> {
  // Signed per attempt, so a retry after a long backoff never carries an
  // already-expired URL. Lifetime matches the request timeout: long enough
  // for a cold container to fetch, gone the moment the request has no use
  // for it.
  const videoUrl = await getStorage().createDownloadUrl(input.videoStorageKey, {
    expiresInSeconds: env.MINICPM_REQUEST_TIMEOUT_SECONDS,
  });

  const body = JSON.stringify({ video_url: videoUrl, prompt: promptFromRequest(input) });
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.MINICPM_REQUEST_TIMEOUT_SECONDS * 1000);

  try {
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Modal proxy auth. The token pair is Clipit's own, revocable
          // without touching any other project, and exists only server-side.
          'Modal-Key': env.MODAL_PROXY_TOKEN_ID!,
          'Modal-Secret': env.MODAL_PROXY_TOKEN_SECRET!,
        },
        body,
        signal: controller.signal,
      });
    } catch (error) {
      const aborted = (error as Error).name === 'AbortError';
      throw new ExternalServiceError(
        'minicpm-video',
        aborted ? 'MiniCPM request timed out' : `MiniCPM request failed: ${(error as Error).message}`,
        { retryable: true, cause: error },
      );
    }

    const latencyMs = Math.round(performance.now() - startedAt);

    if (!response.ok) {
      const responseBody = await response.text().catch(() => '');
      logger.warn('MiniCPM video request failed', {
        purpose: input.purpose,
        chunkIndex: input.chunkIndex,
        videoDurationSeconds: input.chunkDurationSeconds,
        status: response.status,
        latencyMs,
      });
      // 401/403 is the proxy refusing the token. Retrying cannot help and
      // each retry is a knock on a door that logs failed auth attempts.
      const authFailure = response.status === 401 || response.status === 403;
      throw new ExternalServiceError(
        'minicpm-video',
        authFailure
          ? `Modal proxy rejected Clipit's token (status ${response.status}) — check MODAL_PROXY_TOKEN_ID/SECRET`
          : `MiniCPM request failed with status ${response.status}: ${responseBody.slice(0, 400)}`,
        {
          retryable: !authFailure && RETRYABLE_STATUS.has(response.status),
          ...(retryAfterMs(response) !== null ? { retryAfterMs: retryAfterMs(response)! } : {}),
        },
      );
    }

    let payload: MiniCpmResponse;
    try {
      payload = (await response.json()) as MiniCpmResponse;
    } catch (error) {
      throw new ExternalServiceError('minicpm-video', 'MiniCPM response was not JSON', {
        retryable: false,
        cause: error,
      });
    }

    const content = payload.result;

    logger.info('MiniCPM video request complete', {
      provider: 'modal',
      model: payload.model ?? 'openbmb/MiniCPM-V-4.6',
      purpose: input.purpose,
      chunkIndex: input.chunkIndex,
      videoDurationSeconds: input.chunkDurationSeconds,
      latencyMs,
      answerChars: typeof content === 'string' ? content.length : 0,
    });

    // Zero tokens with a null cost, not silence: the call happened, it held a
    // GPU for latencyMs, and the usage table is how anything is ever priced.
    input.onUsage?.({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: null,
      latencyMs,
      provider: 'modal',
      model: payload.model ?? 'openbmb/MiniCPM-V-4.6',
    });

    // The same rule as the OpenRouter path: a blank answer must never parse
    // as a considered "no moments here".
    if (typeof content !== 'string' || content.trim() === '') {
      throw new ExternalServiceError('minicpm-video', 'MiniCPM returned an empty result', { retryable: false });
    }

    return { content, reasoningDisabled: false };
  } finally {
    clearTimeout(timeout);
  }
}
