import { QueueEmptyError } from 'modal';
import { ExternalServiceError } from '../../lib/errors.js';
import type { FrameStreamVideoSource } from '../video/source.js';
import { createEphemeralModalQueue, invokeModal, spawnModal, type ModalTarget } from '../modal/invoke.js';

const MODEL = 'MCG-NJU/VideoChat3-4B';
const APP = 'clipit-videochat3';
const CLASS = 'VideoChat3Service';

const WATCH: ModalTarget = { app: APP, className: CLASS, method: 'watch', label: 'videochat3-watch' };
const WATCH_STREAM: ModalTarget = { app: APP, className: CLASS, method: 'watch_stream', label: 'videochat3-watch-stream' };
const VERIFY: ModalTarget = { app: APP, className: CLASS, method: 'verify_intervals', label: 'videochat3-verify' };
const HEALTH: ModalTarget = { app: APP, className: CLASS, method: 'health', label: 'videochat3-health' };

export interface VideoChat3WatchEvent { startSeconds: number; endSeconds: number; description: string; }
export interface VideoChat3WatchResult {
  model: string;
  revision: string;
  durationSeconds: number;
  watchedThroughSeconds?: number;
  exhausted?: boolean;
  events: VideoChat3WatchEvent[];
  metrics: Record<string, unknown>;
}
export interface VideoChat3Candidate { id: string; start: number; end: number; transcript?: string; }
export interface VideoChat3Verified { id: string; startSeconds: number; endSeconds: number; match: boolean; confidence: number; description: string; }

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ExternalServiceError('videochat3', `VideoChat3 returned invalid ${field}`, { retryable: false });
  return value;
}
function identity(raw: Record<string, unknown>): { model: string; revision: string } {
  if (raw.model !== MODEL) throw new ExternalServiceError('videochat3', `VideoChat3 service answered for unexpected model "${String(raw.model)}"`, { retryable: false });
  return { model: MODEL, revision: typeof raw.revision === 'string' && raw.revision.trim() ? raw.revision : 'unknown' };
}
function parseEvent(row: Record<string, unknown>): VideoChat3WatchEvent {
  const startSeconds = finite(row.start, 'event start');
  const endSeconds = finite(row.end, 'event end');
  if (startSeconds < 0 || endSeconds <= startSeconds) throw new ExternalServiceError('videochat3-watch', 'VideoChat3 returned an invalid watch interval', { retryable: false });
  return { startSeconds, endSeconds, description: typeof row.description === 'string' ? row.description.trim().slice(0, 1000) : '' };
}

export async function videoChat3Health(): Promise<{ model: string; revision: string; metrics: Record<string, unknown> }> {
  const raw = await invokeModal<Record<string, unknown>>(HEALTH, {}, { timeoutSeconds: 120, maxRetries: 1 });
  const id = identity(raw);
  if (raw.ok !== true) throw new ExternalServiceError('videochat3-health', 'VideoChat3 health did not report ready', { retryable: false });
  return { ...id, metrics: raw };
}

const WATCH_TIMEOUT_SECONDS = 1800;

export async function watchWithVideoChat3(input: { videoUrl: string; query: string; expectedBytes?: number; targetFps?: number; maxRounds?: number; maxEvents?: number; }): Promise<VideoChat3WatchResult> {
  const raw = await invokeModal<Record<string, unknown>>(WATCH, {
    video_url: input.videoUrl, query: input.query, expected_bytes: input.expectedBytes ?? null,
    target_fps: input.targetFps ?? 1, max_rounds: input.maxRounds ?? 32, max_events: input.maxEvents ?? 64,
  }, { context: { mode: 'watch' }, timeoutSeconds: WATCH_TIMEOUT_SECONDS });
  const id = identity(raw);
  const events = (Array.isArray(raw.events) ? raw.events as Array<Record<string, unknown>> : []).map(parseEvent);
  const durationSeconds = finite(raw.duration_seconds, 'duration');
  return { ...id, durationSeconds, watchedThroughSeconds: durationSeconds, exhausted: true, events, metrics: (raw.metrics as Record<string, unknown>) ?? {} };
}

