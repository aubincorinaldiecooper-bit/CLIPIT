import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../../config/env.js';
import { ExternalServiceError } from '../../../lib/errors.js';
import type { SimpleMemItem, SimpleMemModality } from './candidates.js';

/**
 * Clipit's side of the Omni-SimpleMem sidecar.
 *
 * The sidecar (tools/simplemem/sidecar.py) is a thin wrapper over the
 * library's own orchestrator: one memory per video, the frame rate chosen
 * by Clipit, each returned frame carrying the second of the video it was
 * taken from, and a delete. Nothing in it re-implements SimpleMem; it only
 * calls the library's public API and hands the answers back with the one
 * fact SimpleMem drops on the way in — where in the video a frame came from.
 *
 * Everything the sidecar returns is untrusted input and is checked before it
 * is believed, on the same rule the Media Index applies to a vector: a wrong
 * number here does not fail loudly, it becomes a moment at the wrong second.
 */

export interface SimpleMemHealth {
  ok: boolean;
  /** What the library will run, as it reported them. */
  models: {
    caption: string;
    visual: string;
    textEmbedding: string;
    transcription: string;
  };
  version: string;
}

export interface SimpleMemIndexReply {
  videoMauId: string;
  fps: number;
  framesExtracted: number;
  framesProcessed: number;
  framesSkipped: number;
  /** How far into the video SimpleMem looked. Bounded by max_frames / fps. */
  coveredThroughSeconds: number;
  audioTranscribed: boolean;
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
  const value = process.env.SIMPLEMEM_INTERNAL_TOKEN?.trim();
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
  return {
    ok: raw.ok === true,
    models: {
      caption: nonEmptyString(models.caption, 'models.caption'),
      visual: nonEmptyString(models.visual, 'models.visual'),
      textEmbedding: nonEmptyString(models.text_embedding, 'models.text_embedding'),
      transcription: nonEmptyString(models.transcription, 'models.transcription'),
    },
    version: typeof raw.version === 'string' ? raw.version : 'unknown',
  };
}

export async function simplememHealth(): Promise<SimpleMemHealth> {
  // /ready is intentionally protected. A startup check must prove not only
  // that the process is alive but that Clipit's worker can authenticate to it.
  return readHealthReply(await request<Record<string, unknown>>('GET', `${baseUrl()}/ready`, { timeoutMs: 15_000 }));
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
    elapsedMs: finiteNumber(raw.elapsedMs, 'elapsedMs'),
  };
}

/**
 * Sends a video to be remembered.
 *
 * `maxFrames` is the one setting that decides how much of the video
 * SimpleMem looks at: its default of 100 reads the first hundred seconds of
 * any video at one frame a second. Clipit always passes enough for the whole
 * length, and records what came back, so a short read is a fact on the row
 * rather than a surprise in an answer.
 */
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
  // The analysis proxy, not the original: 360p at two frames a second is
  // every pixel SimpleMem's one-frame-a-second read can use, at a fraction of
  // the bytes.
  const bytes = await readFile(input.filePath);
  form.set('file', new File([bytes], path.basename(input.filePath), { type: 'video/mp4' }));

  const raw = await request<Record<string, unknown>>('PUT', `${baseUrl()}/videos/${encodeURIComponent(input.videoId)}`, {
    body: form,
    timeoutMs: env.SIMPLEMEM_INDEX_TIMEOUT_MS,
  });
  return readIndexReply(raw);
}

/** What SimpleMem remembers about a question, validated item by item. */
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
    const frameIndex =
      row.frameIndex === null || row.frameIndex === undefined ? null : finiteNumber(row.frameIndex, 'items[].frameIndex');
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
    totalCandidates:
      typeof raw.totalCandidates === 'number' && Number.isFinite(raw.totalCandidates) ? raw.totalCandidates : items.length,
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

/** Forgets a video. Footage lives as long as its session, and so does the memory of it. */
export async function simplememDeleteVideo(videoId: string): Promise<void> {
  await request<Record<string, unknown>>('DELETE', `${baseUrl()}/videos/${encodeURIComponent(videoId)}`, {
    timeoutMs: 60_000,
  });
}
