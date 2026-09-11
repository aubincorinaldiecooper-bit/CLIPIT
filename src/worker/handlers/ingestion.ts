import type { Job } from 'bullmq';
import { logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { getStorage } from '../../services/storage/s3.js';
import { getVideo, setVideoStatus, updateVideoMedia } from '../../db/repositories/videos.js';
import { enqueuePreprocessing, type IngestionJob } from '../../queues/index.js';

/**
 * Confirms bytes acquired by Clipit are present, then hands them to the normal
 * preprocessing pipeline. URL/provider acquisition belongs to web discovery's
 * source resolver; this worker never downloads from a public video site.
 */
export async function handleIngestion(job: Job<IngestionJob>): Promise<void> {
  const { videoId } = job.data;
  const log = logger.child({ job: 'ingestion', videoId });
  const video = await getVideo(videoId);
  if (!video) {
    log.warn('video no longer exists, dropping job');
    return;
  }
  if (video.status === 'ready') {
    log.info('video already processed, skipping ingestion');
    return;
  }

  await setVideoStatus(videoId, 'ingesting');
  await job.updateProgress({ stage: 'ingesting', percent: 5 });

  try {
    if (video.sourceType !== 'upload') {
      console.warn('Legacy URL ingestion has been retired; web sources must be resolved to stored bytes before ingestion');
    }
    const key = video.originalStorageKey;
    if (!key) throw new Error('Upload has no storage key');
    const object = await getStorage().head(key);
    if (!object) throw new Error('Uploaded file was not found in storage — complete the presigned upload first');

    await updateVideoMedia(videoId, { sizeBytes: object.sizeBytes });
    log.info('upload confirmed', { key, sizeBytes: object.sizeBytes });
    await job.updateProgress({ stage: 'ingested', percent: 30 });
    await setVideoStatus(videoId, 'preprocessing');
    await enqueuePreprocessing({ videoId });
  } catch (error) {
    const message = errorMessage(error);
    log.error('ingestion failed', { err: error });
    await setVideoStatus(videoId, 'failed', message);
    throw error;
  }
}
