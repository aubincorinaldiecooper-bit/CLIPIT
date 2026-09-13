import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../../config/env.js';
import { ExternalServiceError } from '../../../lib/errors.js';
import type { SimpleMemItem, SimpleMemModality } from './candidates.js';

export interface SimpleMemHealth {
  ok: boolean;
  models: {
    caption: string;
    visual: string;
    textEmbedding: string;
    transcription: string;
  };
  version: string;
  embeddingVersion: string;
  transformersVersion: string;
}

export interface SimpleMemCaptionStats {
  attempted: number;
  captioned: number;
  retried: number;
  failed: number;
  lastError: string | null;
}

export interface SimpleMemIndexReply {
  videoMauId: string;
  fps: number;
  framesExtracted: number;
  framesProcessed: number;
  framesSkipped: number;
  coveredThroughSeconds: number;
  audioTranscribed: boolean;
  captions: SimpleMemCaptionStats | null;
  elapsedMs: number;
}

export interface SimpleMemQueryReply {
  items: SimpleMemItem[];
  totalCandidates: number;
  elapsedMs: number;
}

const SERVICE = 'simplemem';
const MODALITIES: ReadonlySet<string> = new Set(['text', 'visual', 'audio', 'video', 'multimodal']);

function baseUrl(): string {
  if (!env.SIMPLEMEM_URL) {
    throw new ExternalServiceError(SERVICE, 'SIMPLEMEM_URL is not configured', { retryable: false });
  }
  return env.SIMPLEMEM_URL.replace(/\/+$/, '');
}

function internalToken(): string {
  const value = env.SIMPLEMEM_INTERNAL_TOKEN?.trim();
  if (!value || value.length < 32) {
    throw new ExternalServiceError(SERVICE, 'SIMPLEMEM_INTERNAL_TOKEN is not configured', { retryable: false });
  }
  return value;
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ExternalServiceError(SERVICE, `Sidecar reply field "${field}" is not a finite number`, { retryable: false });
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = finiteNumber(value, field);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ExternalServiceError(SERVICE, `Sidecar reply field "${field}" is not a non-negative integer`, { retryable: false });
  }
  return parsed;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ExternalServiceError(SERVICE, `Sidecar reply field "${field}" is not a non-empty string`, { retryable: false });
  }
  return value;
}

async function request<T>(method: string, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), init.timeoutMs ?? env.SIMPLEMEM_REQUEST_TIMEOUT_MS);
  const headers = new Headers(init.headers);
  headers.set('X-Clipit-SimpleMem-Token', internalToken());
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers, method, signal: controller.signal });
  } catch (error) {
    const aborted = (error as Error).name === 'AbortError';
    throw new ExternalServiceError(
      SERVICE,
      aborted ? `SimpleMem request timed out (${method} ${url})` : `SimpleMem request failed: ${(error as Error).message}`,
      { retryable: true, cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new ExternalServiceError(SERVICE, `SimpleMem answered ${response.status}: ${text.slice(0, 300)}`, {
      retryable: response.status >= 500,
    });
  }
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ExternalServiceError(SERVICE, 'SimpleMem reply was not JSON', { retryable: false, cause: error });
  }
}

export function readHealthReply(raw: Record<string, unknown>): SimpleMemHealth {
  const models = (raw.models ?? {}) as Record<string, unknown>;
  const libraries = (raw.libraries ?? {}) as Record<string, unknown>;
  return {
    ok: raw.ok === true,
    models: {
      caption: nonEmptyString(models.caption, 'models.caption'),
      visual: nonEmptyString(models.visual, 'models.visual'),
      textEmbedding: nonEmptyString(models.text_embedding, 'models.text_embedding'),
      transcription: nonEmptyString(models.transcription, 'models.transcription'),
    },
    version: typeof raw.version === 'string' ? raw.version : 'unknown',
    embeddingVersion: nonEmptyString(raw.embeddingVersion, 'embeddingVersion'),
    transformersVersion: nonEmptyString(libraries.transformers, 'libraries.transformers'),
  };
}

export async function simplememHealth(): Promise<SimpleMemHealth> {
  return readHealthReply(await request<Record<string, unknown>>('GET', `${baseUrl()}/ready`, { timeoutMs: 15_000 }));
}

function readCaptionStats(raw: unknown): SimpleMemCaptionStats | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') {
    throw new ExternalServiceError(SERVICE, 'Sidecar reply has a malformed "captions" field', { retryable: false });
  }
  const row = raw as Record<string, unknown>;
  const attempted = nonNegativeInteger(row.attempted, 'captions.attempted');
  const captioned = nonNegativeInteger(row.captioned, 'captions.captioned');
  const retried = nonNegativeInteger(row.retried, 'captions.retried');
  const failed = nonNegativeInteger(row.failed, 'captions.failed');
  if (captioned + failed !== attempted || retried > attempted) {
    throw new ExternalServiceError(SERVICE, 'Sidecar reply has inconsistent caption counts', { retryable: false });
  }
  return {
    attempted,
    captioned,
    retried,
    failed,
    lastError: typeof row.lastError === 'string' && row.lastError.trim() ? row.lastError.trim().slice(0, 300) : null,
  };
}

