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
  exhausted?: boolean;
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

export interface VideoModelAdapter {
  readonly id: string;
  readonly sourceKinds: ReadonlySet<VideoSourceKind>;
  watch(input: {
    source: VideoSource;
    query: string;
    signal?: AbortSignal;
    maxEvents?: number;
    onMoment?: (moment: VideoMoment) => void | Promise<void>;
  }): Promise<VideoWatchResult>;
  verify?(input: {
    source: VideoSource;
    query: string;
    candidates: VideoVerificationCandidate[];
    signal?: AbortSignal;
  }): Promise<VideoVerificationBatch>;
}

export function assertModelAcceptsSource(model: VideoModelAdapter, source: VideoSource): void {
  if (model.sourceKinds.has(source.kind)) return;
  throw new ExternalServiceError('video-model', `${model.id} cannot read video source kind "${source.kind}"`, { retryable: false });
}

export async function watchVideo(input: {
  model: VideoModelAdapter;
  source: VideoSource;
  query: string;
  signal?: AbortSignal;
  maxEvents?: number;
  onMoment?: (moment: VideoMoment) => void | Promise<void>;
}): Promise<VideoWatchResult> {
  assertModelAcceptsSource(input.model, input.source);
  return input.model.watch({ source: input.source, query: input.query, signal: input.signal, maxEvents: input.maxEvents, onMoment: input.onMoment });
}

export async function verifyVideo(input: {
  model: VideoModelAdapter;
  source: VideoSource;
  query: string;
  candidates: VideoVerificationCandidate[];
  signal?: AbortSignal;
}): Promise<VideoVerificationBatch> {
  assertModelAcceptsSource(input.model, input.source);
  if (!input.model.verify) throw new ExternalServiceError('video-model', `${input.model.id} does not expose interval verification`, { retryable: false });
  return input.model.verify({ source: input.source, query: input.query, candidates: input.candidates, signal: input.signal });
}
