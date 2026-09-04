import { env } from '../../config/env.js';
import { ExternalServiceError } from '../../lib/errors.js';
import { invokeModal, type ModalTarget } from '../modal/invoke.js';

/**
 * Clipit's side of the two Qwen deployments.
 *
 * The contract both services share: ONE private video URL plus a list of time
 * ranges, each range carrying an id the caller chose. Nothing is ever matched
 * by position in the returned array. That is not fussiness — this codebase has
 * already been bitten by treating array position as identity, and a batch that
 * comes back reordered, short, or partially failed would be silently misread.
 *
 * A signed URL and a video key are two different things and both are needed.
 * The URL is minted fresh for every call and expires; the key is the video's
 * stable identity, and it is what the remote container caches its download
 * under. Caching by URL would never hit, because no two URLs for the same
 * video are ever the same string.
 *
 * Everything a service returns is checked before it is believed. A reply that
 * names a different model, returns the wrong number of dimensions, or answers
 * about ids nobody asked for is rejected rather than stored — a vector from an
 * unexpected model is not a slightly worse vector, it is a meaningless one,
 * and it would look exactly like a working index.
 */

const EMBED_VIDEO: ModalTarget = {
  app: env.MEDIA_INDEX_EMBED_APP,
  className: env.MEDIA_INDEX_EMBED_CLASS,
  method: 'embed_video_intervals',
  label: 'qwen-embedding',
};

const EMBED_TEXT: ModalTarget = { ...EMBED_VIDEO, method: 'embed_texts' };

const RERANK: ModalTarget = {
  app: env.MEDIA_INDEX_RERANK_APP,
  className: env.MEDIA_INDEX_RERANK_CLASS,
  method: 'rerank_video_intervals',
  label: 'qwen-reranker',
};

export interface IntervalRequest {
  id: string;
  /** Seconds INTO THE FILE at the URL — not source seconds. The caller maps. */
  start: number;
  end: number;
}

export interface EmbeddedInterval {
  id: string;
  embedding: Float32Array;
  frames: number;
}

export interface FailedInterval {
  id: string;
  reason: string;
}

export interface EmbedResult {
  model: string;
  /**
   * The weights that actually ran. The model NAME is not the identity: the
   * same name can serve different weights after a republish, and vectors from
   * two sets of weights are no more comparable than vectors from two models.
   * 'unpinned' means the service resolved whatever the hub was serving.
   */
  revision: string;
  dims: number;
  sampling: Record<string, unknown>;
  embedded: EmbeddedInterval[];
  /**
   * Ranges the service could not read. Reported, never dropped and never
   * turned into a zero vector: a caller has to be able to tell a stretch that
   * holds nothing from a stretch nobody managed to look at.
   */
  failed: FailedInterval[];
  metrics: Record<string, unknown>;
}

interface RawEmbedReply {
  model?: unknown;
  revision?: unknown;
  dim?: unknown;
  sampling?: unknown;
  results?: unknown;
  failed?: unknown;
  metrics?: unknown;
}

export interface Sampling {
  fps: number;
  maxFrames: number;
  shortSide: number;
}

export function defaultSampling(): Sampling {
  return {
    fps: env.MEDIA_INDEX_SAMPLE_FPS,
    maxFrames: env.MEDIA_INDEX_MAX_FRAMES,
    shortSide: env.MEDIA_INDEX_FRAME_SHORT_SIDE,
  };
}

/**
 * The ids being asked about, having checked they are distinct.
 *
 * Every reply is matched by id, so two items sharing one makes the answer
 * unreadable — and the client would reject the perfectly ordinary reply as a
 * duplicate AFTER the GPU had already done the work. Checked here, before the
 * call, so a caller's mistake costs nothing.
 */
function uniqueIds(ids: string[], label: string, noun: string): Set<string> {
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);
    throw new ExternalServiceError(
      label,
      `${noun} ids must be unique within one call; "${repeated[0]}" appears more than once`,
      { retryable: false },
    );
  }
  return unique;
}

