import {
  cosineSimilarity,
  embedQuery,
  embedVideoIntervals,
  rerankVideoIntervals,
} from './qwenModal.js';
import { videoChat3Adapter } from '../video/adapters/videochat3.js';
import { verifyVideo, watchVideo } from '../video/model.js';
import type { StoredVideoSource } from '../video/source.js';
import { passesEvidenceGate } from './mixedEvidence.js';

export interface InternetVideoMoment {
  startSeconds: number;
  endSeconds: number;
  confidence: number;
  description: string;
  /** What established it, when a later stage judged it with its transcript. Absent: footage alone. */
  source?: 'visual' | 'multimodal';
}

/**
 * A stage that could not judge one flagged stretch. The seconds are carried
 * so a caller can say which stretch went unexamined rather than only that
 * something did.
 */
export interface InternetVideoFailure {
  id: string;
  reason: string;
  startSeconds?: number;
  endSeconds?: number;
}

export interface InternetVideoAnalysis {
  model: string;
  revision: string;
  durationSeconds: number;
  watchedEvents: number;
  /**
   * How far the watch read. The watcher reads frames in order and stops once
   * it has flagged `maxEvents` moments, so the end of the last flagged moment
   * is where reading ended; fewer flagged means it read to the end.
   */
  watchedThroughSeconds: number;
  verified: InternetVideoMoment[];
  failures: InternetVideoFailure[];
  metrics: Record<string, unknown>;
}

/** The most moments one watch may flag before it stops reading; mirrors the client's default. */
export const DEFAULT_WATCH_MAX_EVENTS = 64;

/**
 * Understand one accessible video candidate through the source/model ports.
 *
 * Today the stored-video source is read by VideoChat3. The retrieval pipeline
 * does not know how VideoChat3 is served, which lets a later model adapter
 * replace it without rewriting embeddings, reranking, or evidence handling.
 */
export async function analyzeInternetVideo(input: {
  query: string;
  videoUrl: string;
  videoKey: string;
  expectedBytes?: number;
  /** The most moments the watch may flag before it stops reading. */
  maxEvents?: number;
}): Promise<InternetVideoAnalysis> {
  const maxEvents = input.maxEvents ?? DEFAULT_WATCH_MAX_EVENTS;
  const source: StoredVideoSource = {
    kind: 'stored-video',
    id: input.videoKey,
    videoUrl: input.videoUrl,
    videoKey: input.videoKey,
    expectedBytes: input.expectedBytes,
  };
  const watched = await watchVideo({
    model: videoChat3Adapter,
    source,
    query: input.query,
    maxEvents,
  });
  const watchedThroughSeconds = watched.watchedThroughSeconds;

  const intervals = watched.moments.map((event, index) => ({
    id: `watch-${index}`,
    start: event.startSeconds,
    end: event.endSeconds,
    description: event.description,
  }));
  const intervalById = new Map(intervals.map((row) => [row.id, row]));
  const failureAt = (id: string, reason: string): InternetVideoFailure => {
    const interval = intervalById.get(id);
    return interval ? { id, reason, startSeconds: interval.start, endSeconds: interval.end } : { id, reason };
  };

  if (intervals.length === 0) {
    return {
      model: watched.model,
      revision: watched.revision,
      durationSeconds: watched.durationSeconds,
      watchedThroughSeconds,
      watchedEvents: 0,
      verified: [],
      failures: [],
      metrics: { watch: watched.metrics },
    };
  }

  const [queryEmbedding, intervalEmbeddings] = await Promise.all([
    embedQuery(input.query),
    embedVideoIntervals({
      videoUrl: input.videoUrl,
      videoKey: input.videoKey,
      expectedBytes: input.expectedBytes,
      intervals: intervals.map(({ id, start, end }) => ({ id, start, end })),
    }),
  ]);

  const queryVector = queryEmbedding.embedded.find((row) => row.id === 'query')?.embedding;
  if (!queryVector) throw new Error('Qwen embedding service returned no query vector');

  const embeddingById = new Map(intervalEmbeddings.embedded.map((row) => [row.id, row.embedding]));
  const embeddingRanked = intervals
    .filter((row) => embeddingById.has(row.id))
    .map((row) => ({
      ...row,
      score: cosineSimilarity(queryVector, embeddingById.get(row.id)!),
    }))
    .sort((left, right) => right.score - left.score);

  const failures = intervalEmbeddings.failed.map((failure) => failureAt(failure.id, `embedding failed: ${failure.reason}`));

  if (embeddingRanked.length === 0) {
    return {
      model: watched.model,
      revision: watched.revision,
      durationSeconds: watched.durationSeconds,
      watchedThroughSeconds,
      watchedEvents: watched.moments.length,
      verified: [],
      failures,
      metrics: {
        watch: watched.metrics,
        embedding: intervalEmbeddings.metrics,
      },
    };
  }

  const reranked = await rerankVideoIntervals({
    query: input.query,
    videoUrl: input.videoUrl,
    videoKey: input.videoKey,
    expectedBytes: input.expectedBytes,
    candidates: embeddingRanked.map(({ id, start, end }) => ({ id, start, end })),
  });

  failures.push(...reranked.failed.map((failure) => failureAt(failure.id, `reranker failed: ${failure.reason}`)));

  const ordered = reranked.ranked
    .map((row) => intervalById.get(row.id))
    .filter((row): row is NonNullable<typeof row> => row !== undefined);

  if (ordered.length === 0) {
    return {
      model: watched.model,
      revision: watched.revision,
      durationSeconds: watched.durationSeconds,
      watchedThroughSeconds,
      watchedEvents: watched.moments.length,
      verified: [],
      failures,
      metrics: {
        watch: watched.metrics,
        embedding: intervalEmbeddings.metrics,
        rerank: reranked.metrics,
      },
    };
  }

  const verified = await verifyVideo({
    model: videoChat3Adapter,
    source,
    query: input.query,
    candidates: ordered.map(({ id, start, end }) => ({ id, start, end })),
  });

  failures.push(...verified.failed.map((failure) => failureAt(failure.id, `VideoChat3 verification failed: ${failure.reason}`)));

  const moments = verified.results
    .filter((result) => passesEvidenceGate(result))
    .map((result) => ({
      startSeconds: result.startSeconds,
      endSeconds: result.endSeconds,
      confidence: result.confidence,
      description: result.description || intervalById.get(result.id)?.description || '',
    }))
    .sort((left, right) => right.confidence - left.confidence);

  return {
    model: verified.model,
    revision: verified.revision,
    durationSeconds: watched.durationSeconds,
    watchedThroughSeconds,
    watchedEvents: watched.moments.length,
    verified: moments,
    failures,
    metrics: {
      watch: watched.metrics,
      embedding_model: intervalEmbeddings.model,
      embedding_revision: intervalEmbeddings.revision,
      embedding: intervalEmbeddings.metrics,
      rerank_model: reranked.model,
      rerank_revision: reranked.revision,
      rerank: reranked.metrics,
      verify: verified.metrics,
    },
  };
}
