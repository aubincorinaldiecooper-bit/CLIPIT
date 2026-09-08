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

/**
 * Calling one of Clipit's own Modal deployments.
 *
 * The MiniCPM client wrote all of this once, for one app, one class and one
 * method. The Media Index needs the same behaviour against two more — the
 * Qwen embedding service and the Qwen reranker — and a second and third copy
 * of retry classification is how three services end up disagreeing about what
 * a transport failure is. So it lives here, once, taking the app and class as
 * arguments. (`minicpmVideo.ts` keeps its own copy for now: folding the
 * working video path into this belongs in its own change, not in the one that
 * introduces the thing it would fold into.)
 *
 * Everything the MiniCPM client learned in production is preserved:
 *
 *  - explicit credentials and an explicit environment, because relying on the
 *    SDK's ambient behaviour once made a correctly deployed class look absent;
 *  - the resolved handle cached, because lookup is its own round trip, and
 *    dropped on a not-found so a redeploy heals on the next call;
 *  - a client-side deadline, which cannot stop work already running on the GPU
 *    but does stop a dead connection from hanging a job forever;
 *  - retries only for what Modal documents as retryable.
 */

export interface ModalTarget {
  /** Deployed app name, e.g. 'clipit-embedding'. */
  app: string;
  /** Deployed class name, e.g. 'QwenEmbeddingService'. */
  className: string;
  /** Method on that class. Part of the contract, so it is code, not config. */
  method: string;
  /** Names the service in errors, logs and usage rows. */
  label: string;
}

let client: ModalClient | null = null;
const handles = new Map<string, Promise<Function_>>();

function modalClient(): ModalClient {
  client ??= new ModalClient({
    tokenId: env.MODAL_TOKEN_ID!,
    tokenSecret: env.MODAL_TOKEN_SECRET!,
    environment: env.MODAL_ENVIRONMENT,
  });
  return client;
}

function handleKey(target: ModalTarget): string {
  return `${target.app}/${target.className}/${target.method}`;
}

function lookup(target: ModalTarget): Promise<Function_> {
  const key = handleKey(target);
  let handle = handles.get(key);
  if (!handle) {
    handle = (async () => {
      const cls = await modalClient().cls.fromName(target.app, target.className);
      const instance = await cls.instance();
      return instance.method(target.method);
    })();
    handles.set(key, handle);
  }
  return handle;
}

/** Test seam, and what a not-found calls to force a fresh lookup. */
export function resetModalHandles(): void {
  // Drops the cache. Deliberately does NOT close the client: it is shared with
  // every search in flight, and closing it would abort their calls. See
  // probeModalTarget for why the health check no longer needs that.
  client = null;
  handles.clear();
}

/**
 * Is this deployment resolvable? Asked on a client of this probe's own.
 *
 * A health check must not borrow the client that serves live traffic, and this
 * one went through two wrong answers before that was obvious.
 *
 * Sharing the cached handle meant a lookup that hung was adopted by every
 * later probe, so Modal could recover and the watch would never notice.
 * Clearing the cache fixed that and left the abandoned call running, one per
 * retry, each holding a connection. Closing the shared client on the way out
 * ended those calls — and every search's call with them, because the recovery
 * watch runs in the same process as the clip-search worker. A failed health
 * check would have cancelled a person's search and sent it to the slow path.
 *
 * A client per probe ends all three. Nothing is cached, so nothing is
 * poisoned; the client is closed in `finally`, so a hung lookup is ended
 * rather than abandoned; and it was never anyone else's client, so no search
 * notices. The cost is one connection set up and torn down per probe, which is
 * the right price for a check that runs once a minute at worst.
 */
export async function probeModalTarget(target: ModalTarget, timeoutMs: number): Promise<void> {
  if (!env.MODAL_TOKEN_ID || !env.MODAL_TOKEN_SECRET) {
    throw new ExternalServiceError(target.label, `${target.label} is not configured`, { retryable: false });
  }

  const probe = new ModalClient({
    tokenId: env.MODAL_TOKEN_ID,
    tokenSecret: env.MODAL_TOKEN_SECRET,
    environment: env.MODAL_ENVIRONMENT,
  });

  /**
   * The deadline lives HERE, holding the client, and not in a Promise.race
   * around this call.
   *
   * A race abandons the wait; it does not touch the work. The await below
   * stays suspended, so the `finally` never runs and the client is never
   * closed — measured, not assumed: a finally after an await on a promise that
   * never settles does not execute when the caller races out. Every startup
   * retry and every recovery cycle would leave another client and another open
   * call behind, which is the leak this whole design was meant to end.
   *
   * Closing the client is the cancellation. The pending lookup rejects
   * (ClientClosedError), which unwinds this function normally and lets the
   * cleanup run — so the deadline ends the work rather than merely giving up
   * on hearing about it.
   */
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    try {
      probe.close();
    } catch {
      // Nothing to do: the point was to end the call, and a client that
      // refuses to close is already unusable.
    }
  }, timeoutMs);
  deadline.unref();

  try {
    const cls = await probe.cls.fromName(target.app, target.className);
    const instance = await cls.instance();
    instance.method(target.method);
  } catch (error) {
    // A close that ended the lookup surfaces as whatever the SDK throws for a
    // closed client, which says nothing useful about the deployment. Report
    // the timeout instead, and as retryable: a probe that ran out of time has
    // not established that anything is wrong with the app.
    if (timedOut) {
      throw new ExternalServiceError(
        target.label,
        `Modal did not resolve ${target.app}/${target.className} within ${timeoutMs}ms`,
        { retryable: true, cause: error },
      );
    }
    const failure = classify(target, error);
    if (!failure.retryable) {
      throw new ExternalServiceError(
        target.label,
        `Modal cannot resolve ${target.app}/${target.className}.${target.method} in environment ` +
          `${env.MODAL_ENVIRONMENT}. Check the app name, the class name, and that Clipit's token may see it.`,
        { retryable: false, cause: failure },
      );
    }
    throw failure;
  } finally {
    clearTimeout(deadline);
    // Ends this probe's own call whether it answered or failed. Already closed
    // when the deadline fired; closing twice is why this is swallowed.
    try {
      probe.close();
    } catch {
      // Already closed, or closing threw. Either way this client is going.
    }
  }
}