function asVector(value: unknown, dims: number, label: string, id: string): Float32Array {
  if (!Array.isArray(value)) {
    throw new ExternalServiceError(label, `Embedding for "${id}" was not an array`, { retryable: false });
  }
  if (value.length !== dims) {
    throw new ExternalServiceError(
      label,
      `Embedding for "${id}" has ${value.length} dimensions, expected ${dims}`,
      { retryable: false },
    );
  }
  const vector = new Float32Array(dims);
  for (let i = 0; i < dims; i += 1) {
    const component = value[i];
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      throw new ExternalServiceError(label, `Embedding for "${id}" holds a non-finite value`, { retryable: false });
    }
    vector[i] = component;
  }
  return vector;
}

/**
 * How far from unit length a vector may be and still be believed.
 *
 * The services normalize, so a vector far off unit length means something
 * changed on the other side — a different pooling, a different model, a
 * half-loaded checkpoint. Cosine similarity of unnormalized vectors is still a
 * number, and it still sorts, so nothing downstream would notice.
 */
const NORM_TOLERANCE = 0.02;

function assertNormalized(vector: Float32Array, label: string, id: string): void {
  let sum = 0;
  for (const component of vector) sum += component * component;
  const norm = Math.sqrt(sum);
  if (Math.abs(norm - 1) > NORM_TOLERANCE) {
    throw new ExternalServiceError(
      label,
      `Embedding for "${id}" is not normalized (length ${norm.toFixed(4)}) — the service may have changed`,
      { retryable: false },
    );
  }
}

/**
 * The failures a service reported, held to the same identity rules as its
 * results, plus the ones it forgot to mention at all.
 *
 * Shared by both services deliberately. They had different rules for a while
 * and the difference was not a decision — it was an oversight, and the kind
 * that only shows up as a coverage number nobody can explain.
 */
