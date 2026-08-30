import { Queue, type JobsOptions } from 'bullmq';
import { env } from '../config/env.js';
import { getQueueConnection } from './connection.js';

export const QUEUE_NAMES = {
  ingestion: 'video-ingestion',
  preprocessing: 'video-preprocessing',
  transcription: 'video-transcription',
  indexing: 'video-indexing',
  clipSearch: 'clip-search',
  clipGeneration: 'clip-generation',
  clipVariant: 'clip-variant',
  reclip: 'moment-reclip',
  thumbnailBackfill: 'thumbnail-backfill',
  retention: 'footage-retention',
  learningReport: 'learning-report',
  scheduledPublish: 'scheduled-publish',
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

/** Read a video into notes, once, after preprocessing. */
export interface IndexingJob {
  videoId: string;
}

export interface ClipSearchJob {
  clipRequestId: string;
  /** Milliseconds already spent waiting for an in-flight transcript or index. */
  waitedMs?: number;
}

export interface ClipGenerationJob {
  clipId: string;
  /**
   * Present on a caption re-render (Replace): the spec to burn. It rides in
   * the JOB, not the row, so the row keeps describing the file that actually
   * exists until the new render succeeds — a failed or superseded render can
   * never leave the database claiming captions the file does not have.
   */
  captions?: import('../services/media/captions.js').ClipCaption[];
  /**
   * Present when this render applies a Re-clip. Same principle as captions:
   * the moment's new version and its cleared pending state become true only
   * when the file that carries the new boundaries exists — a render that
   * fails rolls the clip back to `previous` and records the failure instead.
   */
  reclip?: {
    matchId: string;
    startSeconds: number;
    endSeconds: number;
    provider: string | null;
    model: string | null;
    promptVersion: string | null;
    previous: {
      startSeconds: number;
      endSeconds: number;
      boundariesEditedAt: string | null;
      status: 'ready' | 'failed';
    };
  };
}

/**
 * Re-evaluate one moment's boundaries with wider context. One job per
 * moment at a time — the stable id below and the pending claim in the
 * database together make a double-tap harmless.
 */
export interface ReclipJob {
  matchId: string;
  clipRequestId: string;
}

/**
 * Cut one clip to one platform shape.
 *
 * Queued by a publish that needs a shape which does not exist yet. The job
 * carries the post it is preparing for, so the worker can submit it the
 * moment the file is ready — the person pressed Publish once, and that has
 * to remain a single act even though a render happens in the middle of it.
 */
export interface ClipVariantJob {
  clipId: string;
  variantId: string;
  aspect: '9:16' | '1:1' | '4:5' | '16:9';
  focusPct: number;
  /** The published_posts row waiting on this file, if a publish queued it. */
  postId?: string;
}

/**
 * Gives stills to matches found before stills existed. Carries no payload: the
 * work it does is defined entirely by what the database is still missing.
 */
/** Remove footage whose session has ended. Carries no payload. */
export interface RetentionJob {
  requestedAt: string;
}

/** Summarise what the last day of use taught us. Carries no payload. */
export interface LearningReportJob {
  requestedAt: string;
}

export interface ThumbnailBackfillJob {
  /** Present only so the job data is not an empty object. */
  requestedAt: string;
}

/**
 * Fire one promised publish at its chosen minute. The job is the alarm
 * clock and nothing more: everything about WHAT goes out lives on the
 * scheduled_posts row, re-read and re-validated when this fires.
 */
export interface ScheduledPublishJob {
  scheduledPostId: string;
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
  indexing: Queue<IndexingJob>;
  clipSearch: Queue<ClipSearchJob>;
  clipGeneration: Queue<ClipGenerationJob>;
  clipVariant: Queue<ClipVariantJob>;
  reclip: Queue<ReclipJob>;
  thumbnailBackfill: Queue<ThumbnailBackfillJob>;
  retention: Queue<RetentionJob>;
  learningReport: Queue<LearningReportJob>;
  scheduledPublish: Queue<ScheduledPublishJob>;
} | null = null;

export function getQueues() {
  if (!queues) {
    const connection = getQueueConnection();
    queues = {
      ingestion: new Queue<IngestionJob>(QUEUE_NAMES.ingestion, { connection, defaultJobOptions }),
      preprocessing: new Queue<PreprocessingJob>(QUEUE_NAMES.preprocessing, { connection, defaultJobOptions }),
      transcription: new Queue<TranscriptionJob>(QUEUE_NAMES.transcription, { connection, defaultJobOptions }),
      indexing: new Queue<IndexingJob>(QUEUE_NAMES.indexing, { connection, defaultJobOptions }),
      clipSearch: new Queue<ClipSearchJob>(QUEUE_NAMES.clipSearch, { connection, defaultJobOptions }),
      clipGeneration: new Queue<ClipGenerationJob>(QUEUE_NAMES.clipGeneration, { connection, defaultJobOptions }),
      clipVariant: new Queue<ClipVariantJob>(QUEUE_NAMES.clipVariant, { connection, defaultJobOptions }),
      reclip: new Queue<ReclipJob>(QUEUE_NAMES.reclip, { connection, defaultJobOptions }),
      thumbnailBackfill: new Queue<ThumbnailBackfillJob>(QUEUE_NAMES.thumbnailBackfill, {
        connection,
        defaultJobOptions,
      }),
      retention: new Queue<RetentionJob>(QUEUE_NAMES.retention, { connection, defaultJobOptions }),
      learningReport: new Queue<LearningReportJob>(QUEUE_NAMES.learningReport, {
        connection,
        defaultJobOptions,
      }),
      scheduledPublish: new Queue<ScheduledPublishJob>(QUEUE_NAMES.scheduledPublish, {
        connection,
        // One delivery, no automatic retries: the handler records every
        // outcome on the row itself, and a blind re-run minutes later could
        // double-post to a real audience. The claim's quarantine reclaim is
        // the deliberate second chance.
        defaultJobOptions: { ...defaultJobOptions, attempts: 1 },
      }),
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

export async function enqueueIndexing(data: IndexingJob): Promise<void> {
  await addWithStableId(getQueues().indexing, 'index', data, `index-${data.videoId}`);
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

/**
 * One Re-clip job per moment, single attempt. The model call inside has its
 * own bounded retries; letting BullMQ retry on top of that could spend the
 * whole per-moment budget on one tap. A failure lands in reclip_status where
 * the person can see it and decide.
 */
export async function enqueueReclip(data: ReclipJob): Promise<void> {
  await addWithStableId(getQueues().reclip, 'reclip', data, `reclip-${data.matchId}`, { attempts: 1 });
}

/**
 * One job per variant row. The id is the row's, so two publishes racing for
 * the same shape queue one render between them — the row was claimed
 * atomically, and this keeps the work that follows just as single.
 */
export async function enqueueClipVariant(data: ClipVariantJob): Promise<void> {
  await addWithStableId(getQueues().clipVariant, 'variant', data, `variant-${data.variantId}`);
}

/**
 * Queued once per worker start, under a fixed id.
 *
 * The id is what keeps a redeploy — or a second worker replica — from running
 * the same sweep twice: BullMQ refuses an add whose id already exists, and
 * `addWithStableId` only clears a terminal one, so a completed sweep is
 * re-runnable on the next start while a running one is left alone.
 */
export async function enqueueThumbnailBackfill(requestedAt: string): Promise<void> {
  await addWithStableId(
    getQueues().thumbnailBackfill,
    'backfill',
    { requestedAt },
    'thumbnail-backfill',
    // One attempt. Every failure inside is already swallowed per video, so a
    // job that fails outright failed at the database, and retrying a sweep
    // that cannot read its own work list just burns the queue.
    { attempts: 1 },
  );
}

/**
 * Queues a footage sweep. The id changes with the hour, so a sweep queued
 * every few minutes by a restarting worker collapses into one per hour rather
 * than stacking, while still running again next hour.
 */
export async function enqueueRetentionSweep(requestedAt: string): Promise<void> {
  const hour = requestedAt.slice(0, 13);
  await addWithStableId(
    getQueues().retention,
    'sweep',
    { requestedAt },
    `retention-${hour}`,
    { attempts: 1 },
  );
}

/**
 * Queues the daily summary. The id carries the date, so a worker restarting
 * six times in a day still produces one report rather than six.
 */
export async function enqueueLearningReport(requestedAt: string): Promise<void> {
  const day = requestedAt.slice(0, 10);
  await addWithStableId(
    getQueues().learningReport,
    'report',
    { requestedAt },
    `learning-${day}`,
    { attempts: 1 },
  );
}

export async function closeQueues(): Promise<void> {
  if (!queues) return;
  await Promise.all(Object.values(queues).map((queue) => queue.close()));
  queues = null;
}

/**
 * Set the alarm for one promised publish. The delay is computed here, from
 * the promise's own clock — and clamped at zero so a promise validated a
 * moment ago can never be rejected by BullMQ for being a millisecond old.
 */
export async function enqueueScheduledPublish(data: ScheduledPublishJob, fireAt: Date): Promise<void> {
  const delay = Math.max(0, fireAt.getTime() - Date.now());
  await addWithStableId(
    getQueues().scheduledPublish,
    'scheduled-publish',
    data,
    `schedpost-${data.scheduledPostId}`,
    { delay },
  );
}

/**
 * Best-effort removal of a canceled promise's alarm. The row's status is
 * what the worker trusts at fire time, so a job that survives this still
 * fires into a no-op — this only saves the wasted wake-up.
 */
export async function removeScheduledPublishJob(scheduledPostId: string): Promise<void> {
  const job = await getQueues().scheduledPublish.getJob(`schedpost-${scheduledPostId}`);
  if (job) await job.remove().catch(() => undefined);
}
