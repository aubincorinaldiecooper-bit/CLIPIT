import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import type { Job } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { errorMessage } from '../../lib/errors.js';
import { withWorkDir } from '../../lib/workdir.js';
import { getStorage } from '../../services/storage/s3.js';
import { chunkKey, proxyKey } from '../../services/storage/types.js';
import { createAnalysisProxy, ffprobe, splitIntoChunks } from '../../services/media/ffmpeg.js';
import { getVideo, replaceChunks, setIndexStatus, setTranscriptStatus, setVideoStatus, updateVideoMedia } from '../../db/repositories/videos.js';
import { enqueueIndexing, enqueueTranscription, type PreprocessingJob } from '../../queues/index.js';

/**
 * Probes the source, builds the analysis proxy, and cuts it into the fixed
 * analysis chunks the model will see. A multi-hour VOD is never handed to the
 * model in one piece: this is where it becomes a list of bounded segments with
 * known global start/end times.
 */
export async function handlePreprocessing(job: Job<PreprocessingJob>): Promise<void> {
  const { videoId } = job.data;
  const log = logger.child({ job: 'preprocessing', videoId });

  const video = await getVideo(videoId);
  if (!video) {
    log.warn('video no longer exists, dropping job');
    return;
  }
  if (!video.originalStorageKey) {
    await setVideoStatus(videoId, 'failed', 'No source file to preprocess');
    return;
  }

  await setVideoStatus(videoId, 'preprocessing');
  await job.updateProgress({ stage: 'preprocessing', percent: 35 });

  try {
    const storage = getStorage();

    await withWorkDir(`preprocess-${videoId}`, async (dir) => {
      const sourcePath = path.join(dir, `source${path.extname(video.originalStorageKey!) || '.mp4'}`);
      await storage.downloadToFile(video.originalStorageKey!, sourcePath);

      // 1. Probe the source and persist its real metadata.
      const probe = await ffprobe(sourcePath);
      if (!Number.isFinite(probe.durationSeconds) || probe.durationSeconds <= 0) {
        throw new Error('Could not determine source duration — the file may be corrupt or not a video');
      }
      if (probe.durationSeconds > env.MAX_SOURCE_DURATION_SECONDS) {
        throw new Error(
          `Video is ${Math.round(probe.durationSeconds)}s long, which exceeds the ${env.MAX_SOURCE_DURATION_SECONDS}s limit`,
        );
      }

      await updateVideoMedia(videoId, {
        durationSeconds: Number(probe.durationSeconds.toFixed(3)),
        width: probe.width,
        height: probe.height,
        fps: probe.fps,
        videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec,
        hasAudio: probe.hasAudio,
        sizeBytes: probe.sizeBytes,
        metadata: {
          ...video.metadata,
          formatName: probe.formatName,
          bitRate: probe.bitRate,
        },
      });

      log.info('source probed', {
        durationSeconds: probe.durationSeconds,
        resolution: `${probe.width}x${probe.height}`,
        hasAudio: probe.hasAudio,
      });
      await job.updateProgress({ stage: 'probed', percent: 40 });

      // 2. Build the low-resolution analysis proxy.
      const proxyPath = path.join(dir, 'proxy.mp4');
      await createAnalysisProxy(sourcePath, proxyPath);
      const proxyStorageKey = proxyKey(videoId);
      await storage.uploadFile(proxyStorageKey, proxyPath, 'video/mp4');
      await updateVideoMedia(videoId, { proxyStorageKey });

      log.info('analysis proxy created', { proxyStorageKey });
      await job.updateProgress({ stage: 'proxy_created', percent: 60 });

      // 3. Split the proxy into analysis chunks and record their global bounds.
      const chunkDir = path.join(dir, 'chunks');
      await mkdir(chunkDir, { recursive: true });
      const segments = await splitIntoChunks(proxyPath, chunkDir, env.ANALYSIS_CHUNK_SECONDS);

      if (segments.length === 0) {
        throw new Error('Splitting the proxy produced no analysis chunks');
      }

      const uploaded: Parameters<typeof replaceChunks>[1] = [];
      for (const segment of segments) {
        // The proxy can run marginally longer than the original (frame duration
        // at the tail), so the grid is clamped to the source. Without this a
        // match in the last chunk could carry a timestamp past the end of the
        // video the clip is cut from.
        const globalEndSeconds = Math.min(segment.globalEndSeconds, probe.durationSeconds);
        if (globalEndSeconds - segment.globalStartSeconds <= 0.001) {
          log.warn('dropping chunk that starts past the end of the source', { chunkIndex: segment.index });
          continue;
        }

        const key = chunkKey(videoId, segment.index);
        await storage.uploadFile(key, segment.filePath, 'video/mp4');
        uploaded.push({
          chunkIndex: segment.index,
          globalStartSeconds: segment.globalStartSeconds,
          globalEndSeconds: Number(globalEndSeconds.toFixed(3)),
          durationSeconds: Number((globalEndSeconds - segment.globalStartSeconds).toFixed(3)),
          storageKey: key,
        });
        await job.updateProgress({
          stage: 'chunking',
          percent: 60 + Math.round((30 * (segment.index + 1)) / segments.length),
          chunksUploaded: segment.index + 1,
          chunksTotal: segments.length,
        });
      }

      await replaceChunks(videoId, uploaded);
      await updateVideoMedia(videoId, {
        chunkSeconds: env.ANALYSIS_CHUNK_SECONDS,
        chunkCount: uploaded.length,
      });

      log.info('analysis chunks created', {
        count: uploaded.length,
        chunkSeconds: env.ANALYSIS_CHUNK_SECONDS,
        lastChunkEnd: uploaded.at(-1)?.globalEndSeconds,
      });

      // 4. The video can now be searched.
      await setVideoStatus(videoId, 'ready');
      await job.updateProgress({ stage: 'ready', percent: 100 });

      // 5. Transcription runs after the video is searchable, so a spoken-word
      //    search waits only for the transcript, not for the whole pipeline.
      if (!env.TRANSCRIPTION_ENABLED) {
        await setTranscriptStatus(videoId, 'unavailable', { error: 'Transcription is disabled' });
      } else if (!probe.hasAudio) {
        await setTranscriptStatus(videoId, 'unavailable', { error: 'Source has no audio track' });
      } else {
        await setTranscriptStatus(videoId, 'queued');
        await enqueueTranscription({ videoId, captionsStorageKey: video.captionsStorageKey });
      }

      // 6. The scene index — the model reads the video once, now, so that
      //    queries answer from what it wrote down instead of re-watching.
      if (!env.INDEXING_ENABLED) {
        await setIndexStatus(videoId, 'unavailable', { error: 'Indexing is disabled' });
      } else {
        await setIndexStatus(videoId, 'queued');
        await enqueueIndexing({ videoId });
      }
    });
  } catch (error) {
    const message = errorMessage(error);
    log.error('preprocessing failed', { err: error });
    await setVideoStatus(videoId, 'failed', message);
    throw error;
  }
}