function readFailures(
  raw: unknown,
  asked: Set<string>,
  succeeded: Set<string>,
  label: string,
  words: { kind: string; missing: string },
): FailedInterval[] {
  const failed: FailedInterval[] = [];
  const named = new Set<string>();

  for (const row of (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>) {
    const id = typeof row.id === 'string' ? row.id : '';
    if (!asked.has(id)) {
      throw new ExternalServiceError(label, `The ${words.kind} service failed an id nobody asked for: "${id}"`, {
        retryable: false,
      });
    }
    if (succeeded.has(id)) {
      // Both answered and failed. One of the two is wrong, nothing says which,
      // so neither is believed.
      throw new ExternalServiceError(label, `The ${words.kind} service both answered and failed "${id}"`, {
        retryable: false,
      });
    }
    if (named.has(id)) {
      throw new ExternalServiceError(label, `The ${words.kind} service failed "${id}" twice`, { retryable: false });
    }
    named.add(id);
    failed.push({ id, reason: typeof row.reason === 'string' ? row.reason : 'no reason given' });
  }

  // Anything asked for that came back in neither list is a silent hole. Naming
  // it is the difference between an index that knows what it is missing and
  // one that cannot tell.
  for (const id of asked) {
    if (!succeeded.has(id) && !named.has(id)) failed.push({ id, reason: words.missing });
  }

  return failed;
}

function readEmbedReply(reply: RawEmbedReply, asked: Set<string>, label: string): EmbedResult {
  const model = typeof reply.model === 'string' ? reply.model : '';
  if (model !== env.MEDIA_INDEX_EMBED_MODEL) {
    throw new ExternalServiceError(
      label,
      `Service answered for model "${model}", but this index stores "${env.MEDIA_INDEX_EMBED_MODEL}". ` +
        'Mixing vectors from two models would look like working retrieval and would not be.',
      { retryable: false },
    );
  }

  // A pin, if one is configured, is enforced exactly as the model name is.
  // Unset, the revision is recorded rather than demanded — the experiment has
  // to be able to run before anybody knows which commit to pin.
  const revision = typeof reply.revision === 'string' ? reply.revision : 'unknown';
  if (env.MEDIA_INDEX_EMBED_REVISION && revision !== env.MEDIA_INDEX_EMBED_REVISION) {
    throw new ExternalServiceError(
      label,
      `Service is running weights "${revision}" but this index expects "${env.MEDIA_INDEX_EMBED_REVISION}". ` +
        'The same model name can serve different weights, and their vectors are not comparable.',
      { retryable: false },
    );
  }

  const rows = Array.isArray(reply.results) ? reply.results : [];
  const dims = env.MEDIA_INDEX_EMBED_DIMS;
  if (rows.length > 0 && reply.dim !== dims) {
    throw new ExternalServiceError(
      label, `Service returned ${String(reply.dim)}-dimensional vectors, expected ${dims}`, { retryable: false },
    );
  }

  const embedded: EmbeddedInterval[] = [];
  const seen = new Set<string>();
  for (const row of rows as Array<Record<string, unknown>>) {
    const id = typeof row.id === 'string' ? row.id : '';
    if (!asked.has(id)) {
      throw new ExternalServiceError(label, `Service returned an id nobody asked for: "${id}"`, { retryable: false });
    }
    if (seen.has(id)) {
      throw new ExternalServiceError(label, `Service returned "${id}" twice`, { retryable: false });
    }
    seen.add(id);
    const embedding = asVector(row.embedding, dims, label, id);
    assertNormalized(embedding, label, id);
    embedded.push({ id, embedding, frames: typeof row.frames === 'number' ? row.frames : 0 });
  }

  // The failure list gets the same scrutiny the results do. It did not, at
  // first, and the asymmetry mattered: an unknown id would have attached a
  // failure to a stretch of video nobody asked about, a duplicate would have
  // counted one gap twice, and an id in BOTH lists would have reported a
  // window as embedded and as missing at the same time. Coverage is the
  // honesty channel of this index; a wrong entry in it is not a small error.
  const failed = readFailures(reply.failed, asked, seen, label, {
    kind: 'embedding',
    missing: 'the service returned neither an embedding nor a failure for this range',
  });

  return {
    model,
    revision,
    dims,
    sampling: (reply.sampling as Record<string, unknown>) ?? {},
    embedded,
    failed,
    metrics: (reply.metrics as Record<string, unknown>) ?? {},
  };
}

export async function embedVideoIntervals(input: {
  videoUrl: string;
  /** The video's stable identity, so the container caches one download. */
  videoKey: string;
  /**
   * What the object measured when that identity was read. The far side
   * refuses bytes of a different size — the identity is resolved before the
   * URL is signed, and a re-process landing between the two would otherwise
   * be embedded as though it were the version the identity names.
   */
  expectedBytes: number;
  intervals: IntervalRequest[];
  sampling?: Sampling;
}): Promise<EmbedResult> {
  if (input.intervals.length === 0) {
    return {
      model: env.MEDIA_INDEX_EMBED_MODEL, revision: 'not asked', dims: env.MEDIA_INDEX_EMBED_DIMS,
      sampling: {}, embedded: [], failed: [], metrics: {},
    };
  }
  const sampling = input.sampling ?? defaultSampling();
  const asked = uniqueIds(input.intervals.map((interval) => interval.id), EMBED_VIDEO.label, 'Interval');

  const reply = await invokeModal<RawEmbedReply>(EMBED_VIDEO, {
    video_url: input.videoUrl,
    video_key: input.videoKey,
    expect_bytes: input.expectedBytes,
    intervals: input.intervals,
    fps: sampling.fps,
    max_frames: sampling.maxFrames,
    short_side: sampling.shortSide,
  }, { context: { videoKey: input.videoKey, intervals: input.intervals.length } });

  return readEmbedReply(reply, asked, EMBED_VIDEO.label);
}

/**
 * Text into the same space as the video vectors.
 *
 * `isQuery` is explicit because these models are asymmetric: a question and a
 * document are labelled differently for the model, and swapping them does not
 * raise anything. It returns well-ordered, confident, wrong results.
 */
export async function embedTexts(input: {
  texts: Array<{ id: string; text: string }>;
  isQuery: boolean;
}): Promise<EmbedResult> {
  if (input.texts.length === 0) {
    return {
      model: env.MEDIA_INDEX_EMBED_MODEL, revision: 'not asked', dims: env.MEDIA_INDEX_EMBED_DIMS,
      sampling: {}, embedded: [], failed: [], metrics: {},
    };
  }
  const asked = uniqueIds(input.texts.map((row) => row.id), EMBED_TEXT.label, 'Text');
  const reply = await invokeModal<RawEmbedReply>(EMBED_TEXT, {
    texts: input.texts,
    is_query: input.isQuery,
  }, { context: { texts: input.texts.length, isQuery: input.isQuery } });

  return readEmbedReply(reply, asked, EMBED_TEXT.label);
}

export interface RankedInterval {
  id: string;
  score: number;
}

export interface RerankResult {
  model: string;
  /** The weights that ran. See EmbedResult.revision. */
  revision: string;
  ranked: RankedInterval[];
  failed: FailedInterval[];
  metrics: Record<string, unknown>;
}

/**
 * Order candidate intervals by watching them.
 *
 * Scores are comparable WITHIN one call and nothing promises they are
 * comparable across calls, so callers rank and take the top few rather than
 * applying a fixed threshold.
 */
export async function rerankVideoIntervals(input: {
  query: string;
  videoUrl: string;
  videoKey: string;
  /** As above: the far side refuses bytes the identity does not describe. */
  expectedBytes: number;
  candidates: IntervalRequest[];
  sampling?: Sampling;
}): Promise<RerankResult> {
  if (input.candidates.length === 0) {
    return { model: '', revision: 'not asked', ranked: [], failed: [], metrics: {} };
  }
  const sampling = input.sampling ?? defaultSampling();
  const asked = uniqueIds(input.candidates.map((candidate) => candidate.id), RERANK.label, 'Candidate');

  const reply = await invokeModal<Record<string, unknown>>(RERANK, {
    query: input.query,
    video_url: input.videoUrl,
    video_key: input.videoKey,
    expect_bytes: input.expectedBytes,
    candidates: input.candidates,
    fps: sampling.fps,
    max_frames: sampling.maxFrames,
    short_side: sampling.shortSide,
  }, { context: { videoKey: input.videoKey, candidates: input.candidates.length } });

  // The reranker is held to exactly the identity contract the embedding path
  // is held to, and for the same reason. A reply that quietly drops two of
  // five candidates still sorts, still looks like a considered ranking, and
  // the caller would take unread footage for footage that was read and judged
  // irrelevant. A shorter list is not a verdict.
  // Which model answered, checked exactly as the embedding side checks it. A
  // stale or misrouted deployment scores every candidate, returns a clean
  // ranking, and quietly invalidates the comparison the experiment exists to
  // make — with nothing in the output to say so.
  const model = typeof reply.model === 'string' ? reply.model : '';
  if (model !== env.MEDIA_INDEX_RERANK_MODEL) {
    throw new ExternalServiceError(
      RERANK.label,
      `Reranker answered for model "${model || '(none given)'}", but this index expects ` +
        `"${env.MEDIA_INDEX_RERANK_MODEL}".`,
      { retryable: false },
    );
  }

  const rows = Array.isArray(reply.results) ? reply.results : [];
  const ranked: RankedInterval[] = [];
  const scored = new Set<string>();

  for (const row of rows as Array<Record<string, unknown>>) {
    const id = typeof row.id === 'string' ? row.id : '';
    if (!asked.has(id)) {
      throw new ExternalServiceError(RERANK.label, `Reranker returned an id nobody asked for: "${id}"`, { retryable: false });
    }
    if (scored.has(id)) {
      throw new ExternalServiceError(RERANK.label, `Reranker returned "${id}" twice`, { retryable: false });
    }
    if (typeof row.score !== 'number' || !Number.isFinite(row.score)) {
      throw new ExternalServiceError(RERANK.label, `Reranker returned a non-numeric score for "${id}"`, { retryable: false });
    }
    scored.add(id);
    ranked.push({ id, score: row.score });
  }
  ranked.sort((a, b) => b.score - a.score);

  // A candidate in neither list is named as a failure rather than left out, so
  // "we did not look at this one" can never read as "this one lost".
  const failed = readFailures(reply.failed, asked, scored, RERANK.label, {
    kind: 'reranker',
    missing: 'the reranker returned neither a score nor a failure for this candidate',
  });

  return {
    model,
    revision: typeof reply.revision === 'string' ? reply.revision : 'unknown',
    ranked,
    failed,
    metrics: (reply.metrics as Record<string, unknown>) ?? {},
  };
}
