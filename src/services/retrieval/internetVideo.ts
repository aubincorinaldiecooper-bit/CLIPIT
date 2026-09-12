import { env } from '../../config/env.js';
import {
  cosineSimilarity,
  embedQuery,
  embedVideoIntervals,
  rerankVideoIntervals,
} from './qwenModal.js';
import { verifyWithVideoChat3, watchWithVideoChat3 } from '../videochat3/client.js';

export interface InternetVideoMoment {
  startSeconds: number;
  endSeconds: number;
  confidence: number;
  description: string;
}

export interface InternetVideoAnalysis {
  model: string;
  revision: string;
  durationSeconds: number;
  watchedEvents: number;
  verified: InternetVideoMoment[];
  failures: Array<{ id: string; reason: string }>;
  metrics: Record<string, unknown>;
}

/**
 * Understand one accessible internet-video candidate.
 *
 * Discovery metadata is never passed in as evidence. VideoChat3 first watches
 * the footage, Qwen embeddings retrieve broadly from those temporal leads,
 * Qwen reranks them, and VideoChat3 re-opens the exact intervals before a
 * moment is returned as verified.
 */
export async function analyzeInternetVideo(input: {
  query: string;
  videoUrl: string;
  videoKey: string;
  expectedBytes?: number;
}): Promise<InternetVideoAnalysis> {
  const watched = await watchWithVideoChat3({
    videoUrl: input.videoUrl,
    query: input.query,
    expectedBytes: input.expectedBytes,
  });

  const intervals = watched.events.map((event, index) => ({
    id: `watch-${index}`,
    start: event.startSeconds,
    end: event.endSeconds,
    description: event.description,
  }));

  if (intervals.length === 0) {
    return {
      model: watched.model,
      revision: watched.revision,
      durationSeconds: watched.durationSeconds,
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

  const intervalById = new Map(intervals.map((row) => [row.id, row]));
  const embeddingById = new Map(intervalEmbeddings.embedded.map((row) => [row.id, row.embedding]));
  const embeddingRanked = intervals
    .filter((row) => embeddingById.has(row.id))
    .map((row) => ({
      ...row,
      score: cosineSimilarity(queryVector, embeddingById.get(row.id)!),
    }))
    .sort((left, right) => right.score - left.score);

  const failures = intervalEmbeddings.failed.map((failure) => ({
    id: failure.id,
    reason: `embedding failed: ${failure.reason}`,
  }));

  if (embeddingRanked.length === 0) {
    return {
      model: watched.model,
      revision: watched.revision,
      durationSeconds: watched.durationSeconds,
      watchedEvents: watched.events.length,
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

  failures.push(...reranked.failed.map((failure) => ({
    id: failure.id,
    reason: `reranker failed: ${failure.reason}`,
  })));

  const ordered = reranked.ranked
    .map((row) => intervalById.get(row.id))
    .filter((row): row is NonNullable<typeof row> => row !== undefined);

  if (ordered.length === 0) {
    return {
      model: watched.model,
      revision: watched.revision,
      durationSeconds: watched.durationSeconds,
      watchedEvents: watched.events.length,
      verified: [],
      failures,
      metrics: {
        watch: watched.metrics,
        embedding: intervalEmbeddings.metrics,
        rerank: reranked.metrics,
      },
    };
  }

  const verified = await verifyWithVideoChat3({
    videoUrl: input.videoUrl,
    query: input.query,
    expectedBytes: input.expectedBytes,
    candidates: ordered.map(({ id, start, end }) => ({ id, start, end })),
  });

  failures.push(...verified.failed.map((failure) => ({
    id: failure.id,
    reason: `VideoChat3 verification failed: ${failure.reason}`,
  })));

  const moments = verified.results
    .filter((result) => result.match && result.confidence >= env.MIN_MATCH_CONFIDENCE)
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
    watchedEvents: watched.events.length,
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
