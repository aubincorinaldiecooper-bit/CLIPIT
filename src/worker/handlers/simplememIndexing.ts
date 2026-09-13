import path from 'node:path';
import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { withWorkDir } from '../../lib/workdir.js';
import { getStorage } from '../../services/storage/s3.js';
import { getVideo } from '../../db/repositories/videos.js';
import { recordSimpleMemIndex, setSimpleMemIndexStatus } from '../../db/repositories/simplememIndex.js';
import { simplememHealth, simplememIndexVideo } from '../../services/retrieval/simplemem/client.js';
import type { SimpleMemIndexingJob } from '../../queues/index.js';

/**
 * Sends one video to Omni-SimpleMem to be remembered.
 *
 * SimpleMem's read is its own: it samples frames, keeps the ones whose
 * picture changed, captions each kept frame with a vision model, transcribes
 * the sound track in one piece, and writes a memory per frame. Clipit only
 * hands it the analysis proxy and records what came back — above all how far
 * into the video it looked, because SimpleMem stops at `max_frames` and a
 * question about the part past that must be told so.
 *
 * Nothing here touches the notes. A SimpleMem read that fails leaves the
 * Clipit search exactly as it was; that is what makes it a fallback.
 */
export async function handleSimpleMemIndexing(job: Job<SimpleMemIndexingJob>): Promise<void> {
  const { videoId } = job.data;
  const log = logger.child({ job: 'simplemem-indexing', videoId });

  const video = await getVideo(videoId);
  if (!video) {
    log.warn('video no longer exists, dropping SimpleMem indexing');
    return;
  }
  if (!video.proxyStorageKey || !video.durationSeconds) {
    await setSimpleMemIndexStatus(videoId, 'failed', { error: 'Video has no analysis proxy to remember' });
    return;
  }

  const startedAt = performance.now();
  await setSimpleMemIndexStatus(videoId, 'running');

  try {
    // Whole length, up to the ceiling. Recorded either way: the row's
    // covered_through_seconds is what the search names as unread.
    const fps = env.SIMPLEMEM_FRAME_FPS;
    const maxFrames = Math.min(env.SIMPLEMEM_MAX_FRAMES, Math.ceil(video.durationSeconds * fps) + 1);
    const health = await simplememHealth();

    const reply = await withWorkDir(`simplemem-${videoId}`, async (dir) => {
      const proxyPath = path.join(dir, 'proxy.mp4');
      await getStorage().downloadToFile(video.proxyStorageKey!, proxyPath);
      return simplememIndexVideo({
        videoId,
        filePath: proxyPath,
        fps,
        maxFrames,
        durationSeconds: video.durationSeconds!,
      });
    });

    const indexMs = Math.round(performance.now() - startedAt);
    await recordSimpleMemIndex(videoId, {
      videoMauId: reply.videoMauId,
      fps: reply.fps,
      framesExtracted: reply.framesExtracted,
      framesProcessed: reply.framesProcessed,
      framesSkipped: reply.framesSkipped,
      coveredThroughSeconds: reply.coveredThroughSeconds,
      audioTranscribed: reply.audioTranscribed,
      indexMs,
      // The caption counts ride on the row's config so a memory whose frames
      // went undescribed can be told apart from one that was read in full.
      config: { models: health.models, version: health.version, fps, maxFrames, captions: reply.captions },
    });

    if (reply.captions && reply.captions.failed > 0) {
      // Those frames still carry a picture vector, so they are findable by
      // what they look like; they just cannot be found by what they show.
      log.warn('SimpleMem remembered some frames without a caption', {
        framesWithoutCaption: reply.captions.failed,
        undescribedFrames: reply.captions.uncaptionedFrames.length,
        framesCaptioned: reply.captions.captioned,
        retried: reply.captions.retried,
        lastError: reply.captions.lastError,
      });
    }

    log.info('video remembered by SimpleMem', {
      framesExtracted: reply.framesExtracted,
      framesProcessed: reply.framesProcessed,
      framesSkipped: reply.framesSkipped,
      coveredThroughSeconds: reply.coveredThroughSeconds,
      ofSeconds: Number(video.durationSeconds.toFixed(1)),
      audioTranscribed: reply.audioTranscribed,
      captions: reply.captions,
      sidecarMs: reply.elapsedMs,
      elapsedMs: indexMs,
      // Seconds of video remembered per second of waiting: the one number
      // that says how this read compares with reading the notes.
      secondsOfVideoPerSecond: Number((reply.coveredThroughSeconds / (indexMs / 1000)).toFixed(2)),
      models: health.models,
    });
  } catch (error) {
    const message = errorMessage(error);
    log.error('SimpleMem indexing failed', { err: error });
    await setSimpleMemIndexStatus(videoId, 'failed', { error: message });
    throw error;
  }
}