/**
 * Resolves a deployment without invoking it. Modal does not start the GPU
 * until a method is actually called, so this turns a wrong app name into one
 * startup error rather than one failure per window of every video.
 */
export async function assertModalTargetAvailable(target: ModalTarget): Promise<void> {
  if (!env.MODAL_TOKEN_ID || !env.MODAL_TOKEN_SECRET) {
    throw new ExternalServiceError(target.label, `${target.label} is not configured`, { retryable: false });
  }
  try {
    await lookup(target);
  } catch (error) {
    handles.delete(handleKey(target));
    const failure = classify(target, error);
    if (!failure.retryable) {
      throw new ExternalServiceError(
        target.label,
        `Modal cannot resolve ${target.app}/${target.className}.${target.method} in environment ` +
          `${env.MODAL_ENVIRONMENT}. Check the app name, the class name, and that Clipit's token may see it.`,
        { retryable: false, cause: failure },
      );
    }
    throw failure;
  }
}

/**
 * What went wrong, in the terms the retry loop understands. Lifted verbatim in
 * spirit from the MiniCPM client: an internal failure is Modal's own weather
 * and worth another try; a function timeout means the remote method overran
 * its own limit and would overrun it again at full GPU price; a not-found is a
 * name or a permission, which retrying cannot fix.
 */
function classify(target: ModalTarget, error: unknown): ExternalServiceError {
  if (error instanceof ExternalServiceError) return error;
  if (error instanceof InternalFailure) {
    return new ExternalServiceError(target.label, `Modal internal failure: ${error.message}`, {
      retryable: true, cause: error,
    });
  }
  if (error instanceof FunctionTimeoutError) {
    return new ExternalServiceError(target.label, `${target.method} exceeded its Modal timeout: ${error.message}`, {
      retryable: false, cause: error,
    });
  }
  if (error instanceof NotFoundError) {
    return new ExternalServiceError(
      target.label,
      `Modal cannot find ${target.app}/${target.className} — check the name, the environment, and Clipit's token (${error.message})`,
      { retryable: false, cause: error },
    );
  }
  if (error instanceof ExecutionError || error instanceof RemoteError || error instanceof InvalidError) {
    return new ExternalServiceError(target.label, `${target.method} failed remotely: ${error.message}`, {
      retryable: false, cause: error,
    });
  }
  const message = (error as Error)?.message ?? String(error);
  if (/auth|credential|token|permission|unauthenticated|unauthorized/i.test(message)) {
    return new ExternalServiceError(
      target.label,
      `Modal rejected Clipit's credentials — check MODAL_TOKEN_ID/MODAL_TOKEN_SECRET (${message})`,
      { retryable: false, cause: error },
    );
  }
  return new ExternalServiceError(target.label, `Modal call failed: ${message}`, { retryable: true, cause: error });
}

const gate = new Semaphore(env.MEDIA_INDEX_CONCURRENCY);

export interface InvokeOptions {
  timeoutSeconds?: number;
  maxRetries?: number;
  /** Included in the retry log so a stuck video is identifiable. */
  context?: Record<string, unknown>;
}

/**
 * One call to a deployed Modal method, with the retries and the deadline.
 *
 * Gated by a semaphore because every concurrent call can hold its own GPU, and
 * unlike a token-priced API the bill here is per second of hardware. Widening
 * that is a cost decision made with numbers, not a default.
 */
export async function invokeModal<T>(
  target: ModalTarget,
  kwargs: Record<string, unknown>,
  options: InvokeOptions = {},
): Promise<T> {
  if (!env.MODAL_TOKEN_ID || !env.MODAL_TOKEN_SECRET) {
    throw new ExternalServiceError(target.label, `${target.label} is not configured`, { retryable: false });
  }

  const timeoutMs = (options.timeoutSeconds ?? env.MEDIA_INDEX_REQUEST_TIMEOUT_SECONDS) * 1000;
  const maxRetries = options.maxRetries ?? env.MEDIA_INDEX_MAX_RETRIES;

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
          service: target.label, method: target.method, attempt: attempt + 1, delayMs, ...options.context,
        });
        await sleep(delayMs);
      }
    }
    throw lastError;
  });
}

async function once<T>(target: ModalTarget, kwargs: Record<string, unknown>, timeoutMs: number): Promise<T> {
  let method: Function_;
  try {
    method = await lookup(target);
  } catch (error) {
    handles.delete(handleKey(target));
    throw classify(target, error);
  }

  try {
    return await withDeadline(method.remote([], kwargs) as Promise<T>, timeoutMs, target);
  } catch (error) {
    // A handle stranded by a redeploy answers not-found. One fresh lookup and
    // one more call, inside this same attempt rather than as a retry.
    if (error instanceof NotFoundError) {
      handles.delete(handleKey(target));
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

async function withDeadline<T>(promise: Promise<T>, ms: number, target: ModalTarget): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ExternalServiceError(
        target.label, `${target.method} exceeded the ${Math.round(ms / 1000)}s client deadline`, { retryable: false },
      )),
      ms,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}
