import path from 'node:path';
import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { withWorkDir } from '../../lib/workdir.js';
import { getStorage } from '../../services/storage/s3.js';
import { clipKey } from '../../services/storage/types.js';
import { cutClip, ffprobe } from '../../services/media/ffmpeg.js';
import { captionsSchema, prepareCaptionFilters } from '../../services/media/captions.js';
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
  // Re-render jobs (a Replace) carry their spec and must run even against a
  // finished clip; only a plain generation of an already-finished clip is a
  // duplicate worth skipping.
  if (clip.status === 'ready' && clip.storageKey && job.data.captions === undefined) {
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

      // Captions are burned during the cut, sized against the real frame.
      // A Replace carries its spec in the job (the row keeps the old one
      // until this render succeeds); everything else renders the row's. The
      // spec is re-validated here so a hand-edited row cannot smuggle text
      // into a shell command.
      let videoFilters: string[] | undefined;
      const spec = captionsSchema.safeParse(job.data.captions ?? clip.captions ?? []);
      if (spec.success && spec.data.length > 0) {
        const probe = await ffprobe(sourcePath);
        videoFilters = await prepareCaptionFilters(spec.data, dir, {
          videoWidth: probe.width ?? Math.round(((probe.height ?? 720) * 16) / 9),
          videoHeight: probe.height ?? 720,
        });
      }

      const outputPath = path.join(dir, `${clipId}.mp4`);
      const result = await cutClip({
        inputPath: sourcePath,
        outputPath,
        startSeconds: padded.startSeconds,
        endSeconds: padded.endSeconds,
        hasAudio: video.hasAudio ?? true,
        ...(videoFilters ? { videoFilters } : {}),
      });

      await job.updateProgress({ stage: 'uploading', percent: 80 });

      const key = clipKey(video.id, clipId);
      await getStorage().uploadFile(key, outputPath, 'video/mp4');

      await setClipStatus(clipId, 'ready', {
        storageKey: key,
        durationSeconds: Number(result.durationSeconds.toFixed(3)),
        sizeBytes: result.sizeBytes,
        // A Replace's spec becomes the row's truth only now, when the file
        // that carries it exists.
        ...(job.data.captions !== undefined ? { captions: job.data.captions } : {}),
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
    if (clip.storageKey) {
      // A re-render failed, but the clip it was replacing still exists and
      // still plays. Marking it 'failed' would delete a working clip from
      // the library and every room it was shared into — so it goes back to
      // 'ready', file, spec and all, with the failure recorded on it for
      // the editor to report.
      await setClipStatus(clipId, 'ready', { errorMessage: message });
    } else {
      await setClipStatus(clipId, 'failed', { errorMessage: message });
    }
    throw error;
  }
}
