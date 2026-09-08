import { env } from '../../config/env.js';
import { cosineSimilarity } from './vectors.js';
import { embedTexts, rerankVideoIntervals } from './qwen.js';
import { gpuMsFrom } from './cost.js';
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
  | 'provenance_changed'
  | 'index_failed'
  /**
   * A run that opened and then stopped saying anything.
   *
   * Distinct from `index_not_ready` on purpose, and the distinction is the
   * whole point of this reason existing. A row reads `running` in two very
   * different situations: a video being read right now, and a video whose read
   * died in a way that could not be written down — the handler records
   * `failed` in its own error path, but that write is itself a database call,
   * and when IT fails the row keeps saying `running` with nobody left to
   * correct it. Treating the second as the first tells every later question
   * that reading is still in progress, forever, for a video nothing is
   * touching.
   */
  | 'index_stopped';

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
  /** Injected so "has this run gone quiet" is testable rather than clock-bound. */
  now?: Date;
  /**
   * How long a run may say nothing before it is presumed stopped. Defaults to
   * the configured window; a live run writes its status after every batch, so
   * silence for longer than this is not slowness.
   */
  staleAfterMs?: number;
}

/**
 * A run that has gone quiet for longer than any batch could take.
 *
 * Only `queued` and `running` can go stale: every other state is terminal and
 * means somebody finished writing the truth down.
 */