export function readIndexReply(raw: Record<string, unknown>): SimpleMemIndexReply {
  return {
    videoMauId: nonEmptyString(raw.videoMauId, 'videoMauId'),
    fps: finiteNumber(raw.fps, 'fps'),
    framesExtracted: finiteNumber(raw.framesExtracted, 'framesExtracted'),
    framesProcessed: finiteNumber(raw.framesProcessed, 'framesProcessed'),
    framesSkipped: finiteNumber(raw.framesSkipped, 'framesSkipped'),
    coveredThroughSeconds: finiteNumber(raw.coveredThroughSeconds, 'coveredThroughSeconds'),
    audioTranscribed: raw.audioTranscribed === true,
    captions: readCaptionStats(raw.captions),
    elapsedMs: finiteNumber(raw.elapsedMs, 'elapsedMs'),
  };
}

export async function simplememIndexVideo(input: {
  videoId: string;
  filePath: string;
  fps: number;
  maxFrames: number;
  durationSeconds: number;
}): Promise<SimpleMemIndexReply> {
  const form = new FormData();
  form.set('fps', String(input.fps));
  form.set('max_frames', String(input.maxFrames));
  form.set('duration_seconds', String(input.durationSeconds));
  const bytes = await readFile(input.filePath);
  form.set('file', new File([bytes], path.basename(input.filePath), { type: 'video/mp4' }));

  const raw = await request<Record<string, unknown>>('PUT', `${baseUrl()}/videos/${encodeURIComponent(input.videoId)}`, {
    body: form,
    timeoutMs: env.SIMPLEMEM_INDEX_TIMEOUT_MS,
  });
  return readIndexReply(raw);
}

export function readQueryReply(raw: Record<string, unknown>): SimpleMemQueryReply {
  const rows = Array.isArray(raw.items) ? raw.items : null;
  if (!rows) {
    throw new ExternalServiceError(SERVICE, 'Sidecar reply has no "items" array', { retryable: false });
  }
  const seen = new Set<string>();
  const items: SimpleMemItem[] = [];
  for (const row of rows as Array<Record<string, unknown>>) {
    const mauId = nonEmptyString(row.mauId, 'items[].mauId');
    if (seen.has(mauId)) {
      throw new ExternalServiceError(SERVICE, `Sidecar returned "${mauId}" twice`, { retryable: false });
    }
    seen.add(mauId);
    const modality = row.modality;
    if (typeof modality !== 'string' || !MODALITIES.has(modality)) {
      throw new ExternalServiceError(SERVICE, `Sidecar returned an unknown modality for "${mauId}": ${String(modality)}`, {
        retryable: false,
      });
    }
    const frameIndex = row.frameIndex === null || row.frameIndex === undefined ? null : finiteNumber(row.frameIndex, 'items[].frameIndex');
    const seconds = row.seconds === null || row.seconds === undefined ? null : finiteNumber(row.seconds, 'items[].seconds');
    if (seconds !== null && seconds < 0) {
      throw new ExternalServiceError(SERVICE, `Sidecar placed "${mauId}" at a negative second`, { retryable: false });
    }
    items.push({
      mauId,
      modality: modality as SimpleMemModality,
      score: finiteNumber(row.score, 'items[].score'),
      summary: typeof row.summary === 'string' ? row.summary.trim().slice(0, 500) : '',
      frameIndex,
      seconds,
    });
  }
  return {
    items,
    totalCandidates: typeof raw.totalCandidates === 'number' && Number.isFinite(raw.totalCandidates) ? raw.totalCandidates : items.length,
    elapsedMs: typeof raw.elapsedMs === 'number' && Number.isFinite(raw.elapsedMs) ? raw.elapsedMs : 0,
  };
}

export async function simplememQuery(input: { videoId: string; query: string; topK: number }): Promise<SimpleMemQueryReply> {
  const raw = await request<Record<string, unknown>>('POST', `${baseUrl()}/videos/${encodeURIComponent(input.videoId)}/query`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: input.query, top_k: input.topK }),
  });
  return readQueryReply(raw);
}

export async function simplememDeleteVideo(videoId: string): Promise<void> {
  await request<Record<string, unknown>>('DELETE', `${baseUrl()}/videos/${encodeURIComponent(videoId)}`, { timeoutMs: 60_000 });
}
