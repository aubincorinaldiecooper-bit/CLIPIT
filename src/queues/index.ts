import { Queue, type JobsOptions } from 'bullmq';
import { env } from '../config/env.js';
import { getQueueConnection } from './connection.js';

export const QUEUE_NAMES = {
  ingestion: 'video-ingestion',
  preprocessing: 'video-preprocessing',
  transcription: 'video-transcription',
  clipSearch: 'clip-search',
  clipGeneration: 'clip-generation',
} as const;

export interface IngestionJob {
  videoId: string;
}

export interface PreprocessingJob {
  videoId: string;
}

export interface TranscriptionJob {
  videoId: string;
  /** Set when yt-dlp already downloaded captions; skips paid transcription. */
  captionsStorageKey?: string | null;
}

export interface ClipSearchJob {
  clipRequestId: string;
  /** Milliseconds already spent waiting for an in-flight transcript. */
  waitedMs?: number;
}

export interface ClipGenerationJob {
  clipId: string;
}

const defaultJobOptions: JobsOptions = {
  attempts: env.JOB_ATTEMPTS,
  backoff: { type: 'exponential', delay: env.JOB_BACKOFF_MS },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
};

let queues: {
  ingestion: Queue<IngestionJob>;
  preprocessing: Queue<PreprocessingJob>;
  transcription: Queue<TranscriptionJob>;
  clipSearch: Queue<ClipSearchJob>;
  clipGeneration: Queue<ClipGenerationJob>;
} | null = null;

export function getQueues() {
  if (!queues) {
    const connection = getQueueConnection();
    queues = {
      ingestion: new Queue<IngestionJob>(QUEUE_NAMES.ingestion, { connection, defaultJobOptions }),
      preprocessing: new Queue<PreprocessingJob>(QUEUE_NAMES.preprocessing, { connection, defaultJobOptions }),
      transcription: new Queue<TranscriptionJob>(QUEUE_NAMES.transcription, { connection, defaultJobOptions }),
      clipSearch: new Queue<ClipSearchJob>(QUEUE_NAMES.clipSearch, { connection, defaultJobOptions }),
      clipGeneration: new Queue<ClipGenerationJob>(QUEUE_NAMES.clipGeneration, { connection, defaultJobOptions }),
    };
  }
  return queues;
}

/**
 * Job IDs are derived from the row they act on, so a duplicate enqueue (double
 * click, retried request) collapses into the existing job.
 *
 * BullMQ forbids ":" in custom job IDs — it is the delimiter in its own Redis
 * key scheme — so the separator here is "-".
 */
export async function enqueueIngestion(data: IngestionJob): Promise<void> {
  await getQueues().ingestion.add('ingest', data, { jobId: `ingest-${data.videoId}` });
}

export async function enqueuePreprocessing(data: PreprocessingJob): Promise<void> {
  await getQueues().preprocessing.add('preprocess', data, { jobId: `preprocess-${data.videoId}` });
}

export async function enqueueTranscription(data: TranscriptionJob): Promise<void> {
  await getQueues().transcription.add('transcribe', data, { jobId: `transcribe-${data.videoId}` });
}

export async function enqueueClipSearch(data: ClipSearchJob, options: JobsOptions = {}): Promise<void> {
  // The wait counter is part of the id so each transcript-wait re-enqueue is a
  // distinct job rather than a collision with the one that just finished.
  await getQueues().clipSearch.add('search', data, {
    jobId: `search-${data.clipRequestId}-${data.waitedMs ?? 0}`,
    ...options,
  });
}

export async function enqueueClipGeneration(data: ClipGenerationJob): Promise<void> {
  await getQueues().clipGeneration.add('generate', data, { jobId: `generate-${data.clipId}` });
}

export async function closeQueues(): Promise<void> {
  if (!queues) return;
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  queues = null;
}
