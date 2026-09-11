import type { Logger } from '../lib/logger.js';
import {
  clearThumbnailsForVideo,
  listThumbnailKeysForVideo,
} from '../db/repositories/clipRequests.js';
import { clearClipKeysForVideo, listClipKeysForVideo } from '../db/repositories/clips.js';
import { clearVariantsForVideo, listVariantKeysForVideo } from '../db/repositories/clipVariants.js';
import { deleteSimpleMemIndex } from '../db/repositories/simplememIndex.js';
import { env } from '../config/env.js';
import { simplememDeleteVideo } from './retrieval/simplemem/client.js';
import { deleteTranscript } from '../db/repositories/transcripts.js';
import {
  claimFootageForExpiry,
  getVideo,
  listChunks,
  markFootageExpired,
  releaseFootageClaim,
} from '../db/repositories/videos.js';
import { getStorage } from './storage/s3.js';

export type ExpiryOutcome = 'removed' | 'already-removed' | 'in-progress' | 'refused';

export interface ExpiryResult {
  outcome: ExpiryOutcome;
  objectsDeleted: number;
  objectsFailed: number;
}

export interface ExpiryOptions {
  onlyIfUnowned: boolean;
}

export async function expireVideoFootage(videoId: string, log: Logger, options: ExpiryOptions): Promise<ExpiryResult> {
  const claimedAt = await claimFootageForExpiry(videoId, { onlyIfUnowned: options.onlyIfUnowned });
  if (!claimedAt) {
    const video = await getVideo(videoId);
    const outcome: ExpiryOutcome = !video
      ? 'refused'
      : video.footageExpiredAt
        ? 'already-removed'
        : video.footageClaimedAt
          ? 'in-progress'
          : 'refused';
    log.info('footage not removed by this request', { videoId, outcome });
    return { outcome, objectsDeleted: 0, objectsFailed: 0 };
  }
  try {
    return { outcome: 'removed', ...(await removeClaimedFootage(videoId, log)) };
  } catch (error) {
    await releaseFootageClaim(videoId, claimedAt).catch((releaseError: unknown) => {
      log.warn('could not release the footage claim after a failed removal', { videoId, err: releaseError });
    });
    throw error;
  }
}

async function removeClaimedFootage(
  videoId: string,
  log: Logger,
): Promise<{ objectsDeleted: number; objectsFailed: number }> {
  const video = await getVideo(videoId);
  if (!video) return { objectsDeleted: 0, objectsFailed: 0 };

  const chunks = await listChunks(videoId);
  const [clipKeys, thumbnailKeys, variantKeys] = await Promise.all([
    listClipKeysForVideo(videoId),
    listThumbnailKeysForVideo(videoId),
    listVariantKeysForVideo(videoId),
  ]);

  const keys = [
    video.originalStorageKey,
    video.proxyStorageKey,
    video.playbackStorageKey,
    video.captionsStorageKey,
    ...chunks.map((chunk) => chunk.storageKey),
    ...clipKeys,
    ...thumbnailKeys,
    ...variantKeys,
  ].filter((key): key is string => typeof key === 'string' && key.length > 0);

  let objectsDeleted = 0;
  let objectsFailed = 0;

  for (const key of keys) {
    try {
      await getStorage().remove(key);
      objectsDeleted += 1;
    } catch (error) {
      objectsFailed += 1;
      log.warn('could not delete stored object', { videoId, key, err: error });
    }
  }

  // Transcript is derived data. SimpleMem's durable archive is
  // deleted through the sidecar; if that fails, release the claim so retention
  // retries rather than leaving a durable visual memory behind.
  await deleteTranscript(videoId);
  if (env.SIMPLEMEM_URL) {
    try {
      await simplememDeleteVideo(videoId);
    } catch (error) {
      log.warn('SimpleMem durable memory could not be fully deleted; retention will retry', { videoId, err: error });
      throw error;
    }
  }
  await deleteSimpleMemIndex(videoId);
  await clearThumbnailsForVideo(videoId);
  await clearClipKeysForVideo(videoId);
  await clearVariantsForVideo(videoId);
  await markFootageExpired(videoId);

  log.info('footage removed', {
    videoId,
    objectsDeleted,
    objectsFailed,
    chunks: chunks.length,
    clips: clipKeys.length,
    stills: thumbnailKeys.length,
    shapes: variantKeys.length,
  });

  return { objectsDeleted, objectsFailed };
}
