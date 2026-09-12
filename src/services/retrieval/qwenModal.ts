import { ExternalServiceError } from '../../lib/errors.js';
import { invokeModal, type ModalTarget } from '../modal/invoke.js';

const EMBED_MODEL = 'Qwen/Qwen3-VL-Embedding-2B';
const RERANK_MODEL = 'Qwen/Qwen3-VL-Reranker-2B';
const EMBED_DIMS = 2048;

const EMBED_VIDEO: ModalTarget = {
  app: 'clipit-embedding',
  className: 'QwenEmbeddingService',
  method: 'embed_video_intervals',
  label: 'qwen-embedding',
};
const EMBED_TEXT: ModalTarget = { ...EMBED_VIDEO, method: 'embed_texts' };
const RERANK: ModalTarget = {
  app: 'clipit-reranker',
  className: 'QwenRerankerService',
  method: 'rerank_video_intervals',
  label: 'qwen-reranker',
};

export interface QwenInterval {
  id: string;
  start: number;
  end: number;
}

export interface QwenFailure {
  id: string;
  reason: string;
}

export interface QwenEmbedded {
  id: string;
  embedding: Float32Array;
}

export interface QwenEmbedResult {
  model: string;
  revision: string;
  embedded: QwenEmbedded[];
  failed: QwenFailure[];
  metrics: Record<string, unknown>;
}

function uniqueIds(rows: readonly { id: string }[], label: string): Set<string> {
  const ids = rows.map((row) => row.id);
  const set = new Set(ids);
  if (set.size !== ids.length) {
    throw new ExternalServiceError(label, 'candidate ids must be unique within one Modal call', { retryable: false });
  }
  return set;
}

function readFailures(raw: unknown, asked: Set<string>, succeeded: Set<string>, label: string): QwenFailure[] {
  const failures: QwenFailure[] = [];
  const seen = new Set<string>();
  for (const row of (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>) {
    const id = typeof row.id === 'string' ? row.id : '';
    if (!asked.has(id) || succeeded.has(id) || seen.has(id)) {
      throw new ExternalServiceError(label, `invalid failure identity returned for "${id}"`, { retryable: false });
    }
    seen.add(id);
    failures.push({ id, reason: typeof row.reason === 'string' ? row.reason : 'no reason given' });
  }
  for (const id of asked) {
    if (!succeeded.has(id) && !seen.has(id)) failures.push({ id, reason: 'service returned neither a result nor a failure' });
  }
  return failures;
}

function vector(value: unknown, id: string): Float32Array {
  if (!Array.isArray(value) || value.length !== EMBED_DIMS) {
    throw new ExternalServiceError('qwen-embedding', `embedding for "${id}" has the wrong dimension`, { retryable: false });
  }
  const out = new Float32Array(EMBED_DIMS);
  let normSquared = 0;
  for (let index = 0; index < EMBED_DIMS; index += 1) {
    const component = value[index];
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw new ExternalServiceError('qwen-embedding', `embedding for "${id}" has a non-finite component`, { retryable: false });
    }
    out[index] = component;
    normSquared += component * component;
  }
  const norm = Math.sqrt(normSquared);
  if (Math.abs(norm - 1) > 0.02) {
    throw new ExternalServiceError('qwen-embedding', `embedding for "${id}" is not normalized`, { retryable: false });
  }
  return out;
}

