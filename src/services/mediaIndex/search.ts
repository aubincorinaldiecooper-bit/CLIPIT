import { env } from '../../config/env.js';
import { cosineSimilarity } from './vectors.js';
import { embedTexts, rerankVideoIntervals } from './qwen.js';
import type { StoredWindow, MediaIndexStatus } from '../../db/repositories/mediaIndex.js';
import type { ResolvedSearchMode } from '../../domain/types.js';

/**
 * Answering a question from the vectors, without watching the video again.
 *
 * The notes taken at upload are a model's summary of what it thought worth
 * writing down. These vectors are what the pictures actually look like, which
 * is why they are worth asking first for a question about something SEEN: a
 * summary drops the sign on the wall, the clock, the number plate. The
 * vectors do not describe those either — but they can be matched against,
 * which a dropped sentence cannot.
 *
 * What this must never do is turn its own silence into an answer. Vectors
 * that match nothing mean this stretch of footage did not look like the
 * question; they do not mean the video lacks the thing. So every path out of
 * here that is not a confident hit is a FALLBACK, named, to the search Clipit
 * already has — and the footage read stays the only thing allowed to report
 * an absence.
 */

export type IndexFallbackReason =
  | 'disabled'
  | 'correction'
  | 'not_visual'
  | 'index_missing'
  | 'index_not_ready'
  | 'index_unavailable'
  | 'no_coverage'
  | 'no_candidates'
  | 'index_failed';

export type IndexDecision =
  | { use: 'index' }
  | { use: 'fallback'; reason: IndexFallbackReason; detail: string };

export interface IndexDecisionInput {
  enabled: boolean;
  /** True when the user is telling us the last answer was wrong. */
  correcting: boolean;
  mode: ResolvedSearchMode;
  status: MediaIndexStatus | null;
  /** Present once the index was actually consulted. */
  candidateCount?: number;
  /** Present when consulting it threw. */
  error?: string;
}

/**
 * Whether the vectors may answer this question, and if not, why not.
 *
 * The order is the order the facts become known: the switch, then the kind of
 * question, then what the index holds, then what it found. Every refusal
 * carries its own reason so the two systems can be told apart from rows —
 * which is the only way to find out later whether this was worth building.
 */
export function decideIndexAnswer(input: IndexDecisionInput): IndexDecision {
  if (!input.enabled) {
    return { use: 'fallback', reason: 'disabled', detail: 'the Media Index is switched off' };
  }
  if (input.correcting) {
    return { use: 'fallback', reason: 'correction', detail: 'a correction re-reads the footage by rule' };
  }
  // A question about what was SAID is not a question these vectors can
  // answer. They describe pictures; the transcript is a different memory and
  // already has its own path.
  if (input.mode === 'transcript') {
    return { use: 'fallback', reason: 'not_visual', detail: 'the question is about speech, and these vectors describe pictures' };
  }
  const status = input.status;
  if (!status) {
    return { use: 'fallback', reason: 'index_missing', detail: 'this video was never read into vectors' };
  }
  switch (status.state) {
    case 'queued':
    case 'running':
      // Not a refusal on the merits: a partly-read video can still answer
      // about the part that was read, so this only falls back when nothing
      // has been read yet. The coverage check below decides.
      break;
    case 'failed':
    case 'unavailable':
      return {
        use: 'fallback',
        reason: 'index_unavailable',
        detail: status.error ?? `the index is ${status.state}`,
      };
    case 'ready':
    case 'partial':
      break;
  }
  if (status.coveredThroughSeconds <= 0) {
    return {
      use: 'fallback',
      reason: status.state === 'queued' || status.state === 'running' ? 'index_not_ready' : 'no_coverage',
      detail: 'no part of this video has been read into vectors yet',
    };
  }
  if (input.error !== undefined) {
    return { use: 'fallback', reason: 'index_failed', detail: input.error };
  }
  if (input.candidateCount !== undefined && input.candidateCount === 0) {
    // Nothing matched. NOT "there is no such moment" — the footage read is
    // the only thing allowed to say that, so the question goes on to it.
    return {
      use: 'fallback',
      reason: 'no_candidates',
      detail: 'nothing in the vectors resembled the question; this is not evidence the moment is absent',
    };
  }
  return { use: 'index' };
}

export interface ScoredWindow {
  windowKey: string;
  startSeconds: number;
  endSeconds: number;
  score: number;
}

