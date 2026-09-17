import { QueueEmptyError } from 'modal';
import { ExternalServiceError } from '../../lib/errors.js';
import type { FrameStreamVideoSource } from '../video/source.js';
import { assertModalTargetAvailable, createEphemeralModalQueue, invokeModal, spawnModal, type ModalTarget } from '../modal/invoke.js';

const MODEL = 'MCG-NJU/VideoChat3-4B';
const APP = 'clipit-videochat3';
const CLASS = 'VideoChat3Service';

const WATCH: ModalTarget = { app: APP, className: CLASS, method: 'watch', label: 'videochat3-watch' };
const WATCH_STREAM: ModalTarget = { app: APP, className: CLASS, method: 'watch_stream', label: 'videochat3-watch-stream' };
const VERIFY: ModalTarget = { app: APP, className: CLASS, method: 'verify_intervals', label: 'videochat3-verify' };
const HEALTH: ModalTarget = { app: APP, className: CLASS, method: 'health', label: 'videochat3-health' };

export interface VideoChat3WatchEvent {
  startSeconds: number;
  endSeconds: number;
  description: string;
  /** How sure the watcher said it was, 0 to 1. Absent when it did not say. */
  confidence?: number;
}
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
function sureness(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > 1) return undefined;
  return value;
}
function envNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(minimum, Math.min(maximum, raw));
}

function parseEvent(row: Record<string, unknown>): VideoChat3WatchEvent {
  const startSeconds = finite(row.start, 'event start');
  const endSeconds = finite(row.end, 'event end');
  if (startSeconds < 0 || endSeconds <= startSeconds) throw new ExternalServiceError('videochat3-watch', 'VideoChat3 returned an invalid watch interval', { retryable: false });
  const confidence = sureness(row.confidence);
  return {
    startSeconds,
    endSeconds,
    description: typeof row.description === 'string' ? row.description.trim().slice(0, 1000) : '',
    ...(confidence === undefined ? {} : { confidence }),
  };
}

/**
 * Check that the deployed VideoChat3 still offers the method we are about to
 * call, before a search spends anything on the assumption that it does.
 *
 * Being deployed is not the same as being compatible. On 17 September the
 * service was up, healthy and answering, and had no `watch_stream` on it — the
 * deployment predated the live-watch method the searches call. Every watch
 * failed identically, and because each failure only appeared once the browser
 * work had been set up, the whole search died twenty-eight times over before
 * anyone could be told why.
 *
 * This resolves the method handle and stops there: the same lookup `spawnModal`
 * does, without the call that follows it. Handles are cached in the Modal
 * layer, so the search's own spawn reuses what this resolved rather than
 * repeating it.
 */
