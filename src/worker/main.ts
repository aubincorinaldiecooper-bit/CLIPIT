import { UnrecoverableError, Worker, type Job, type Processor } from 'bullmq';
import { env } from '../config/env.js';
import { ExternalServiceError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { closePool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { listSimpleMemReindexVideoIds } from '../db/repositories/simplememIndex.js';
import { closeRedis, getWorkerConnection } from '../queues/connection.js';
import {
  closeQueues,
  enqueueLearningReport,
  enqueueRetentionSweep,
  enqueueSimpleMemIndexing,
  enqueueThumbnailBackfill,
  QUEUE_NAMES,
} from '../queues/index.js';
import { INTERNET_VIDEO_SEARCH_QUEUE } from '../queues/internetVideoSearch.js';
import { assertFfmpegAvailable } from '../services/media/ffmpeg.js';
import { assertMiniCpmDeploymentAvailable } from '../services/search/minicpmVideo.js';
import { handleIngestion } from './handlers/ingestion.js';
import { handlePreprocessing } from './handlers/preprocess.js';
import { handleTranscription } from './handlers/transcription.js';
import { handleSimpleMemIndexing } from './handlers/simplememIndexing.js';
import { handleClipSearch } from './handlers/clipSearch.js';
import { handleClipGeneration } from './handlers/clipGeneration.js';
import { handleClipVariant } from './handlers/clipVariant.js';
import { handleReclip } from './handlers/reclip.js';
import { handleThumbnailBackfill } from './handlers/thumbnailBackfill.js';
import { handleRetention } from './handlers/retention.js';
import { handleScheduledPublish } from './handlers/scheduledPublish.js';
import { handleLearningReport } from './handlers/learningReport.js';
import { handleInternetVideoSearch } from './handlers/internetVideoSearch.js';

const workers: Worker[] = [];

function withTerminalFailures<T>(processor: Processor<T>): Processor<T> {
  return async (job, token) => {
    try {
      return await processor(job, token);
    } catch (error) {
      if (error instanceof ExternalServiceError && !error.retryable) {
        throw new UnrecoverableError(error.message);
      }
      throw error;
    }
  };
}

function startWorker<T>(name: string, processor: Processor<T>, concurrency: number): Worker<T> {
  const worker = new Worker<T>(name, withTerminalFailures(processor), {
    connection: getWorkerConnection(),
    concurrency,
    lockDuration: 5 * 60 * 1000,
    stalledInterval: 60 * 1000,
  });
  worker.on('failed', (job: Job<T> | undefined, error: Error) => {
    logger.error('job failed', { queue: name, jobId: job?.id, attempts: job?.attemptsMade, err: error.message });
  });
  worker.on('completed', (job: Job<T>) => logger.info('job completed', { queue: name, jobId: job.id }));
  worker.on('error', (error) => logger.error('worker error', { queue: name, err: error.message }));
  workers.push(worker as Worker);
  return worker;
}

function checkVideoProviderConfig(): void {
  if (env.VIDEO_PROVIDER === 'minicpm' && (!env.MODAL_TOKEN_ID || !env.MODAL_TOKEN_SECRET)) {
    throw new Error('VIDEO_PROVIDER=minicpm requires MODAL_TOKEN_ID and MODAL_TOKEN_SECRET on the worker');
  }
  if (env.RETRIEVAL_PRIMARY === 'videochat3' && (!env.MODAL_TOKEN_ID || !env.MODAL_TOKEN_SECRET)) {
    throw new Error(
      'RETRIEVAL_PRIMARY=videochat3 requires MODAL_TOKEN_ID and MODAL_TOKEN_SECRET on the worker: VideoChat3 and the Qwen services run on Modal',
    );
  }
}

async function checkBinaries(): Promise<void> {
  const checks: Array<[string, () => Promise<unknown>]> = [['ffmpeg/ffprobe', assertFfmpegAvailable]];
  for (const [label, check] of checks) {
    try {
      await check();
      logger.info('dependency available', { dependency: label });
    } catch (error) {
      logger.error('required binary is missing', { dependency: label, err: error });
      throw new Error(`Required dependency "${label}" is not available: ${(error as Error).message}`);
    }
  }
}

async function enqueueSimpleMemRebuilds(): Promise<void> {
  if (!env.SIMPLEMEM_INDEX_ENABLED) return;
  const videoIds = await listSimpleMemReindexVideoIds(100);
  for (const videoId of videoIds) {
    await enqueueSimpleMemIndexing({ videoId });
  }
  if (videoIds.length > 0) {
    logger.info('queued invalidated SimpleMem memories for rebuild', { videos: videoIds.length });
  }
}

async function main(): Promise<void> {
  logger.info('worker starting', {
    nodeEnv: env.NODE_ENV,
    transcription: env.TRANSCRIPTION_ENABLED,
    videoModel: env.OPENROUTER_VIDEO_MODEL,
    videoCallConcurrency: env.OPENROUTER_VIDEO_CONCURRENCY,
    retrievalPrimary: env.RETRIEVAL_PRIMARY,
    simplememIndexing: env.SIMPLEMEM_INDEX_ENABLED,
  });

  checkVideoProviderConfig();
  await checkBinaries();
  await runMigrations();

  if (env.VIDEO_PROVIDER === 'minicpm') {
    await assertMiniCpmDeploymentAvailable();
    logger.info('MiniCPM deployment available', {
      provider: 'minicpm',
      environment: env.MODAL_ENVIRONMENT,
      app: env.MODAL_APP_NAME,
      class: env.MODAL_CLASS_NAME,
      method: 'analyze',
    });
  }

  startWorker(QUEUE_NAMES.ingestion, handleIngestion, env.INGESTION_CONCURRENCY);
  startWorker(QUEUE_NAMES.preprocessing, handlePreprocessing, env.PREPROCESS_CONCURRENCY);
  startWorker(QUEUE_NAMES.transcription, handleTranscription, env.TRANSCRIPTION_CONCURRENCY);
  startWorker(QUEUE_NAMES.simplememIndexing, handleSimpleMemIndexing, 1);
  startWorker(QUEUE_NAMES.clipSearch, handleClipSearch, env.CLIP_SEARCH_CONCURRENCY);
  startWorker(QUEUE_NAMES.clipGeneration, handleClipGeneration, env.CLIP_GENERATION_CONCURRENCY);
  startWorker(QUEUE_NAMES.clipVariant, handleClipVariant, env.CLIP_GENERATION_CONCURRENCY);
  startWorker(QUEUE_NAMES.reclip, handleReclip, 1);
  startWorker(QUEUE_NAMES.thumbnailBackfill, handleThumbnailBackfill, 1);
  startWorker(QUEUE_NAMES.retention, handleRetention, 1);
  startWorker(QUEUE_NAMES.scheduledPublish, handleScheduledPublish, 1);
  startWorker(QUEUE_NAMES.learningReport, handleLearningReport, 1);
  startWorker(INTERNET_VIDEO_SEARCH_QUEUE, handleInternetVideoSearch, 1);

  await enqueueSimpleMemRebuilds().catch((error: unknown) => {
    logger.warn('could not queue invalidated SimpleMem memories for rebuild', { err: error });
  });

  logger.info('worker ready', { queues: [...Object.values(QUEUE_NAMES), INTERNET_VIDEO_SEARCH_QUEUE] });

  if (env.THUMBNAIL_BACKFILL_ON_START) {
    await enqueueThumbnailBackfill(new Date().toISOString()).catch((error: unknown) => {
      logger.warn('could not queue the thumbnail backfill', { err: error });
    });
  }

  if (env.RETENTION_SWEEP_ENABLED) {
    const sweep = () => {
      void enqueueRetentionSweep(new Date().toISOString()).catch((error: unknown) => {
        logger.warn('could not queue the footage sweep', { err: error });
      });
    };
    sweep();
    const timer = setInterval(sweep, env.RETENTION_SWEEP_INTERVAL_MS);
    timer.unref();
  }

  if (env.LEARNING_REPORT_ENABLED) {
    const report = () => {
      void enqueueLearningReport(new Date().toISOString()).catch((error: unknown) => {
        logger.warn('could not queue the learning report', { err: error });
      });
    };
    report();
    const timer = setInterval(report, env.LEARNING_REPORT_INTERVAL_MS);
    timer.unref();
  }
}

async function shutdown(signal: string): Promise<void> {
  logger.info('worker shutting down', { signal });
  try {
    await Promise.all(workers.map((worker) => worker.close()));
    await closeQueues();
    await closeRedis();
    await closePool();
  } catch (error) {
    logger.error('error during shutdown', { err: error });
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch((error) => {
  logger.error('worker failed to start', { err: error });
  process.exit(1);
});
