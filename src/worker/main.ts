import { Worker, type Job, type Processor } from 'bullmq';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { closePool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { closeRedis, getWorkerConnection } from '../queues/connection.js';
import { closeQueues, QUEUE_NAMES } from '../queues/index.js';
import { assertFfmpegAvailable } from '../services/media/ffmpeg.js';
import { assertYtdlpAvailable } from '../services/media/ytdlp.js';
import { handleIngestion } from './handlers/ingestion.js';
import { handlePreprocessing } from './handlers/preprocess.js';
import { handleTranscription } from './handlers/transcription.js';
import { handleClipSearch } from './handlers/clipSearch.js';
import { handleClipGeneration } from './handlers/clipGeneration.js';

/**
 * Worker entrypoint. All long-running work — downloading, transcoding,
 * transcription, model calls, clip cutting — happens in this process, never in
 * the API.
 */

const workers: Worker[] = [];

function startWorker<T>(name: string, processor: Processor<T>, concurrency: number): Worker<T> {
  const worker = new Worker<T>(name, processor, {
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
    minicpmModel: env.MINICPM_MODEL,
    minicpmConcurrency: env.MINICPM_CONCURRENCY,
  });

  await checkBinaries();
  await runMigrations();

  startWorker(QUEUE_NAMES.ingestion, handleIngestion, env.INGESTION_CONCURRENCY);
  startWorker(QUEUE_NAMES.preprocessing, handlePreprocessing, env.PREPROCESS_CONCURRENCY);
  startWorker(QUEUE_NAMES.transcription, handleTranscription, env.TRANSCRIPTION_CONCURRENCY);
  startWorker(QUEUE_NAMES.clipSearch, handleClipSearch, env.CLIP_SEARCH_CONCURRENCY);
  startWorker(QUEUE_NAMES.clipGeneration, handleClipGeneration, env.CLIP_GENERATION_CONCURRENCY);

  logger.info('worker ready', { queues: Object.values(QUEUE_NAMES) });
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
