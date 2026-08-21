import { UnrecoverableError, Worker, type Job, type Processor } from 'bullmq';
import { env } from '../config/env.js';
import { ExternalServiceError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { closePool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { closeRedis, getWorkerConnection } from '../queues/connection.js';
import {
  closeQueues,
  enqueueLearningReport,
  enqueueRetentionSweep,
  enqueueThumbnailBackfill,
  QUEUE_NAMES,
} from '../queues/index.js';
import { assertFfmpegAvailable } from '../services/media/ffmpeg.js';
import { assertYtdlpAvailable } from '../services/media/ytdlp.js';
import { handleIngestion } from './handlers/ingestion.js';
import { handlePreprocessing } from './handlers/preprocess.js';
import { handleTranscription } from './handlers/transcription.js';
import { handleIndexing } from './handlers/indexing.js';
import { handleClipSearch } from './handlers/clipSearch.js';
import { handleClipGeneration } from './handlers/clipGeneration.js';
import { handleThumbnailBackfill } from './handlers/thumbnailBackfill.js';
import { handleRetention } from './handlers/retention.js';
import { handleLearningReport } from './handlers/learningReport.js';

/**
 * Worker entrypoint. All long-running work — downloading, transcoding,
 * transcription, model calls, clip cutting — happens in this process, never in
 * the API.
 */

const workers: Worker[] = [];

/**
 * Honours `ExternalServiceError.retryable`. Some dependency failures — YouTube's
 * bot check, a rejected API key — will fail identically on every attempt, and
 * retrying them only delays the error the user is waiting on.
 */
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
    // Media jobs are long; give them room before BullMQ considers them stalled.
    lockDuration: 5 * 60 * 1000,
    stalledInterval: 60 * 1000,
  });

  worker.on('failed', (job: Job<T> | undefined, error: Error) => {
    logger.error('job failed', {
      queue: name,
      jobId: job?.id,
      attempts: job?.attemptsMade,
      err: error.message,
    });
  });

  worker.on('completed', (job: Job<T>) => {
    logger.info('job completed', { queue: name, jobId: job.id });
  });

  worker.on('error', (error) => logger.error('worker error', { queue: name, err: error.message }));

  workers.push(worker as Worker);
  return worker;
}

async function checkBinaries(): Promise<void> {
  const checks: Array<[string, () => Promise<unknown>]> = [
    ['ffmpeg/ffprobe', assertFfmpegAvailable],
    ['yt-dlp', assertYtdlpAvailable],
  ];

  for (const [label, check] of checks) {
    try {
      await check();
      logger.info('dependency available', { dependency: label });
    } catch (error) {
      // Fail loudly at startup rather than at the first job.
      logger.error('required binary is missing', { dependency: label, err: error });
      throw new Error(`Required dependency "${label}" is not available: ${(error as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  logger.info('worker starting', {
    nodeEnv: env.NODE_ENV,
    transcription: env.TRANSCRIPTION_ENABLED,
    videoModel: env.OPENROUTER_VIDEO_MODEL,
    videoConcurrency: env.OPENROUTER_VIDEO_CONCURRENCY,
    indexing: env.INDEXING_ENABLED,
  });

  await checkBinaries();
  await runMigrations();

  startWorker(QUEUE_NAMES.ingestion, handleIngestion, env.INGESTION_CONCURRENCY);
  startWorker(QUEUE_NAMES.preprocessing, handlePreprocessing, env.PREPROCESS_CONCURRENCY);
  startWorker(QUEUE_NAMES.transcription, handleTranscription, env.TRANSCRIPTION_CONCURRENCY);
  // One video at a time. Reading a video is many model calls, and the shared
  // semaphore in the video client already bounds how many run at once — a
  // second video indexing in parallel would only queue behind it while making
  // a search someone is waiting on wait longer.
  startWorker(QUEUE_NAMES.indexing, handleIndexing, 1);
  startWorker(QUEUE_NAMES.clipSearch, handleClipSearch, env.CLIP_SEARCH_CONCURRENCY);
  startWorker(QUEUE_NAMES.clipGeneration, handleClipGeneration, env.CLIP_GENERATION_CONCURRENCY);
  // One at a time: the sweep is background work and must never take a slot
  // from a search or a clip someone is waiting on.
  startWorker(QUEUE_NAMES.thumbnailBackfill, handleThumbnailBackfill, 1);
  startWorker(QUEUE_NAMES.retention, handleRetention, 1);
  startWorker(QUEUE_NAMES.learningReport, handleLearningReport, 1);

  logger.info('worker ready', { queues: Object.values(QUEUE_NAMES) });

  // Queued rather than run inline: the sweep goes through the same retention,
  // logging and shutdown handling as everything else, and a fixed job id keeps
  // a redeploy or a second replica from sweeping twice. Failing to queue it is
  // not a reason to fail the worker — nothing else depends on it.
  if (env.THUMBNAIL_BACKFILL_ON_START) {
    await enqueueThumbnailBackfill(new Date().toISOString()).catch((error: unknown) => {
      logger.warn('could not queue the thumbnail backfill', { err: error });
    });
  }

  /**
   * Footage whose session has ended is swept hourly. Deliberately a timer
   * rather than a repeatable job: the queue de-duplicates by the hour in the
   * job id, so several workers or several restarts still produce one sweep an
   * hour, and there is no schedule stored anywhere to drift out of sync with
   * this code.
   */
  if (env.RETENTION_SWEEP_ENABLED) {
    const sweep = () => {
      void enqueueRetentionSweep(new Date().toISOString()).catch((error: unknown) => {
        logger.warn('could not queue the footage sweep', { err: error });
      });
    };
    sweep();
    const timer = setInterval(sweep, env.RETENTION_SWEEP_INTERVAL_MS);
    // Never hold the process open for a sweep that can run after a restart.
    timer.unref();
  }

  /**
   * What the last day taught us, once a day. Footage is deleted when a session
   * ends, so this is the form the learning takes — see docs/learning-loop.md.
   */
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
