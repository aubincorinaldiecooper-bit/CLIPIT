import { ExternalServiceError } from '../../lib/errors.js';
import { invokeModal, type ModalTarget } from '../modal/invoke.js';

const MODEL = 'MCG-NJU/VideoChat3-4B';
const APP = 'clipit-videochat3';
const CLASS = 'VideoChat3Service';

const WATCH: ModalTarget = { app: APP, className: CLASS, method: 'watch', label: 'videochat3-watch' };
const VERIFY: ModalTarget = { app: APP, className: CLASS, method: 'verify_intervals', label: 'videochat3-verify' };
const HEALTH: ModalTarget = { app: APP, className: CLASS, method: 'health', label: 'videochat3-health' };

export interface VideoChat3WatchEvent {
  startSeconds: number;
  endSeconds: number;
  description: string;
}

export interface VideoChat3WatchResult {
  model: string;
  revision: string;
  durationSeconds: number;
  events: VideoChat3WatchEvent[];
  metrics: Record<string, unknown>;
}

export interface VideoChat3Candidate {
  id: string;
  start: number;
  end: number;
}

export interface VideoChat3Verified {
  id: string;
  startSeconds: number;
  endSeconds: number;
  match: boolean;
  confidence: number;
  description: string;
}

function finite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ExternalServiceError('videochat3', `VideoChat3 returned invalid ${field}`, { retryable: false });
  }
  return value;
}

function identity(raw: Record<string, unknown>): { model: string; revision: string } {
  if (raw.model !== MODEL) {
    throw new ExternalServiceError('videochat3', `VideoChat3 service answered for unexpected model "${String(raw.model)}"`, {
      retryable: false,
    });
  }
  const revision = typeof raw.revision === 'string' && raw.revision.trim() ? raw.revision : 'unknown';
  return { model: MODEL, revision };
}

export async function videoChat3Health(): Promise<{ model: string; revision: string; metrics: Record<string, unknown> }> {
  const raw = await invokeModal<Record<string, unknown>>(HEALTH, {}, { timeoutSeconds: 120, maxRetries: 1 });
  const id = identity(raw);
  if (raw.ok !== true) throw new ExternalServiceError('videochat3-health', 'VideoChat3 health did not report ready', { retryable: false });
  return { ...id, metrics: raw };
}

/** Progressive, query-aware first watch. Returned events are retrieval leads, never final evidence. */
export async function watchWithVideoChat3(input: {
  videoUrl: string;
  query: string;
  expectedBytes?: number;
  targetFps?: number;
  maxRounds?: number;
  maxEvents?: number;
}): Promise<VideoChat3WatchResult> {
  const raw = await invokeModal<Record<string, unknown>>(
    WATCH,
    {
      video_url: input.videoUrl,
      query: input.query,
      expect_bytes: input.expectedBytes ?? null,
      target_fps: input.targetFps ?? 1,
      max_rounds: input.maxRounds ?? 32,
      max_events: input.maxEvents ?? 64,
    },
    { context: { mode: 'watch' } },
  );
  const id = identity(raw);
  const rows = Array.isArray(raw.events) ? raw.events as Array<Record<string, unknown>> : [];
  const events = rows.map((row) => {
    const startSeconds = finite(row.start, 'event start');
    const endSeconds = finite(row.end, 'event end');
    if (startSeconds < 0 || endSeconds <= startSeconds) {
      throw new ExternalServiceError('videochat3-watch', 'VideoChat3 returned an invalid watch interval', { retryable: false });
    }
    return {
      startSeconds,
      endSeconds,
      description: typeof row.description === 'string' ? row.description.trim().slice(0, 1000) : '',
    };
  });
  return {
    ...id,
    durationSeconds: finite(raw.duration_seconds, 'duration'),
    events,
    metrics: (raw.metrics as Record<string, unknown>) ?? {},
  };
}

/** Dense re-watch of exact candidate footage. No candidate is evidence unless match=true. */
export async function verifyWithVideoChat3(input: {
  videoUrl: string;
  query: string;
  candidates: VideoChat3Candidate[];
  expectedBytes?: number;
}): Promise<{
  model: string;
  revision: string;
  results: VideoChat3Verified[];
  failed: Array<{ id: string; reason: string }>;
  metrics: Record<string, unknown>;
}> {
  const ids = new Set(input.candidates.map((candidate) => candidate.id));
  if (ids.size !== input.candidates.length) {
    throw new ExternalServiceError('videochat3-verify', 'candidate ids must be unique', { retryable: false });
  }
  const raw = await invokeModal<Record<string, unknown>>(
    VERIFY,
    {
      video_url: input.videoUrl,
      query: input.query,
      candidates: input.candidates,
      expect_bytes: input.expectedBytes ?? null,
    },
    { context: { mode: 'verify', candidates: input.candidates.length } },
  );
  const id = identity(raw);
  const seen = new Set<string>();
  const results: VideoChat3Verified[] = [];
  for (const row of (Array.isArray(raw.results) ? raw.results : []) as Array<Record<string, unknown>>) {
    const candidateId = typeof row.id === 'string' ? row.id : '';
    if (!ids.has(candidateId) || seen.has(candidateId)) {
      throw new ExternalServiceError('videochat3-verify', `unexpected or duplicate candidate "${candidateId}"`, { retryable: false });
    }
    seen.add(candidateId);
    const startSeconds = finite(row.start, 'verification start');
    const endSeconds = finite(row.end, 'verification end');
    const confidence = finite(row.confidence, 'verification confidence');
    if (confidence < 0 || confidence > 1 || endSeconds <= startSeconds) {
      throw new ExternalServiceError('videochat3-verify', `invalid verdict returned for "${candidateId}"`, { retryable: false });
    }
    results.push({
      id: candidateId,
      startSeconds,
      endSeconds,
      match: row.match === true,
      confidence,
      description: typeof row.description === 'string' ? row.description.trim().slice(0, 500) : '',
    });
  }
  const failed: Array<{ id: string; reason: string }> = [];
  const failedIds = new Set<string>();
  for (const row of (Array.isArray(raw.failed) ? raw.failed : []) as Array<Record<string, unknown>>) {
    const candidateId = typeof row.id === 'string' ? row.id : '';
    if (!ids.has(candidateId) || seen.has(candidateId) || failedIds.has(candidateId)) {
      throw new ExternalServiceError('videochat3-verify', `invalid failure returned for "${candidateId}"`, { retryable: false });
    }
    failedIds.add(candidateId);
    failed.push({ id: candidateId, reason: typeof row.reason === 'string' ? row.reason : 'verification failed' });
  }
  for (const candidate of input.candidates) {
    if (!seen.has(candidate.id) && !failedIds.has(candidate.id)) {
      failed.push({ id: candidate.id, reason: 'VideoChat3 returned neither a verdict nor a failure' });
    }
  }
  return {
    ...id,
    results,
    failed,
    metrics: (raw.metrics as Record<string, unknown>) ?? {},
  };
}