export async function assertVideoChat3Ready(method: 'watch' | 'watch_stream'): Promise<void> {
  await assertModalTargetAvailable(method === 'watch_stream' ? WATCH_STREAM : WATCH);
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

/**
 * Feed a timestamped browser stream into one stateful VideoChat3 session.
 *
 * V2 deliberately separates capture density from inference cadence. The browser
 * may supply six frames each second, while Modal groups those frames into one
 * temporal round. A small in-flight ceiling keeps the model close to the live
 * player: when inference falls behind, we discard excess observations rather
 * than building a queue that turns "realtime" into delayed playback.
 */
export async function watchStreamWithVideoChat3(input: {
  source: FrameStreamVideoSource;
  query: string;
  signal?: AbortSignal;
  maxRounds?: number;
  maxEvents?: number;
  realtimeV2?: boolean;
  onMoment?: (event: VideoChat3WatchEvent) => void | Promise<void>;
}): Promise<VideoChat3WatchResult> {
  const inputQueue = await createEphemeralModalQueue();
  const outputQueue = await createEphemeralModalQueue();
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(input.signal?.reason ?? new Error('live watch cancelled'));
  if (input.signal?.aborted) forwardAbort(); else input.signal?.addEventListener('abort', forwardAbort, { once: true });

  const realtimeV2 = input.realtimeV2 === true;
  const historyRounds = realtimeV2
    ? Math.round(input.maxRounds ?? envNumber('VIDEO_STREAM_HISTORY_ROUNDS', 16, 1, 64))
    : Math.round(input.maxRounds ?? 256);
  const maxFrames = realtimeV2
    ? Math.round(envNumber('VIDEO_STREAM_MAX_FRAMES', 4096, 1, 100_000))
    : Math.round(input.maxRounds ?? 256);
  const roundWindowMs = realtimeV2
    ? Math.round(envNumber('VIDEO_STREAM_ROUND_MS', 1000, 100, 5000))
    : 0;
  const maxInflightFrames = realtimeV2
    ? Math.round(envNumber('VIDEO_STREAM_MAX_INFLIGHT_FRAMES', 12, 1, 120))
    : Number.MAX_SAFE_INTEGER;
  const normalMaxPixels = realtimeV2
    ? Math.round(envNumber('VIDEOCHAT3_STREAM_NORMAL_MAX_PIXELS', 224 * 224, 28 * 28, 2_000_000))
    : 100352;
  const standbyMaxPixels = realtimeV2
    ? Math.round(envNumber('VIDEOCHAT3_STREAM_STANDBY_MAX_PIXELS', normalMaxPixels * 4, normalMaxPixels, 4_000_000))
    : 100352;

  let sentFrames = 0;
  let processedFrames = 0;
  let droppedFrames = 0;
  let latestProducedMs = 0;
  let latestProcessedMs = 0;
  let currentLagMs = 0;
  let maxLagMs = 0;

  const refreshLag = () => {
    currentLagMs = Math.max(0, latestProducedMs - latestProcessedMs);
    maxLagMs = Math.max(maxLagMs, currentLagMs);
  };

  let remote: Awaited<ReturnType<typeof spawnModal>> | null = null;
  try {
    remote = await spawnModal(WATCH_STREAM, {
      input_queue_id: inputQueue.queueId,
      output_queue_id: outputQueue.queueId,
      query: input.query,
      max_rounds: historyRounds,
      max_frames: maxFrames,
      max_events: input.maxEvents ?? 64,
      round_window_ms: roundWindowMs,
      adaptive_resolution: realtimeV2,
      normal_max_pixels: normalMaxPixels,
      standby_max_pixels: standbyMaxPixels,
    });

    let producerFailure: unknown = null;
    const producer = (async () => {
      try {
        for await (const frame of input.source.open(controller.signal)) {
          if (controller.signal.aborted) break;
          latestProducedMs = Math.max(latestProducedMs, frame.timestampMs + frame.durationMs);
          refreshLag();

          // At six capture fps, twelve in-flight frames are about two seconds
          // of visual evidence. Past that point freshness is more valuable than
          // preserving every stale frame, so consume the browser stream but do
          // not enqueue another model item until progress catches up.
          if (realtimeV2 && sentFrames - processedFrames >= maxInflightFrames) {
            droppedFrames += 1;
            continue;
          }

          const encoded = frame.image.toString('base64');
          if (encoded.length > 980_000) throw new ExternalServiceError('videochat3-watch-stream', 'browser frame exceeds Modal queue item limit', { retryable: false });
          await inputQueue.put({ type: 'frame', timestamp_ms: frame.timestampMs, duration_ms: frame.durationMs, image_base64: encoded }, { timeoutMs: 30_000 });
          sentFrames += 1;
        }
        const completion = await input.source.completion;
        latestProducedMs = Math.max(latestProducedMs, completion.watchedThroughSeconds * 1000);
        refreshLag();
        await inputQueue.put({
          type: 'end',
          exhausted: completion.exhausted,
          reason: completion.reason,
          watched_through_seconds: completion.watchedThroughSeconds,
          dropped_frames: droppedFrames,
        }, { timeoutMs: 30_000 });
      } catch (error) {
        if (!controller.signal.aborted) {
          await inputQueue.put({
            type: 'end',
            exhausted: false,
            reason: error instanceof Error ? error.message : String(error),
            watched_through_seconds: latestProducedMs / 1000,
            dropped_frames: droppedFrames,
          }, { timeoutMs: 5_000 }).catch(() => undefined);
          throw error;
        }
      }
    })().catch((error: unknown) => {
      // Attach the rejection handler immediately. Without this, a browser-side
      // failure such as "no video element on the page" can reject the producer
      // before the consumer awaits it, which Node treats as an unhandled
      // rejection and terminates the whole worker process.
      producerFailure = error;
      if (!controller.signal.aborted) controller.abort(error);
    });

    const events: VideoChat3WatchEvent[] = [];
    let done: Record<string, unknown> | null = null;
    while (!done) {
      if (controller.signal.aborted) throw controller.signal.reason ?? new Error('live watch cancelled');
      let message: unknown;
      try { message = await outputQueue.get({ timeoutMs: 5_000 }); }
      catch (error) { if (error instanceof QueueEmptyError) continue; throw error; }
      if (!message || typeof message !== 'object') continue;
      const row = message as Record<string, unknown>;
      if (row.type === 'progress') {
        if (typeof row.frames_processed === 'number' && Number.isFinite(row.frames_processed)) {
          processedFrames = Math.max(processedFrames, row.frames_processed);
        }
        if (typeof row.processed_through_ms === 'number' && Number.isFinite(row.processed_through_ms)) {
          latestProcessedMs = Math.max(latestProcessedMs, row.processed_through_ms);
        }
        refreshLag();
      } else if (row.type === 'moment') {
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
    await producer;
    if (producerFailure) throw producerFailure;
    await remote.get();
    const id = identity(done);
    const remoteMetrics = done.metrics && typeof done.metrics === 'object' ? done.metrics as Record<string, unknown> : {};
    return {
      ...id,
      durationSeconds: finite(done.duration_seconds, 'stream duration'),
      watchedThroughSeconds: finite(done.watched_through_seconds, 'watched through'),
      exhausted: done.exhausted === true,
      events,
      metrics: {
        ...remoteMetrics,
        realtime_v2: realtimeV2,
        client_frames_sent: sentFrames,
        client_frames_processed: processedFrames,
        client_frames_dropped_for_lag: droppedFrames,
        latest_source_ms: latestProducedMs,
        latest_processed_ms: latestProcessedMs,
        current_video_lag_ms: currentLagMs,
        max_video_lag_ms: maxLagMs,
        max_inflight_frames: realtimeV2 ? maxInflightFrames : null,
      },
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
