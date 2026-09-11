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

export interface ModalTarget {
  app: string;
  className: string;
  method: string;
  label: string;
}

let client: ModalClient | null = null;
const handles = new Map<string, Promise<Function_>>();
const gate = new Semaphore(4);

function modalClient(): ModalClient {
  client ??= new ModalClient({
    tokenId: env.MODAL_TOKEN_ID!,
    tokenSecret: env.MODAL_TOKEN_SECRET!,
    environment: env.MODAL_ENVIRONMENT,
  });
  return client;
}

function key(target: ModalTarget): string {
  return `${target.app}/${target.className}/${target.method}`;
}

function lookup(target: ModalTarget): Promise<Function_> {
  const cacheKey = key(target);
  let handle = handles.get(cacheKey);
  if (!handle) {
    handle = (async () => {
      const cls = await modalClient().cls.fromName(target.app, target.className);
      const instance = await cls.instance();
      return instance.method(target.method);
    })();
    handles.set(cacheKey, handle);
  }
  return handle;
}

export function resetModalHandles(): void {
  client = null;
  handles.clear();
}

function classify(target: ModalTarget, error: unknown): ExternalServiceError {
  if (error instanceof ExternalServiceError) return error;
  if (error instanceof InternalFailure) {
    return new ExternalServiceError(target.label, `Modal internal failure: ${error.message}`, { retryable: true, cause: error });
  }
  if (error instanceof FunctionTimeoutError) {
    return new ExternalServiceError(target.label, `${target.method} exceeded its Modal timeout: ${error.message}`, {
      retryable: false,
      cause: error,
    });
  }
  if (error instanceof NotFoundError) {
    return new ExternalServiceError(
      target.label,
      `Modal cannot find ${target.app}/${target.className} in ${env.MODAL_ENVIRONMENT} (${error.message})`,
      { retryable: false, cause: error },
    );
  }
  if (error instanceof ExecutionError || error instanceof RemoteError || error instanceof InvalidError) {
    return new ExternalServiceError(target.label, `${target.method} failed remotely: ${error.message}`, {
      retryable: false,
      cause: error,
    });
  }
  const message = (error as Error)?.message ?? String(error);
  if (/auth|credential|token|permission|unauthenticated|unauthorized/i.test(message)) {
    return new ExternalServiceError(target.label, `Modal rejected Clipit's credentials (${message})`, {
      retryable: false,
      cause: error,
    });
  }
  return new ExternalServiceError(target.label, `Modal call failed: ${message}`, { retryable: true, cause: error });
}

async function withDeadline<T>(promise: Promise<T>, ms: number, target: ModalTarget): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ExternalServiceError(target.label, `${target.method} exceeded the ${Math.round(ms / 1000)}s client deadline`, {
        retryable: false,
      })),
      ms,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

async function once<T>(target: ModalTarget, kwargs: Record<string, unknown>, timeoutMs: number): Promise<T> {
  let method: Function_;
  try {
    method = await lookup(target);
  } catch (error) {
    handles.delete(key(target));
    throw classify(target, error);
  }

  try {
    return await withDeadline(method.remote([], kwargs) as Promise<T>, timeoutMs, target);
  } catch (error) {
    if (error instanceof NotFoundError) {
      handles.delete(key(target));
      try {
        const fresh = await lookup(target);
        return await withDeadline(fresh.remote([], kwargs) as Promise<T>, timeoutMs, target);
      } catch (secondError) {
        throw classify(target, secondError);
      }
    }
    throw classify(target, error);
  }
}

export async function assertModalTargetAvailable(target: ModalTarget): Promise<void> {
  if (!env.MODAL_TOKEN_ID || !env.MODAL_TOKEN_SECRET) {
    throw new ExternalServiceError(target.label, `${target.label} is not configured`, { retryable: false });
  }
  try {
    await lookup(target);
  } catch (error) {
    handles.delete(key(target));
    throw classify(target, error);
  }
}

export async function invokeModal<T>(
  target: ModalTarget,
  kwargs: Record<string, unknown>,
  options: {
    timeoutSeconds?: number;
    maxRetries?: number;
    context?: Record<string, unknown>;
  } = {},
): Promise<T> {
  if (!env.MODAL_TOKEN_ID || !env.MODAL_TOKEN_SECRET) {
    throw new ExternalServiceError(target.label, `${target.label} is not configured`, { retryable: false });
  }

  const timeoutMs = (options.timeoutSeconds ?? 900) * 1000;
  const maxRetries = options.maxRetries ?? 2;

  return gate.run(async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await once<T>(target, kwargs, timeoutMs);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ExternalServiceError && error.retryable;
        if (!retryable || attempt === maxRetries) break;
        const delayMs = Math.min(30_000, 1_000 * 2 ** attempt);
        logger.warn('retrying Modal call', {
          service: target.label,
          method: target.method,
          attempt: attempt + 1,
          delayMs,
          ...options.context,
        });
        await sleep(delayMs);
      }
    }
    throw lastError;
  });
}
