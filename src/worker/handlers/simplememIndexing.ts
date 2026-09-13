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

const EXPECTED_EMBEDDING_VERSION = 'v2-transformers457';

/**
 * Sends one video to Omni-SimpleMem to be remembered.
 *
 * A memory is only published as ready when the embedding contract is the one
 * Clipit expects and every kept frame that needed a caption received one.
 * Partial memories are useful diagnostics, not authoritative retrieval.
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
    const fps = env.SIMPLEMEM_FRAME_FPS;
    const maxFrames = Math.min(env.SIMPLEMEM_MAX_FRAMES, Math.ceil(video.durationSeconds * fps) + 1);
    const health = await simplememHealth();

    if (health.embeddingVersion !== EXPECTED_EMBEDDING_VERSION) {
      throw new Error(
        `SimpleMem embedding contract is ${health.embeddingVersion}; expected ${EXPECTED_EMBEDDING_VERSION}`,
      );
    }
    if (!health.transformersVersion.startsWith('4.57.')) {
      throw new Error(`SimpleMem is running transformers ${health.transformersVersion}; expected 4.57.x`);
    }

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

    if (!reply.captions) {
      throw new Error('SimpleMem did not report caption coverage; refusing to publish an unverifiable memory');
    }
    if (reply.captions.failed > 0) {
      throw new Error(
        `SimpleMem left ${reply.captions.failed} of ${reply.captions.attempted} kept frame(s) without captions; refusing partial memory`,
      );
    }

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
      config: {
        models: health.models,
        version: health.version,
        embeddingVersion: health.embeddingVersion,
        transformersVersion: health.transformersVersion,
        fps,
        maxFrames,
        captions: reply.captions,
      },
    });

    log.info('video remembered by SimpleMem', {
      framesExtracted: reply.framesExtracted,
      framesProcessed: reply.framesProcessed,
      framesSkipped: reply.framesSkipped,
      coveredThroughSeconds: reply.coveredThroughSeconds,
      ofSeconds: Number(video.durationSeconds.toFixed(1)),
      audioTranscribed: reply.audioTranscribed,
      captions: reply.captions,
      embeddingVersion: health.embeddingVersion,
      transformersVersion: health.transformersVersion,
      sidecarMs: reply.elapsedMs,
      elapsedMs: indexMs,
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
