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
  /** Milliseconds already spent waiting for an in-flight transcript or index. */
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
 * Adds a job under an id derived from the row it acts on.
 *
 * The stable id is what makes a duplicate enqueue — a double click, a retried
 * request — collapse into the work already queued. BullMQ enforces that by
 * refusing any add whose id already exists, and it counts *retained* terminal
 * jobs too: failed jobs stay for a week, completed ones for a day. So an
 * explicit retry ("generate this clip again", "I've re-uploaded the file")
 * would silently never run, leaving the row stuck in `pending`.
 *
 * A completed or failed job under the same id is therefore dropped first, so
 * the retry really is queued, while a waiting, delayed or active job still
 * de-duplicates as intended.
 *
 * BullMQ also forbids ":" in custom job IDs — it delimits its own Redis keys —
 * so the separator here is "-".
 */
// The explicit generic list pins BullMQ's inferred NameType to `string`; left
// to inference it stays unresolved for a generic data type.
async function addWithStableId<T>(
  queue: Queue<T, unknown, string, T, unknown, string>,
  name: string,
  data: T,
  jobId: string,
  options: JobsOptions = {},
): Promise<void> {
  const existing = await queue.getJob(jobId);

  if (existing) {
    const state = await existing.getState().catch(() => 'unknown');
    if (state !== 'completed' && state !== 'failed') return;

    try {
      await existing.remove();
    } catch {
      // Raced with BullMQ's own retention cleanup, or the job just became
      // active again; either way the add below is still the right move.
    }
  }

  await queue.add(name, data, { jobId, ...options });
}

export async function enqueueIngestion(data: IngestionJob): Promise<void> {
  await addWithStableId(getQueues().ingestion, 'ingest', data, `ingest-${data.videoId}`);
}

export async function enqueuePreprocessing(data: PreprocessingJob): Promise<void> {
  await addWithStableId(getQueues().preprocessing, 'preprocess', data, `preprocess-${data.videoId}`);
}

export async function enqueueTranscription(data: TranscriptionJob): Promise<void> {
  await addWithStableId(getQueues().transcription, 'transcribe', data, `transcribe-${data.videoId}`);
}

export async function enqueueClipSearch(data: ClipSearchJob, options: JobsOptions = {}): Promise<void> {
  // The wait counter is part of the id so each transcript-wait re-enqueue is a
  // distinct job rather than a collision with the one that just finished.
  await addWithStableId(
    getQueues().clipSearch,
    'search',
    data,
    `search-${data.clipRequestId}-${data.waitedMs ?? 0}`,
    options,
  );
}

export async function enqueueClipGeneration(data: ClipGenerationJob): Promise<void> {
  await addWithStableId(getQueues().clipGeneration, 'generate', data, `generate-${data.clipId}`);
}

export async function closeQueues(): Promise<void> {
  if (!queues) return;
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  queues = null;
}
