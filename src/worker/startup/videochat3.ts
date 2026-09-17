import { errorMessage } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { assertVideoChat3Ready } from '../../services/videochat3/client.js';

export type VideoChat3StartupDiagnosis =
  | 'modal_deployment_contract_mismatch'
  | 'modal_auth_failure'
  | 'videochat3_unavailable';

export function diagnoseVideoChat3StartupFailure(reason: string): VideoChat3StartupDiagnosis {
  if (/not found on class|cannot find \S+\/\S+ in /i.test(reason)) {
    return 'modal_deployment_contract_mismatch';
  }
  if (/auth|credential|token|permission|unauthenticated|unauthorized/i.test(reason)) {
    return 'modal_auth_failure';
  }
  return 'videochat3_unavailable';
}

/**
 * Verify the exact Modal method internet video search needs before the worker
 * starts consuming jobs.
 *
 * This deliberately resolves only the method handle; it does not invoke the
 * model or warm a GPU. The Modal layer caches the handle, so the per-search
 * readiness check reuses this result instead of adding another lookup.
 */
export async function assertVideoChat3WorkerReady(
  check: () => Promise<void> = () => assertVideoChat3Ready('watch_stream'),
): Promise<void> {
  const startedAt = Date.now();

  try {
    await check();
    logger.info('VideoChat3 worker startup contract verified', {
      dependency: 'videochat3',
      modal_app: 'clipit-videochat3',
      modal_class: 'VideoChat3Service',
      required_method: 'watch_stream',
      diagnosis: 'ok',
      check_ms: Date.now() - startedAt,
    });
  } catch (error) {
    const reason = errorMessage(error);
    const diagnosis = diagnoseVideoChat3StartupFailure(reason);

    logger.error('VideoChat3 worker startup contract check failed', {
      dependency: 'videochat3',
      modal_app: 'clipit-videochat3',
      modal_class: 'VideoChat3Service',
      required_method: 'watch_stream',
      diagnosis,
      reason,
      remediation:
        diagnosis === 'modal_deployment_contract_mismatch'
          ? 'Deploy modal/videochat3.py to the configured Modal environment; the live deployment is missing the worker contract.'
          : 'Restore the VideoChat3 Modal dependency before starting internet video search.',
      check_ms: Date.now() - startedAt,
    });

    throw new Error(`VideoChat3 worker startup check failed [${diagnosis}]: ${reason}`);
  }
}
