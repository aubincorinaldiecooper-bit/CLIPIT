import { ExternalServiceError } from '../../lib/errors.js';
import type { VideoSource, VideoSourceKind } from './source.js';

export interface VideoMoment {
  startSeconds: number;
  endSeconds: number;
  description: string;
  confidence?: number;
}

export interface VideoWatchResult {
  model: string;
  revision: string;
  durationSeconds: number;
  watchedThroughSeconds: number;
  moments: VideoMoment[];
  metrics: Record<string, unknown>;
}

export interface VideoVerificationCandidate {
  id: string;
  start: number;
  end: number;
  transcript?: string;
}

export interface VideoVerificationResult {
  id: string;
  startSeconds: number;
  endSeconds: number;
  match: boolean;
  confidence: number;
  description: string;
}

export interface VideoVerificationBatch {
  model: string;
  revision: string;
  results: VideoVerificationResult[];
  failed: Array<{ id: string; reason: string }>;
  metrics: Record<string, unknown>;
}

/**
 * The model-side USB port.
 *
 * Orchestration asks a model to watch a source. The adapter declares which
 * source representations it accepts, so a file-only model cannot accidentally
 * be handed a live browser stream and a stream-native model does not need to
 * know anything about buckets or signed URLs.
 */
export interface VideoModelAdapter {
  readonly id: string;
  readonly sourceKinds: ReadonlySet<VideoSourceKind>;

  watch(input: {
    source: VideoSource;
    query: string;
    signal?: AbortSignal;
    maxEvents?: number;
  }): Promise<VideoWatchResult>;

  /** Optional because not every watcher has a separate dense-verification API. */
  verify?(input: {
    source: VideoSource;
    query: string;
    candidates: VideoVerificationCandidate[];
    signal?: AbortSignal;
  }): Promise<VideoVerificationBatch>;
}

export function assertModelAcceptsSource(model: VideoModelAdapter, source: VideoSource): void {
  if (model.sourceKinds.has(source.kind)) return;
  throw new ExternalServiceError(
    'video-model',
    `${model.id} cannot read video source kind "${source.kind}"`,
    { retryable: false },
  );
}

/**
 * One place for orchestration to cross the model boundary.
 *
 * Keeping this check outside each adapter makes capability failures explicit
 * and testable before any provider call is attempted.
 */
export async function watchVideo(input: {
  model: VideoModelAdapter;
  source: VideoSource;
  query: string;
  signal?: AbortSignal;
  maxEvents?: number;
}): Promise<VideoWatchResult> {
  assertModelAcceptsSource(input.model, input.source);
  return input.model.watch({
    source: input.source,
    query: input.query,
    signal: input.signal,
    maxEvents: input.maxEvents,
  });
}

export async function verifyVideo(input: {
  model: VideoModelAdapter;
  source: VideoSource;
  query: string;
  candidates: VideoVerificationCandidate[];
  signal?: AbortSignal;
}): Promise<VideoVerificationBatch> {
  assertModelAcceptsSource(input.model, input.source);
  if (!input.model.verify) {
    throw new ExternalServiceError('video-model', `${input.model.id} does not expose interval verification`, { retryable: false });
  }
  return input.model.verify({
    source: input.source,
    query: input.query,
    candidates: input.candidates,
    signal: input.signal,
  });
}
