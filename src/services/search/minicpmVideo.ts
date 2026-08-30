import {
  ExecutionError,
  FunctionTimeoutError,
  InternalFailure,
  InvalidError,
  ModalClient,
  NotFoundError,
  RemoteError,
  type Function_,
} from 'modal';
import { env } from '../../config/env.js';
import { Semaphore, sleep } from '../../lib/concurrency.js';
import { ExternalServiceError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { getStorage } from '../storage/s3.js';
import { promptVersion } from './prompt.js';
import type { VideoModelAnswer, VideoModelRequest } from './openrouterVideo.js';

/**
 * The MiniCPM-V 4.6 provider: our own model on our own GPU, invoked as
 * private Modal compute through Modal's SDK.
 *
 * This module is the only place in CLIPIT that knows Modal exists. It
 * receives the same request the OpenRouter provider receives and returns the
 * same answer shape, so everything above the seam — prompt building, JSON
 * extraction, zod validation, timestamp clamping, coverage accounting — is
 * identical under either provider.
 *
 * There is no HTTP endpoint and no URL to protect. The path is
 *
 *     ModalClient (MODAL_TOKEN_ID / MODAL_TOKEN_SECRET, Clipit's own token)
 *       → app clipit-minicpm-v46 → class MiniCPMModel → analyze(video_url, prompt)
 *
 * and the deployed method answers `{ model, result, metrics }`, where
 * `result` is free text the existing parsers consume.
 *
 * The video itself still travels as a SIGNED chunk URL — Modal downloads it
 * inside the container. Signed fresh per attempt, alive exactly as long as
 * the request's allowance, never logged: a logged signed URL is a logged copy
 * of someone's footage.
 *
 * Cost rules, unchanged from the HTTP design: one gate on in-flight calls
 * (the deployment runs max_containers=1, so Clipit-side concurrency stays 1
 * until the Modal side is deliberately widened), bounded retries, and only
 * errors Modal itself documents as retryable are retried — InternalFailure
 * and transport failures. A function timeout is not retried (the same chunk
 * would overrun the same way), and neither is anything that reads as bad
 * input or bad configuration.
 *
 * MiniCPM reports no token counts, so usage rows carry zeros with a null
 * cost — the tally's callsMissingCost keeps that visible instead of silently
 * pricing GPU seconds at zero. Latency and call counts are recorded; the
 * returned metrics are logged for the cost-per-source-hour arithmetic.
 */

interface MiniCpmResult {
  model?: string;
  result?: string;
  metrics?: Record<string, unknown>;
}

/**
 * The remote method's name is part of the deployment's contract, stable in
 * code on both sides — configuration for it would be a knob nobody turns.
 */
const ANALYZE_METHOD = 'analyze';

const minicpmLimiter = new Semaphore(env.MINICPM_VIDEO_CONCURRENCY);

/**
 * The remote handle, resolved once and kept. Lookup is itself a network
 * round-trip; paying it per chunk would double every call. A redeploy of the
 * Modal app can strand the cached handle, so a not-found during invocation
 * drops the cache and looks up again once (see requestOnce).
 */
let clientCache: ModalClient | null = null;
let methodCache: Promise<Function_> | null = null;

function modalClient(): ModalClient {
  // Explicit credentials rather than ambient env reading, so custody is
  // visible here: this token is Clipit's, revocable on its own.
  // No environment param on purpose: the SDK itself honours the standard
  // MODAL_ENVIRONMENT variable when one is set, and inventing a second name
  // for the same thing would be configuration nobody needs.
  clientCache ??= new ModalClient({
    tokenId: env.MODAL_TOKEN_ID!,
    tokenSecret: env.MODAL_TOKEN_SECRET!,
  });
  return clientCache;
}

function lookupMethod(): Promise<Function_> {
  methodCache ??= (async () => {
    const cls = await modalClient().cls.fromName(env.MODAL_APP_NAME, env.MODAL_CLASS_NAME);
    const instance = await cls.instance();
    return instance.method(ANALYZE_METHOD);
  })();
  return methodCache;
}

/** Test seam: forget the cached client and handle. */
export function resetMiniCpmClient(): void {
  clientCache = null;
  methodCache = null;
}

/**
 * The prompt is the request's text parts joined under the system prompt. The
 * remote method takes one string; the video is carried by URL, and the base64
 * body the OpenRouter path would have sent is never built here.
 */
function promptFromRequest(input: VideoModelRequest): string {
  const text = input.parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n');
  return `${input.systemPrompt}\n\n${text}`;
}

/**
 * What went wrong, in the terms the retry loop understands.
 *
 * Modal's SDK throws typed errors, and they sort cleanly: InternalFailure is
 * documented "safe to retry"; a FunctionTimeoutError means the remote method
 * exceeded ITS OWN configured timeout, which a retry would only repeat at
 * full GPU price; NotFoundError is a wrong app/class name or a token without
 * access — configuration, not weather; ExecutionError and RemoteError mean
 * the method itself raised, which the same input would raise again.
 */
function classify(error: unknown): ExternalServiceError {
  if (error instanceof ExternalServiceError) return error;
  if (error instanceof InternalFailure) {
    return new ExternalServiceError('minicpm-video', `Modal internal failure: ${error.message}`, {
      retryable: true,
      cause: error,
    });
  }
  if (error instanceof FunctionTimeoutError) {
    return new ExternalServiceError('minicpm-video', `MiniCPM analyze exceeded its Modal timeout: ${error.message}`, {
      retryable: false,
      cause: error,
    });
  }
  if (error instanceof NotFoundError) {
    return new ExternalServiceError(
      'minicpm-video',
      `Modal cannot find ${env.MODAL_APP_NAME}/${env.MODAL_CLASS_NAME} — check the app name, environment, and that Clipit's token may see it (${error.message})`,
      { retryable: false, cause: error },
    );
  }
  if (error instanceof ExecutionError || error instanceof RemoteError || error instanceof InvalidError) {
    return new ExternalServiceError('minicpm-video', `MiniCPM analyze failed remotely: ${error.message}`, {
      retryable: false,
      cause: error,
    });
  }
  const message = (error as Error).message ?? String(error);
  // Anything smelling of credentials is configuration: retrying knocks on a
  // locked door and each knock is an audit-log entry.
  if (/auth|credential|token|permission|unauthenticated|unauthorized/i.test(message)) {
    return new ExternalServiceError(
      'minicpm-video',
      `Modal rejected Clipit's credentials — check MODAL_TOKEN_ID/MODAL_TOKEN_SECRET (${message})`,
      { retryable: false, cause: error },
    );
  }
  // The remainder is transport: gRPC drops, DNS, resets. Worth another try.
  return new ExternalServiceError('minicpm-video', `Modal call failed: ${message}`, {
    retryable: true,
    cause: error,
  });
}

export async function askMiniCpmVideo(
  input: VideoModelRequest & { videoStorageKey: string },
): Promise<VideoModelAnswer> {
  if (!env.MODAL_TOKEN_ID || !env.MODAL_TOKEN_SECRET) {
    // Startup validation makes this unreachable in a real process; it exists
    // so a misconfigured test can never mint an anonymous client.
    throw new ExternalServiceError('minicpm-video', 'MiniCPM provider is not configured', { retryable: false });
  }

  return minicpmLimiter.run(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= env.MINICPM_MAX_RETRIES; attempt += 1) {
      try {
        return await requestOnce(input);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ExternalServiceError && error.retryable;
        if (!retryable || attempt === env.MINICPM_MAX_RETRIES) break;
        const delayMs = Math.min(30_000, 1_000 * 2 ** attempt);
        logger.warn('retrying MiniCPM call', {
          purpose: input.purpose,
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

async function requestOnce(input: VideoModelRequest & { videoStorageKey: string }): Promise<VideoModelAnswer> {
  // Signed per attempt, so a retry after a backoff never carries an expired
  // URL. Lifetime matches the request allowance: long enough for a cold
  // container to pull the model and then fetch the chunk, gone right after.
  const videoUrl = await getStorage().createDownloadUrl(input.videoStorageKey, {
    expiresInSeconds: env.MINICPM_REQUEST_TIMEOUT_SECONDS,
  });

  const startedAt = performance.now();

  let method: Function_;
  try {
    method = await lookupMethod();
  } catch (error) {
    methodCache = null;
    throw classify(error);
  }

  let payload: MiniCpmResult;
  try {
    payload = await withDeadline(
      method.remote([], { video_url: videoUrl, prompt: promptFromRequest(input) }) as Promise<MiniCpmResult>,
      env.MINICPM_REQUEST_TIMEOUT_SECONDS * 1000,
    );
  } catch (error) {
    // A stale handle from a Modal redeploy answers not-found. One fresh
    // lookup, one more call — inside this same attempt, not a retry.
    if (error instanceof NotFoundError) {
      resetMiniCpmClient();
      try {
        method = await lookupMethod();
        payload = await withDeadline(
          method.remote([], { video_url: videoUrl, prompt: promptFromRequest(input) }) as Promise<MiniCpmResult>,
          env.MINICPM_REQUEST_TIMEOUT_SECONDS * 1000,
        );
      } catch (secondError) {
        throw classify(secondError);
      }
    } else {
      throw classify(error);
    }
  }

  const latencyMs = Math.round(performance.now() - startedAt);
  const content = payload?.result;

  logger.info('MiniCPM call complete', {
    provider: 'modal',
    model: payload?.model ?? 'openbmb/MiniCPM-V-4.6',
    app: env.MODAL_APP_NAME,
    purpose: input.purpose,
    chunkIndex: input.chunkIndex,
    videoDurationSeconds: input.chunkDurationSeconds,
    latencyMs,
    answerChars: typeof content === 'string' ? content.length : 0,
    // Whatever the deployment measured about itself — GPU seconds live here
    // eventually, and this is the trail cost-per-source-hour is built from.
    metrics: payload?.metrics ?? null,
  });

  // Zero tokens with a null cost, not silence: the call happened, it held a
  // GPU for latencyMs, and the usage table is how anything is ever priced.
  // The deployment's own measurements ride along verbatim — download_ms,
  // inference_ms, total_ms — because cost-per-source-hour is computed from
  // rows, and a number that only ever reached a log line prices nothing.
  input.onUsage?.({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    costUsd: null,
    latencyMs,
    provider: 'modal',
    model: payload?.model ?? 'openbmb/MiniCPM-V-4.6',
    metrics: payload?.metrics ?? null,
    startedAt: new Date(Date.now() - latencyMs),
    promptVersion: promptVersion(input.systemPrompt),
  });

  // The same rule as the OpenRouter path: a blank answer must never parse as
  // a considered "no moments here".
  if (typeof content !== 'string' || content.trim() === '') {
    throw new ExternalServiceError('minicpm-video', 'MiniCPM returned an empty result', { retryable: false });
  }

  return {
    content,
    reasoningDisabled: false,
    provider: 'modal',
    model: payload?.model ?? 'openbmb/MiniCPM-V-4.6',
    promptVersion: promptVersion(input.systemPrompt),
  };
}

/**
 * A client-side deadline over the remote call. It cannot cancel work already
 * running on the GPU — Modal's own function timeout bounds that — but it
 * stops a chunk from hanging the pipeline when the connection quietly dies.
 */
async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new ExternalServiceError('minicpm-video', `MiniCPM call exceeded the ${Math.round(ms / 1000)}s client deadline`, {
            retryable: false,
          }),
        ),
      ms,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}