function readEmbedReply(raw: Record<string, unknown>, asked: Set<string>): QwenEmbedResult {
  if (raw.model !== EMBED_MODEL || raw.dim !== EMBED_DIMS) {
    throw new ExternalServiceError(
      'qwen-embedding',
      `unexpected embedding identity (${String(raw.model)}, ${String(raw.dim)} dimensions)`,
      { retryable: false },
    );
  }
  const rows = Array.isArray(raw.results) ? raw.results as Array<Record<string, unknown>> : [];
  const seen = new Set<string>();
  const embedded: QwenEmbedded[] = [];
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id : '';
    if (!asked.has(id) || seen.has(id)) {
      throw new ExternalServiceError('qwen-embedding', `unexpected or duplicate id "${id}"`, { retryable: false });
    }
    seen.add(id);
    embedded.push({ id, embedding: vector(row.embedding, id) });
  }
  return {
    model: EMBED_MODEL,
    revision: typeof raw.revision === 'string' ? raw.revision : 'unknown',
    embedded,
    failed: readFailures(raw.failed, asked, seen, 'qwen-embedding'),
    metrics: (raw.metrics as Record<string, unknown>) ?? {},
  };
}

export async function embedQuery(text: string): Promise<QwenEmbedResult> {
  const rows = [{ id: 'query', text }];
  const asked = uniqueIds(rows, 'qwen-embedding');
  const raw = await invokeModal<Record<string, unknown>>(
    EMBED_TEXT,
    { texts: rows, is_query: true },
    { context: { texts: 1, isQuery: true } },
  );
  return readEmbedReply(raw, asked);
}

export async function embedVideoIntervals(input: {
  videoUrl: string;
  videoKey: string;
  expectedBytes?: number;
  intervals: QwenInterval[];
}): Promise<QwenEmbedResult> {
  const asked = uniqueIds(input.intervals, 'qwen-embedding');
  const raw = await invokeModal<Record<string, unknown>>(
    EMBED_VIDEO,
    {
      video_url: input.videoUrl,
      video_key: input.videoKey,
      expect_bytes: input.expectedBytes ?? null,
      intervals: input.intervals,
      fps: 2,
      max_frames: 16,
      short_side: 256,
    },
    { context: { videoKey: input.videoKey, intervals: input.intervals.length } },
  );
  return readEmbedReply(raw, asked);
}

export interface QwenRanked {
  id: string;
  score: number;
}

export async function rerankVideoIntervals(input: {
  query: string;
  videoUrl: string;
  videoKey: string;
  expectedBytes?: number;
  candidates: QwenInterval[];
}): Promise<{ model: string; revision: string; ranked: QwenRanked[]; failed: QwenFailure[]; metrics: Record<string, unknown> }> {
  const asked = uniqueIds(input.candidates, 'qwen-reranker');
  const raw = await invokeModal<Record<string, unknown>>(
    RERANK,
    {
      query: input.query,
      video_url: input.videoUrl,
      video_key: input.videoKey,
      expect_bytes: input.expectedBytes ?? null,
      candidates: input.candidates,
      fps: 2,
      max_frames: 16,
      short_side: 256,
    },
    { context: { videoKey: input.videoKey, candidates: input.candidates.length } },
  );
  if (raw.model !== RERANK_MODEL) {
    throw new ExternalServiceError('qwen-reranker', `unexpected reranker model "${String(raw.model)}"`, { retryable: false });
  }
  const rows = Array.isArray(raw.results) ? raw.results as Array<Record<string, unknown>> : [];
  const seen = new Set<string>();
  const ranked: QwenRanked[] = [];
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id : '';
    if (!asked.has(id) || seen.has(id) || typeof row.score !== 'number' || !Number.isFinite(row.score)) {
      throw new ExternalServiceError('qwen-reranker', `invalid score returned for "${id}"`, { retryable: false });
    }
    seen.add(id);
    ranked.push({ id, score: row.score });
  }
  ranked.sort((a, b) => b.score - a.score);
  return {
    model: RERANK_MODEL,
    revision: typeof raw.revision === 'string' ? raw.revision : 'unknown',
    ranked,
    failed: readFailures(raw.failed, asked, seen, 'qwen-reranker'),
    metrics: (raw.metrics as Record<string, unknown>) ?? {},
  };
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) throw new Error('cannot compare embeddings with different dimensions');
  let dot = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += (left[index] ?? 0) * (right[index] ?? 0);
  }
  return dot;
}