function hasStopped(status: MediaIndexStatus, now: Date, staleAfterMs: number): boolean {
  if (status.state !== 'queued' && status.state !== 'running') return false;
  return now.getTime() - status.updatedAt.getTime() > staleAfterMs;
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
  // These vectors describe pictures and nothing else.
  //
  // 'transcript' is obvious. 'both' is the one worth spelling out: a question
  // that needs what was SEEN and what was SAID cannot be finished from half
  // the evidence. Answering it from pictures alone would return a moment that
  // satisfies one requirement while presenting it as satisfying both, and the
  // spoken half would never be checked by anything. The existing multimodal
  // search handles those.
  if (input.mode !== 'visual') {
    return {
      use: 'fallback',
      reason: 'not_visual',
      detail: input.mode === 'transcript'
        ? 'the question is about speech, and these vectors describe pictures'
        : 'the question needs what was said as well as what was seen, and these vectors describe only pictures',
    };
  }
  const status = input.status;
  if (!status) {
    return { use: 'fallback', reason: 'index_missing', detail: 'this video was never read into vectors' };
  }
  const now = input.now ?? new Date();
  const staleAfterMs = input.staleAfterMs ?? env.MEDIA_INDEX_STALE_AFTER_SECONDS * 1000;
  switch (status.state) {
    case 'queued':
    case 'running':
      // Not a refusal on the merits: a partly-read video can still answer
      // about the part that was read, so this only falls back when nothing
      // has been read yet. The coverage check below decides.
      break;
    case 'failed':
      // A run that died at minute forty still read the first forty minutes,
      // and the handler deliberately kept those windows and recorded their
      // coverage. Refusing the whole index would send every later question to
      // the footage — the expensive path — for footage that was already read.
      // The coverage check below decides, and the unread stretches are named
      // in the answer exactly as they are for a run still in progress.
      break;
    case 'unavailable':
      // Different thing: there was nothing to read, or the footage is gone.
      return {
        use: 'fallback',
        reason: 'index_unavailable',
        detail: status.error ?? 'this video could not be read into vectors',
      };
    case 'ready':
    case 'partial':
      break;
  }
  if (status.coveredThroughSeconds <= 0) {
    // "Not yet" is a promise that something is coming. It may only be said
    // while something actually is: a run still reporting. One that has gone
    // quiet gets the truthful answer instead — it started and it stopped.
    const stopped = hasStopped(status, now, staleAfterMs);
    const notYet = (status.state === 'queued' || status.state === 'running') && !stopped;
    return {
      use: 'fallback',
      reason: notYet
        ? 'index_not_ready'
        : stopped
          ? 'index_stopped'
          : status.state === 'failed'
            ? 'index_unavailable'
            : 'no_coverage',
      detail: notYet
        ? 'no part of this video has been read into vectors yet'
        : stopped
          ? 'reading this video into vectors started and then stopped without finishing, and nothing was stored'
          : status.state === 'failed'
            ? status.error ?? 'reading this video into vectors failed before anything was stored'
            : 'no part of this video has been read into vectors',
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

export interface RelevanceRule {
  /** Scores under this are not moments, whatever else they beat. */
  minScore: number;
  /**
   * How far the best window must stand clear of a typical one, as a fraction
   * of the spread. Zero disables the test.
   */
  minSeparation: number;
}

/**
 * Which of the ranked windows are actually evidence.
 *
 * Without this the top of the list is always returned, so an indexed video
 * answers EVERY visual question with its closest guess — however poor — and
 * the notes and the footage are never reached. "There is no matching moment"
 * becomes unreachable, which is the failure this product is built to avoid.
 *
 * Two tests, because neither alone is enough.
 *
 * An absolute floor, because a negative or near-zero similarity is not a
 * match under any reading. It is a setting rather than a constant: these
 * scores are not calibrated, and the right value has to come from measuring
 * real footage rather than from anybody's intuition.
 *
 * And a separation test, which needs no calibration at all. If every window
 * in the video scores about the same, the question does not distinguish
 * anything in it — that is what "not in this video" looks like from here,
 * whatever the absolute numbers happen to be. A question that IS answered by
 * the footage produces a top score standing clear of the rest.
 */
export function keepRelevant(ranked: readonly ScoredWindow[], all: readonly ScoredWindow[], rule: RelevanceRule): ScoredWindow[] {
  const above = ranked.filter((window) => window.score >= rule.minScore);
  if (above.length === 0) return [];
  if (rule.minSeparation <= 0) return [...above];

  const scores = all.map((window) => window.score).sort((a, b) => a - b);
  const lowest = scores[0] ?? 0;
  const highest = scores[scores.length - 1] ?? 0;
  const middle = scores[Math.floor(scores.length / 2)] ?? 0;
  const spread = highest - lowest;
  // Everything identical: nothing is distinguished, so nothing is evidence.
  if (spread <= 0) return [];
  if ((highest - middle) / spread < rule.minSeparation) return [];

  // Keep only what stands clear of the middle, so low-scoring neighbours
  // cannot later be folded into a hit and drag a moment across the video.
  const floor = middle + (highest - middle) * rule.minSeparation;
  return above.filter((window) => window.score >= floor);
}

/**
 * Neighbouring windows are one moment.
 *
 * The grid overlaps by design, so the same ten seconds of footage produces
 * several windows and a question that matches it matches all of them. Handing
 * a person the same moment three times is not three results.
 */
export function foldIntoMoments(ranked: readonly ScoredWindow[], maxSeconds = Number.POSITIVE_INFINITY): ScoredWindow[] {
  const byTime = [...ranked].sort((a, b) => a.startSeconds - b.startSeconds);
  const moments: ScoredWindow[] = [];
  for (const window of byTime) {
    const previous = moments[moments.length - 1];
    // Merged only while the result stays a moment. The grid overlaps
    // continuously, so without a ceiling a chain of adjacent windows folds
    // into one result spanning the entire video — which is not a moment, it
    // is the video, and handing that back is the same as finding nothing
    // while looking like a hit.
    if (
      previous &&
      window.startSeconds <= previous.endSeconds &&
      Math.max(previous.endSeconds, window.endSeconds) - previous.startSeconds <= maxSeconds
    ) {
      previous.endSeconds = Math.max(previous.endSeconds, window.endSeconds);
      previous.score = Math.max(previous.score, window.score);
      continue;
    }
    moments.push({ ...window });
  }
  return moments.sort((a, b) => b.score - a.score);
}

/** One remote call the search made, so the caller can record what it cost. */
export interface IndexSearchCall {
  stage: 'search' | 'rerank';
  model: string;
  /** Time the GPU was held, from the service's own metrics. */
  gpuMs: number;
  metrics: Record<string, unknown>;
  startedAt: Date;
  latencyMs: number;
}

export interface IndexSearchResult {
  moments: ScoredWindow[];
  /**
   * Shortlisted stretches the reranker could not read.
   *
   * Not "watched and found wanting" — nobody watched them. Reported so the
   * answer can name them as unexamined instead of letting them sit at the
   * bottom of a ranking, which reads as a verdict.
   */
  unread: Array<ScoredWindow & { reason: string }>;
  /**
   * Every paid call this search made.
   *
   * Returned rather than recorded here so persistence stays with the handler
   * that owns the request. They must not go unrecorded: a per-question cost
   * that omits the calls the question actually made is the exact shape of
   * error migration 027 was written about.
   */
  calls: IndexSearchCall[];
  /** What the ranking was produced by, so a row can name it. */
  model: string;
  revision: string;
  /** True when the reranker ran; false means these are raw vector scores. */
  reranked: boolean;
  /** Seconds of this video that were never read, so the answer can say so. */
  coveredThroughSeconds: number;
}

export class IndexProvenanceChanged extends Error {}

export interface IndexSearchInput {
  instruction: string;
  windows: readonly StoredWindow[];
  coveredThroughSeconds: number;
  /**
   * What the stored vectors were made by. The question is embedded by
   * whatever the service is serving NOW, and the two must be the same thing.
   */
  storedBy: { model: string; revision: string; dims: number };
  /** Signed URL and identity, for the reranker. Omit to skip reranking. */
  rerank?: { videoUrl: string; videoKey: string; expectedBytes: number };
  /**
   * Called as each remote call completes, before anything after it can fail.
   *
   * Returning the calls at the end was not enough: a reranker that throws
   * took the record of the question's own embedding down with it — a call
   * that had already run, and already cost money. Money spent is money spent
   * whether or not the search it belonged to succeeded, and the understating
   * is worst exactly when things are going wrong.
   */
  onCall?: (call: IndexSearchCall) => void;
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
  const embedStartedAt = new Date();
  const embedBegan = Date.now();
  const embedded = await embedTexts({ texts: [{ id: 'q', text: input.instruction }], isQuery: true });
  const calls: IndexSearchCall[] = [];
  const note = (call: IndexSearchCall) => {
    calls.push(call);
    input.onCall?.(call);
  };
  note({
    stage: 'search',
    model: embedded.model,
    gpuMs: gpuMsFrom([embedded.metrics]),
    metrics: embedded.metrics,
    startedAt: embedStartedAt,
    latencyMs: Date.now() - embedBegan,
  });
  const queryVector = embedded.embedded[0]?.embedding;
  if (!queryVector) {
    throw new Error('the embedding service returned no vector for the question');
  }

  // The question was just embedded by whatever the service is serving now.
  // The windows were embedded whenever the video was uploaded. If those are
  // not the same model AND the same weights, comparing them is meaningless —
  // and when the dimensions happen to match it does not fail, it ranks. Well
  // ordered, confident, and about nothing. A redeployment that changes the
  // weights behind an unchanged model name is the ordinary way this happens.
  if (
    embedded.model !== input.storedBy.model ||
    embedded.revision !== input.storedBy.revision ||
    embedded.dims !== input.storedBy.dims
  ) {
    throw new IndexProvenanceChanged(
      `the question was embedded by ${embedded.model}@${embedded.revision}/${embedded.dims}, but this video's ` +
        `vectors were made by ${input.storedBy.model}@${input.storedBy.revision}/${input.storedBy.dims}`,
    );
  }

  // Every window is scored so the separation test can see the whole
  // distribution; only the shortlist is considered as evidence.
  const all = rankWindows(queryVector, input.windows, input.windows.length);
  const shortlist = all.slice(0, env.MEDIA_INDEX_TOP_K);
  const relevant = keepRelevant(shortlist, all, {
    minScore: env.MEDIA_INDEX_MIN_SCORE,
    minSeparation: env.MEDIA_INDEX_MIN_SEPARATION,
  });
  const moments = foldIntoMoments(relevant, env.MAX_CLIP_SECONDS);
  if (moments.length === 0 || !input.rerank) {
    return {
      moments,
      unread: [],
      calls,
      model: embedded.model,
      revision: embedded.revision,
      reranked: false,
      coveredThroughSeconds: input.coveredThroughSeconds,
    };
  }

  // Reranking watches the shortlisted footage rather than comparing vectors,
  // which is the step that tells "a sign" from "the RIGHT sign".
  const rerankStartedAt = new Date();
  const rerankBegan = Date.now();
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

  note({
    stage: 'rerank',
    model: reranked.model,
    gpuMs: gpuMsFrom([reranked.metrics]),
    metrics: reranked.metrics,
    startedAt: rerankStartedAt,
    latencyMs: Date.now() - rerankBegan,
  });

  const byKey = new Map(moments.map((moment) => [moment.windowKey, moment]));
  const ordered = reranked.ranked.flatMap((row) => {
    const moment = byKey.get(row.id);
    return moment ? [{ ...moment, score: row.score }] : [];
  });

  // A candidate the reranker could not READ is not a candidate it judged
  // irrelevant, and the two must not end up in the same pile. Ranked last on
  // its vector score would say "watched, and unconvincing". These are carried
  // out separately so the caller can say a stretch was not examined rather
  // than examined and dismissed.
  const unread = reranked.failed.flatMap((failure) => {
    const moment = byKey.get(failure.id);
    return moment ? [{ ...moment, reason: failure.reason }] : [];
  });

  return {
    unread,
    calls,
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
