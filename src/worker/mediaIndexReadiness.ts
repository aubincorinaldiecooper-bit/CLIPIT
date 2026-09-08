import { env } from '../config/env.js';
import { ExternalServiceError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { assertMediaIndexDeploymentsAvailable } from '../services/mediaIndex/qwen.js';
import { resetModalHandles } from '../services/modal/invoke.js';

/**
 * Whether videos can actually be read into vectors — asked once, at startup.
 *
 * Asked here rather than discovered one upload at a time. Modal does not start
 * a GPU to answer whether a deployment exists, so it costs nothing, and it
 * turns "every video fails to index, hours apart, for reasons nobody reads"
 * into one line naming exactly what is missing.
 *
 * NOTHING IN HERE IS FATAL, unlike the MiniCPM check in the worker entrypoint,
 * and the difference is what each is load-bearing for. MiniCPM is how this
 * product watches video: without it there is no search worth running, so
 * refusing to boot is honest. The Media Index only ADDS a way to answer —
 * every question it cannot take still has the notes and the footage behind it.
 * Stopping the worker over it would halt ingestion, transcription, search and
 * rendering for a feature none of them need, trading a degraded extra for a
 * total outage. That applies to a missing credential exactly as it applies to
 * a missing deployment: both mean this one feature cannot run, and neither
 * means the product cannot.
 *
 * On failure the caller leaves the queue unconsumed rather than consuming it
 * badly — a job that fails on every attempt still burns its retries and still
 * writes a failure row per upload. Jobs already queued keep waiting, and a
 * later boot that finds Modal healthy picks them up: delayed, not lost.
 *
 * Lives in its own module so it can be tested. The worker entrypoint runs on
 * import, so anything defined there is reachable only by starting a worker.
 */
/**
 * How long one readiness probe may take before it counts as a no.
 *
 * This runs before any queue consumer starts, and resolving a Modal deployment
 * awaits two network calls with no deadline of their own. A stalled lookup
 * would therefore hold ingestion, transcription, search and rendering — every
 * queue, none of which need the index — behind an optional feature's health
 * check, for as long as the socket stayed open. Making the check non-fatal did
 * not make it non-blocking; this does.
 */
const PROBE_TIMEOUT_MS = 15_000;

/** Resolves to the promise's value, or rejects once the deadline passes. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
        timer.unref();
      }),
    ]);
  } finally {
    // The losing timer is always cleared, so a slow-but-successful probe does
    // not leave a pending rejection behind it.
    if (timer) clearTimeout(timer);
  }
}

/**
 * One probe, bounded, leaving nothing behind that would poison the next one.
 *
 * The deadline alone is not enough. The Modal client caches the promise for a
 * deployment lookup so repeat calls share one handle — which is right for
 * inference, and wrong here: abandoning the await on a timeout leaves that
 * pending promise in the cache, so every later probe adopts the SAME hung
 * lookup and times out again. Modal could come back and the watch would never
 * notice, which would quietly defeat the recovery it exists to provide.
 *
 * So a timed-out probe drops the cached handles. The cache holds media-index
 * targets only — MiniCPM keeps its own, in minicpmVideo.ts — so this costs one
 * fresh lookup next time and nothing else.
 */
async function probeWithin(timeoutMs: number): Promise<void> {
  try {
    await withDeadline(assertMediaIndexDeploymentsAvailable(), timeoutMs);
  } catch (error) {
    resetModalHandles();
    throw error;
  }
}

/**
 * Keep asking, when Modal was down at boot.
 *
 * The startup check retries over a few seconds, which covers a blip during a
 * deploy but not an outage lasting minutes. Without this, such an outage
 * leaves indexing off for the process's whole lifetime while uploads keep
 * queueing work nothing consumes — and recovery needs a human to notice and
 * restart a worker that looks entirely healthy.
 *
 * Stops the moment it succeeds, so `onReady` runs exactly once and no consumer
 * is ever started twice. Unref'd, so a worker shutting down is never held open
 * by a probe for an optional feature.
 */
export function watchMediaIndexRecovery(
  onReady: () => void,
  options: { intervalMs?: number; check?: () => Promise<boolean> } = {},
): { stop: () => void } {
  const intervalMs = options.intervalMs ?? env.MEDIA_INDEX_RECHECK_INTERVAL_MS;
  const check = options.check ?? mediaIndexReadiness;

  // setTimeout after each check settles, NOT setInterval. An interval fires on
  // the clock whether or not the last check came back, and a readiness check
  // is a network call that can outlast it — so several would run at once, and
  // clearing the timer would not cancel the ones already in flight. Each of
  // those resolving true calls onReady, which starts a second consumer on the
  // same queue and doubles the GPU concurrency the operator configured.
  //
  // Chaining makes overlap impossible rather than unlikely, and `settled`
  // makes onReady once-only rather than once-if-the-timing-cooperates.
  let settled = false;
  let timer: NodeJS.Timeout | null = null;

  const scheduleNext = (): void => {
    if (settled) return;
    timer = setTimeout(runCheck, intervalMs);
    // Never hold a shutting-down worker open for a probe of an optional
    // feature.
    timer.unref();
  };

  const runCheck = (): void => {
    void check()
      .then((ready) => {
        if (settled) return;
        if (!ready) {
          scheduleNext();
          return;
        }
        // Set BEFORE onReady, so a throw while starting the consumer cannot
        // leave the watch alive to start a second one.
        settled = true;
        onReady();
      })
      .catch((error: unknown) => {
        // Never let a rejected probe take the worker down: this is background
        // work for an optional feature and everything else here is working.
        // Keep watching, too — one bad probe ending the watch would be the
        // permanent outage this exists to prevent.
        logger.warn('media index readiness re-check failed', { err: error });
        scheduleNext();
      });
  };

  scheduleNext();
  return {
    stop: () => {
      settled = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export async function mediaIndexReadiness(
  options: { probeTimeoutMs?: number } = {},
): Promise<boolean> {
  if (!env.MEDIA_INDEX_ENABLED) return false;

  const naming = {
    environment: env.MODAL_ENVIRONMENT,
    embedApp: env.MEDIA_INDEX_EMBED_APP,
    rerankApp: env.MEDIA_INDEX_RERANK_APP,
  };

  if (!env.MODAL_TOKEN_ID || !env.MODAL_TOKEN_SECRET) {
    logger.error('MEDIA_INDEX_ENABLED is on but the Modal credentials are missing; videos will NOT be read into vectors', {
      ...naming,
      remedy: 'set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET on the worker, or set MEDIA_INDEX_ENABLED=false',
    });
    return false;
  }

  // Retried, because the first answer is not always the true one. Modal's own
  // internal errors and transport failures are classified retryable by the
  // client, and a single blip during a deploy would otherwise leave indexing
  // off until somebody happened to restart the worker — silently, while
  // uploads keep queueing. Bounded and short: this runs before the worker
  // reports ready, so it must not become a reason the worker never does.
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await probeWithin(options.probeTimeoutMs ?? PROBE_TIMEOUT_MS);
      logger.info('media index deployments available', naming);
      return true;
    } catch (error) {
      // A name that does not resolve will not resolve on the third try either.
      // Only Modal's own weather is worth waiting out.
      const worthRetrying = !(error instanceof ExternalServiceError) || error.retryable;
      if (worthRetrying && attempt < attempts) {
        const backoffMs = 2_000 * attempt;
        logger.warn('media index deployments did not resolve; retrying', {
          ...naming,
          attempt,
          backoffMs,
          err: error,
        });
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      // error, not warn: this is switched ON and not working. It must not read
      // as routine, and it must name the remedy rather than the symptom.
      logger.error('MEDIA_INDEX_ENABLED is on but its Modal services could not be resolved; videos will NOT be read into vectors', {
        ...naming,
        attempts: attempt,
        remedy: 'deploy both Modal apps, or set MEDIA_INDEX_ENABLED=false to stop asking for them',
        err: error,
      });
      return false;
    }
  }
  return false;
}
