import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { withWorkDir } from '../../lib/workdir.js';
import { getStorage } from '../../services/storage/s3.js';
import { originalKey } from '../../services/storage/types.js';
import { downloadYoutubeVideo, fetchYoutubeMetadata } from '../../services/media/ytdlp.js';
import { getVideo, setVideoStatus, updateVideoMedia } from '../../db/repositories/videos.js';
import { enqueuePreprocessing, type IngestionJob } from '../../queues/index.js';

/**
 * Brings the source bytes under our control.
 *
 * Uploads are already in storage (the client PUT them directly), so this only
 * confirms the object exists. YouTube sources are fetched with yt-dlp, along
 * with their captions when available.
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
    if (video.sourceType === 'upload') {
      const key = video.originalStorageKey;
      if (!key) throw new Error('Upload has no storage key');

      const object = await getStorage().head(key);
      if (!object) {
        throw new Error('Uploaded file was not found in storage — complete the presigned upload first');
      }

      await updateVideoMedia(videoId, { sizeBytes: object.sizeBytes });
      log.info('upload confirmed', { key, sizeBytes: object.sizeBytes });
    } else {
      await ingestYoutube(job, videoId, video.sourceUrl);
    }

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

async function ingestYoutube(job: Job<IngestionJob>, videoId: string, sourceUrl: string | null): Promise<void> {
  if (!sourceUrl) throw new Error('YouTube source has no URL');

  const log = logger.child({ job: 'ingestion', videoId });
  const metadata = await fetchYoutubeMetadata(sourceUrl);

  if (metadata.isLive) {
    throw new Error('Live streams are not supported — wait until the stream has ended');
  }

  if (metadata.durationSeconds !== null && metadata.durationSeconds > env.MAX_SOURCE_DURATION_SECONDS) {
    throw new Error(
      `Video is ${Math.round(metadata.durationSeconds)}s long, which exceeds the ${env.MAX_SOURCE_DURATION_SECONDS}s limit`,
    );
  }

  await updateVideoMedia(videoId, {
    title: metadata.title,
    sourceUrl: metadata.webpageUrl ?? sourceUrl,
    metadata: {
      youtubeId: metadata.id,
      uploader: metadata.uploader,
      reportedDurationSeconds: metadata.durationSeconds,
      availableSubtitleLangs: metadata.availableSubtitleLangs,
      availableAutoCaptionLangs: metadata.availableAutoCaptionLangs,
    },
  });

  await job.updateProgress({ stage: 'downloading', percent: 10 });

  await withWorkDir(`ingest-${videoId}`, async (dir) => {
    const download = await downloadYoutubeVideo(sourceUrl, dir);
    const info = await stat(download.videoPath);

    const key = originalKey(videoId, path.basename(download.videoPath));
    await getStorage().uploadFile(key, download.videoPath, 'video/mp4');

    let captionsStorageKey: string | null = null;
    if (download.captionPath) {
      captionsStorageKey = `originals/${videoId}/captions.vtt`;
      await getStorage().uploadFile(captionsStorageKey, download.captionPath, 'text/vtt');
    }

    await updateVideoMedia(videoId, {
      originalStorageKey: key,
      captionsStorageKey,
      sizeBytes: info.size,
      originalFilename: path.basename(download.videoPath),
    });

    log.info('youtube source ingested', {
      key,
      sizeBytes: info.size,
      hasCaptions: Boolean(captionsStorageKey),
      captionLanguage: download.captionLanguage,
    });
  });
}