/** Feed a real timestamped browser stream into one stateful VideoChat3 session. */
export async function watchStreamWithVideoChat3(input: {
  source: FrameStreamVideoSource;
  query: string;
  signal?: AbortSignal;
  maxRounds?: number;
  maxEvents?: number;
  onMoment?: (event: VideoChat3WatchEvent) => void | Promise<void>;
}): Promise<VideoChat3WatchResult> {
  const inputQueue = await createEphemeralModalQueue();
  const outputQueue = await createEphemeralModalQueue();
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(input.signal?.reason ?? new Error('live watch cancelled'));
  if (input.signal?.aborted) forwardAbort(); else input.signal?.addEventListener('abort', forwardAbort, { once: true });

  let remote: Awaited<ReturnType<typeof spawnModal>> | null = null;
  try {
    remote = await spawnModal(WATCH_STREAM, {
      input_queue_id: inputQueue.queueId,
      output_queue_id: outputQueue.queueId,
      query: input.query,
      max_rounds: input.maxRounds ?? 256,
      max_events: input.maxEvents ?? 64,
    });

    const producer = (async () => {
      try {
        for await (const frame of input.source.open(controller.signal)) {
          if (controller.signal.aborted) break;
          const encoded = frame.image.toString('base64');
          if (encoded.length > 980_000) throw new ExternalServiceError('videochat3-watch-stream', 'browser frame exceeds Modal queue item limit', { retryable: false });
          await inputQueue.put({ type: 'frame', timestamp_ms: frame.timestampMs, duration_ms: frame.durationMs, image_base64: encoded }, { timeoutMs: 30_000 });
        }
        const completion = await input.source.completion;
        await inputQueue.put({ type: 'end', exhausted: completion.exhausted, reason: completion.reason, watched_through_seconds: completion.watchedThroughSeconds }, { timeoutMs: 30_000 });
      } catch (error) {
        if (!controller.signal.aborted) {
          await inputQueue.put({ type: 'end', exhausted: false, reason: error instanceof Error ? error.message : String(error), watched_through_seconds: 0 }, { timeoutMs: 5_000 }).catch(() => undefined);
          throw error;
        }
      }
    })();

    const events: VideoChat3WatchEvent[] = [];
    let done: Record<string, unknown> | null = null;
    while (!done) {
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error('live watch cancelled');
      let message: unknown;
      try { message = await outputQueue.get({ timeoutMs: 5_000 }); }
      catch (error) { if (error instanceof QueueEmptyError) continue; throw error; }
      if (!message || typeof message !== 'object') continue;
      const row = message as Record<string, unknown>;
      if (row.type === 'moment') {
        const event = parseEvent(row);
        events.push(event);
        await input.onMoment?.(event);
      } else if (row.type === 'error') {
        throw new ExternalServiceError('videochat3-watch-stream', typeof row.reason === 'string' ? row.reason : 'VideoChat3 live watch failed', { retryable: true });
      } else if (row.type === 'done') {
        done = row;
      }
    }

    controller.abort(new Error('VideoChat3 live watch complete'));
    await producer.catch((error) => {
      if (!(error instanceof Error && /complete|cancel/i.test(error.message))) throw error;
    });
    await remote.get();
    const id = identity(done);
    return {
      ...id,
      durationSeconds: finite(done.duration_seconds, 'stream duration'),
      watchedThroughSeconds: finite(done.watched_through_seconds, 'watched through'),
      exhausted: done.exhausted === true,
      events,
      metrics: (done.metrics as Record<string, unknown>) ?? {},
    };
  } finally {
    controller.abort(new Error('live watch closed'));
    input.signal?.removeEventListener('abort', forwardAbort);
    inputQueue.closeEphemeral();
    outputQueue.closeEphemeral();
  }
}

export async function verifyWithVideoChat3(input: { videoUrl: string; query: string; candidates: VideoChat3Candidate[]; expectedBytes?: number; }): Promise<{ model: string; revision: string; results: VideoChat3Verified[]; failed: Array<{ id: string; reason: string }>; metrics: Record<string, unknown>; }> {
  const ids = new Set(input.candidates.map((candidate) => candidate.id));
  if (ids.size !== input.candidates.length) throw new ExternalServiceError('videochat3-verify', 'candidate ids must be unique', { retryable: false });
  for (const candidate of input.candidates) if (candidate.transcript !== undefined && candidate.transcript.length > 12_000) throw new ExternalServiceError('videochat3-verify', 'candidate transcript is too large', { retryable: false });
  const raw = await invokeModal<Record<string, unknown>>(VERIFY, { video_url: input.videoUrl, query: input.query, candidates: input.candidates, expected_bytes: input.expectedBytes ?? null }, { context: { mode: 'verify', candidates: input.candidates.length } });
  const id = identity(raw);
  const seen = new Set<string>();
  const results: VideoChat3Verified[] = [];
  for (const row of (Array.isArray(raw.results) ? raw.results : []) as Array<Record<string, unknown>>) {
    const candidateId = typeof row.id === 'string' ? row.id : '';
    if (!ids.has(candidateId) || seen.has(candidateId)) throw new ExternalServiceError('videochat3-verify', `unexpected or duplicate candidate "${candidateId}"`, { retryable: false });
    seen.add(candidateId);
    const startSeconds = finite(row.start, 'verification start'); const endSeconds = finite(row.end, 'verification end'); const confidence = finite(row.confidence, 'verification confidence');
    if (confidence < 0 || confidence > 1 || endSeconds <= startSeconds) throw new ExternalServiceError('videochat3-verify', `invalid verdict returned for "${candidateId}"`, { retryable: false });
    results.push({ id: candidateId, startSeconds, endSeconds, match: row.match === true, confidence, description: typeof row.description === 'string' ? row.description.trim().slice(0, 500) : '' });
  }
  const failed: Array<{ id: string; reason: string }> = []; const failedIds = new Set<string>();
  for (const row of (Array.isArray(raw.failed) ? raw.failed : []) as Array<Record<string, unknown>>) {
    const candidateId = typeof row.id === 'string' ? row.id : '';
    if (!ids.has(candidateId) || seen.has(candidateId) || failedIds.has(candidateId)) throw new ExternalServiceError('videochat3-verify', `invalid failure returned for "${candidateId}"`, { retryable: false });
    failedIds.add(candidateId); failed.push({ id: candidateId, reason: typeof row.reason === 'string' ? row.reason : 'verification failed' });
  }
  for (const candidate of input.candidates) if (!seen.has(candidate.id) && !failedIds.has(candidate.id)) failed.push({ id: candidate.id, reason: 'VideoChat3 returned neither a verdict nor a failure' });
  return { ...id, results, failed, metrics: (raw.metrics as Record<string, unknown>) ?? {} };
}
