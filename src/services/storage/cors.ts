import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { getStorage } from './s3.js';

/**
 * Origins permitted to upload straight to the bucket.
 *
 * Defaults to whatever may call the API, since that is precisely the set of
 * origins that will be issuing uploads.
 */
export function uploadCorsOrigins(): string[] {
  const configured = env.BUCKET_CORS_ORIGINS ?? env.API_CORS_ORIGIN;
  return configured
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

/**
 * Applies the bucket's upload CORS rule at boot.
 *
 * Deliberately non-fatal. Some deployments hand the API credentials that can
 * read and write objects but not modify bucket policy, and refusing to start
 * would be a worse outcome than uploads failing — every other route still
 * works. It logs loudly enough to be findable either way, because the browser
 * side of this failure reports no status code at all.
 */
export async function ensureUploadCors(): Promise<void> {
  if (!env.BUCKET_CORS_AUTOCONFIGURE) return;

  const storage = getStorage();

  // While configuring the bucket anyway: sweep multipart uploads nobody ever
  // completed. Their parts are stored and billed but invisible to listings,
  // and DeleteObject cannot reach them — only an abort or this rule can.
  if (storage.ensureAbandonedUploadLifecycle) {
    try {
      await storage.ensureAbandonedUploadLifecycle();
      logger.info('abandoned-multipart lifecycle rule applied');
    } catch (cause) {
      logger.warn('could not apply abandoned-multipart lifecycle rule', { error: errorMessage(cause) });
    }
  }

  if (!storage.ensureUploadCors) return;

  const origins = uploadCorsOrigins();
  if (origins.length === 0) {
    logger.warn('no upload CORS origins resolved; browser uploads will be blocked');
    return;
  }

  try {
    await storage.ensureUploadCors(origins);
    logger.info('bucket upload CORS configured', { bucket: env.BUCKET_NAME, origins });
  } catch (error) {
    logger.error(
      'could not configure bucket CORS — browser uploads will fail with no status code until this is set manually',
      { bucket: env.BUCKET_NAME, origins, err: errorMessage(error) },
    );
  }
}
