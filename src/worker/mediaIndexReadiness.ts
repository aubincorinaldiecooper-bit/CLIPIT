import { env } from '../config/env.js';
import { ExternalServiceError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { assertMediaIndexDeploymentsAvailable } from '../services/mediaIndex/qwen.js';

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
): NodeJS.Timeout {
  const check = options.check ?? mediaIndexReadiness;
  const timer = setInterval(() => {
    void check()
      .then((ready) => {
        if (!ready) return;
        // Cleared BEFORE onReady: if starting the consumer throws, the timer
        // is already gone rather than firing again and starting a second one.
        clearInterval(timer);
        onReady();
      })
      .catch((error: unknown) => {
        // Never let a rejected probe take the worker down. This is background
        // work for an optional feature, and everything else here is working.
        logger.warn('media index readiness re-check failed', { err: error });
      });
  }, options.intervalMs ?? env.MEDIA_INDEX_RECHECK_INTERVAL_MS);
  timer.unref();
  return timer;
}

export async function mediaIndexReadiness(): Promise<boolean> {
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
      await assertMediaIndexDeploymentsAvailable();
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