/**
 * The windows most like the question, best first.
 *
 * Scored in this process rather than in the database: pgvector is not
 * installed (see migration 044), and a search is always about one video, so
 * this is hundreds of comparisons rather than millions.
 */
export function rankWindows(query: Float32Array, windows: readonly StoredWindow[], topK: number): ScoredWindow[] {
  const scored = windows.map((window) => ({
    windowKey: window.windowKey,
    startSeconds: window.startSeconds,
    endSeconds: window.endSeconds,
    score: cosineSimilarity(query, window.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, topK));
}

/**
 * Neighbouring windows are one moment.
 *
 * The grid overlaps by design, so the same ten seconds of footage produces
 * several windows and a question that matches it matches all of them. Handing
 * a person the same moment three times is not three results.
 */
export function foldIntoMoments(ranked: readonly ScoredWindow[]): ScoredWindow[] {
  const byTime = [...ranked].sort((a, b) => a.startSeconds - b.startSeconds);
  const moments: ScoredWindow[] = [];
  for (const window of byTime) {
    const previous = moments[moments.length - 1];
    if (previous && window.startSeconds <= previous.endSeconds) {
      previous.endSeconds = Math.max(previous.endSeconds, window.endSeconds);
      previous.score = Math.max(previous.score, window.score);
      continue;
    }
    moments.push({ ...window });
  }
  return moments.sort((a, b) => b.score - a.score);
}

export interface IndexSearchResult {
  moments: ScoredWindow[];
  /** What the ranking was produced by, so a row can name it. */
  model: string;
  revision: string;
  /** True when the reranker ran; false means these are raw vector scores. */
  reranked: boolean;
  /** Seconds of this video that were never read, so the answer can say so. */
  coveredThroughSeconds: number;
}

export interface IndexSearchInput {
  instruction: string;
  windows: readonly StoredWindow[];
  coveredThroughSeconds: number;
  /** Signed URL and identity, for the reranker. Omit to skip reranking. */
  rerank?: { videoUrl: string; videoKey: string; expectedBytes: number };
}

/**
 * The whole read: question in, moments out.
 *
 * The question is embedded as a QUERY, explicitly. These models are
 * asymmetric — a question and a document are labelled differently — and
 * swapping them raises nothing at all. It returns well-ordered, confident,
 * wrong results.
 */
export async function searchMediaIndex(input: IndexSearchInput): Promise<IndexSearchResult> {
  const embedded = await embedTexts({ texts: [{ id: 'q', text: input.instruction }], isQuery: true });
  const queryVector = embedded.embedded[0]?.embedding;
  if (!queryVector) {
    throw new Error('the embedding service returned no vector for the question');
  }

  const ranked = rankWindows(queryVector, input.windows, env.MEDIA_INDEX_TOP_K);
  const moments = foldIntoMoments(ranked);
  if (moments.length === 0 || !input.rerank) {
    return {
      moments,
      model: embedded.model,
      revision: embedded.revision,
      reranked: false,
      coveredThroughSeconds: input.coveredThroughSeconds,
    };
  }

  // Reranking watches the shortlisted footage rather than comparing vectors,
  // which is the step that tells "a sign" from "the RIGHT sign".
  const reranked = await rerankVideoIntervals({
    query: input.instruction,
    videoUrl: input.rerank.videoUrl,
    videoKey: input.rerank.videoKey,
    expectedBytes: input.rerank.expectedBytes,
    candidates: moments.map((moment) => ({
      id: moment.windowKey,
      start: moment.startSeconds,
      end: moment.endSeconds,
    })),
  });

  const byKey = new Map(moments.map((moment) => [moment.windowKey, moment]));
  const ordered = reranked.ranked.flatMap((row) => {
    const moment = byKey.get(row.id);
    return moment ? [{ ...moment, score: row.score }] : [];
  });

  return {
    // A reranker that dropped candidates has not judged them irrelevant, so
    // anything it did not return keeps its vector score and its place behind
    // the ranked ones rather than disappearing.
    moments: ordered.length > 0
      ? [...ordered, ...moments.filter((moment) => !reranked.ranked.some((row) => row.id === moment.windowKey))]
      : moments,
    model: reranked.model || embedded.model,
    revision: reranked.revision,
    reranked: ordered.length > 0,
    coveredThroughSeconds: input.coveredThroughSeconds,
  };
}
