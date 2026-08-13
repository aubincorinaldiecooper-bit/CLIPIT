import path from 'node:path';
import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { withWorkDir } from '../../lib/workdir.js';
import { getStorage } from '../../services/storage/s3.js';
import { clipKey } from '../../services/storage/types.js';
import { cutClip } from '../../services/media/ffmpeg.js';
import { applyClipPadding } from '../../services/timestamps.js';
import { getClip, setClipStatus } from '../../db/repositories/clips.js';
import { getVideo } from '../../db/repositories/videos.js';
import type { ClipGenerationJob } from '../../queues/index.js';

/**
 * Cuts a match out of the ORIGINAL source (never the analysis proxy) and stores
 * the result as MP4 / H.264 / AAC.
 */
export async function handleClipGeneration(job: Job<ClipGenerationJob>): Promise<void> {
  const { clipId } = job.data;
  const log = logger.child({ job: 'clip-generation', clipId });

  const clip = await getClip(clipId);
  if (!clip) {
    log.warn('clip no longer exists, dropping job');
    return;
  }
  if (clip.status === 'ready' && clip.storageKey) {
    log.info('clip already generated, skipping');
    return;
  }

  const video = await getVideo(clip.videoId);
  if (!video?.originalStorageKey) {
    await setClipStatus(clipId, 'failed', { errorMessage: 'Source video is no longer available' });
    return;
  }

  await setClipStatus(clipId, 'generating');
  await job.updateProgress({ stage: 'generating', percent: 10 });

  try {
    // Widen the match slightly so the moment is not clipped off at either edge.
    const padded = applyClipPadding(
      { startSeconds: clip.startSeconds, endSeconds: clip.endSeconds },
      {
        paddingSeconds: env.CLIP_PADDING_SECONDS,
        videoDurationSeconds: video.durationSeconds ?? Number.POSITIVE_INFINITY,
        minDurationSeconds: env.MIN_CLIP_SECONDS,
        maxDurationSeconds: env.MAX_CLIP_SECONDS,
      },
    );

    await withWorkDir(`clip-${clipId}`, async (dir) => {
      const sourcePath = path.join(dir, `source${path.extname(video.originalStorageKey!) || '.mp4'}`);
      await getStorage().downloadToFile(video.originalStorageKey!, sourcePath);
      await job.updateProgress({ stage: 'cutting', percent: 40 });

      const outputPath = path.join(dir, `${clipId}.mp4`);
      const result = await cutClip({
        inputPath: sourcePath,
        outputPath,
        startSeconds: padded.startSeconds,
        endSeconds: padded.endSeconds,
        hasAudio: video.hasAudio ?? true,
      });

      await job.updateProgress({ stage: 'uploading', percent: 80 });

      const key = clipKey(video.id, clipId);
      await getStorage().uploadFile(key, outputPath, 'video/mp4');

      await setClipStatus(clipId, 'ready', {
        storageKey: key,
        durationSeconds: Number(result.durationSeconds.toFixed(3)),
        sizeBytes: result.sizeBytes,
      });

      log.info('clip generated', {
        key,
        startSeconds: padded.startSeconds,
        endSeconds: padded.endSeconds,
        sizeBytes: result.sizeBytes,
      });
      await job.updateProgress({ stage: 'ready', percent: 100 });
    });
  } catch (error) {
    const message = errorMessage(error);
    log.error('clip generation failed', { err: error });
    await setClipStatus(clipId, 'failed', { errorMessage: message });
    throw error;
  }
}
