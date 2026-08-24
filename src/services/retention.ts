import type { Logger } from '../lib/logger.js';
import {
  clearThumbnailsForVideo,
  listThumbnailKeysForVideo,
} from '../db/repositories/clipRequests.js';
import { clearClipKeysForVideo, listClipKeysForVideo } from '../db/repositories/clips.js';
import { clearVariantsForVideo, listVariantKeysForVideo } from '../db/repositories/clipVariants.js';
import { deleteScenes } from '../db/repositories/scenes.js';
import { deleteTranscript } from '../db/repositories/transcripts.js';
import { getVideo, listChunks, markFootageExpired } from '../db/repositories/videos.js';
import { getStorage } from './storage/s3.js';

/**
 * Removing someone's footage once their session is over.
 *
 * A guest session lives in the browser tab. When it closes, the token goes
 * with it and nobody — including the person who uploaded — can reach that
 * video again. Keeping the bytes after that costs storage forever and leaves
 * someone's video on our disks with no way for them to take it back.
 *
 * What is kept is deliberately narrow: the question they asked, the moments we
 * found, and their thumbs up or down. That is what teaches us whether our
 * reading of a video is any good. What goes is the footage and everything
 * derived from it — the small copy, the segments, the clips, the platform-shaped cuts of
 * those clips, the stills, the scene notes and the transcript — because those describe someone's video
 * rather than our reading of it, and once the footage is gone they cannot be
 * checked against anything anyway.
 */

export interface ExpiryResult {
  objectsDeleted: number;
  objectsFailed: number;
}

export async function expireVideoFootage(videoId: string, log: Logger): Promise<ExpiryResult> {
  const video = await getVideo(videoId);
  if (!video || video.footageExpiredAt) return { objectsDeleted: 0, objectsFailed: 0 };

  const chunks = await listChunks(videoId);
  const [clipKeys, thumbnailKeys, variantKeys] = await Promise.all([
    listClipKeysForVideo(videoId),
    listThumbnailKeysForVideo(videoId),
    // The platform-shaped cuts are someone's footage too — a 9:16 crop of a
    // deleted video is still that video.
    listVariantKeysForVideo(videoId),
  ]);

  const keys = [
    video.originalStorageKey,
    video.proxyStorageKey,
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
      // An object we cannot delete is worth knowing about — it is a bill that
      // keeps arriving — but it must not stop the rest from going.
      objectsFailed += 1;
      log.warn('could not delete stored object', { videoId, key, err: error });
    }
  }

  // The database is updated even when some objects refused to go, because the
  // alternative is trying the same failing deletes forever while the rest of
  // the video stays half-removed. The count above is the record.
  await Promise.all([deleteScenes(videoId), deleteTranscript(videoId)]);
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
