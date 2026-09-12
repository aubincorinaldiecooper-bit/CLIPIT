import { env } from '../../../config/env.js';
import {
  cosineSimilarity,
  embedQuery,
  embedVideoIntervals,
  rerankVideoIntervals,
} from '../qwenModal.js';
import { verifyWithVideoChat3 } from '../../videochat3/client.js';
import type { VideoUsageReporter } from '../../search/openrouterVideo.js';
import type { Candidate } from './candidates.js';

interface FootageVerificationResult {
  model: string;
  revision: string;
  metrics: Record<string, unknown>;
}

export interface VerifiedSimpleMemCandidates {
  candidates: Candidate[];
  failed: Array<Candidate & { reason: string }>;
  result: FootageVerificationResult;
}

interface IdentifiedCandidate {
  id: string;
  candidate: Candidate;
}

function identify(candidates: readonly Candidate[]): IdentifiedCandidate[] {
  return candidates.map((candidate, index) => ({ id: `candidate-${index}`, candidate }));
}

function failureFor(
  identified: readonly IdentifiedCandidate[],
  id: string,
  reason: string,
): (Candidate & { reason: string }) | null {
  const row = identified.find((item) => item.id === id);
  return row ? { ...row.candidate, reason } : null;
}

export async function rerankSimpleMemCandidates(input: {
  query: string;
  candidates: readonly Candidate[];
  videoUrl: string;
  videoKey: string;
  expectedBytes: number;
  onUsage?: VideoUsageReporter;
}): Promise<VerifiedSimpleMemCandidates> {
  if (input.candidates.length === 0) {
    return {
      candidates: [],
      failed: [],
      result: { model: 'MCG-NJU/VideoChat3-4B', revision: 'not asked', metrics: {} },
    };
  }

  const identified = identify(input.candidates);
  const intervals = identified.map(({ id, candidate }) => ({
    id,
    start: candidate.startSeconds,
    end: candidate.endSeconds,
  }));

  const [queryEmbedding, videoEmbeddings] = await Promise.all([
    embedQuery(input.query),
    embedVideoIntervals({
      videoUrl: input.videoUrl,
      videoKey: input.videoKey,
      expectedBytes: input.expectedBytes,
      intervals,
    }),
  ]);

  const queryVector = queryEmbedding.embedded.find((row) => row.id === 'query')?.embedding;
  if (!queryVector) throw new Error('Qwen embedding service returned no query vector');

  const embeddingFailures: Array<Candidate & { reason: string }> = [];
  for (const failure of videoEmbeddings.failed) {
    const mapped = failureFor(identified, failure.id, `embedding failed: ${failure.reason}`);
    if (mapped) embeddingFailures.push(mapped);
  }

  const embeddedById = new Map(videoEmbeddings.embedded.map((row) => [row.id, row.embedding]));
  const embeddingRanked = identified
    .filter((row) => embeddedById.has(row.id))
    .map((row) => ({
      ...row,
      embeddingScore: cosineSimilarity(queryVector, embeddedById.get(row.id)!),
    }))
    .sort((a, b) => b.embeddingScore - a.embeddingScore);

  if (embeddingRanked.length === 0) {
    return {
      candidates: [],
      failed: embeddingFailures,
      result: {
        model: 'MCG-NJU/VideoChat3-4B',
        revision: 'not asked',
        metrics: {
          qwen_embedding_model: videoEmbeddings.model,
          qwen_embedding_revision: videoEmbeddings.revision,
          qwen_embedding_metrics: videoEmbeddings.metrics,
        },
      },
    };
  }

  const reranked = await rerankVideoIntervals({
    query: input.query,
    videoUrl: input.videoUrl,
    videoKey: input.videoKey,
    expectedBytes: input.expectedBytes,
    candidates: embeddingRanked.map(({ id, candidate }) => ({
      id,
      start: candidate.startSeconds,
      end: candidate.endSeconds,
    })),
  });

  const rerankFailures: Array<Candidate & { reason: string }> = [];
  for (const failure of reranked.failed) {
    const mapped = failureFor(identified, failure.id, `reranker failed: ${failure.reason}`);
    if (mapped) rerankFailures.push(mapped);
  }

  const rerankScoreById = new Map(reranked.ranked.map((row) => [row.id, row.score]));
  const ordered = reranked.ranked
    .map((row) => identified.find((item) => item.id === row.id))
    .filter((row): row is IdentifiedCandidate => row !== undefined);

  if (ordered.length === 0) {
    return {
      candidates: [],
      failed: [...embeddingFailures, ...rerankFailures],
      result: {
        model: 'MCG-NJU/VideoChat3-4B',
        revision: 'not asked',
        metrics: {
          qwen_embedding_model: videoEmbeddings.model,
          qwen_embedding_revision: videoEmbeddings.revision,
          qwen_embedding_metrics: videoEmbeddings.metrics,
          qwen_rerank_model: reranked.model,
          qwen_rerank_revision: reranked.revision,
          qwen_rerank_metrics: reranked.metrics,
        },
      },
    };
  }

  const verified = await verifyWithVideoChat3({
    videoUrl: input.videoUrl,
    query: input.query,
    expectedBytes: input.expectedBytes,
    candidates: ordered.map(({ id, candidate }) => ({
      id,
      start: candidate.startSeconds,
      end: candidate.endSeconds,
    })),
  });

  const verifiedCandidates: Candidate[] = [];
  const verificationFailures: Array<Candidate & { reason: string }> = [];

  for (const verdict of verified.results) {
    const row = identified.find((item) => item.id === verdict.id);
    if (!row) continue;
    if (!verdict.match || verdict.confidence < env.MIN_MATCH_CONFIDENCE) {
      verificationFailures.push({
        ...row.candidate,
        reason: 'VideoChat3 did not verify this interval as a matching moment',
      });
      continue;
    }
    verifiedCandidates.push({
      ...row.candidate,
      score: verdict.confidence,
      description: verdict.description || row.candidate.description,
    });
  }

  for (const failure of verified.failed) {
    const mapped = failureFor(identified, failure.id, `VideoChat3 verification failed: ${failure.reason}`);
    if (mapped) verificationFailures.push(mapped);
  }

  verifiedCandidates.sort((left, right) => right.score - left.score);

  return {
    candidates: verifiedCandidates,
    failed: [...embeddingFailures, ...rerankFailures, ...verificationFailures],
    result: {
      model: verified.model,
      revision: verified.revision,
      metrics: {
        qwen_embedding_model: videoEmbeddings.model,
        qwen_embedding_revision: videoEmbeddings.revision,
        qwen_embedding_metrics: videoEmbeddings.metrics,
        qwen_rerank_model: reranked.model,
        qwen_rerank_revision: reranked.revision,
        qwen_rerank_metrics: reranked.metrics,
        videochat3_metrics: verified.metrics,
        embedding_scores: embeddingRanked.map((row) => ({ id: row.id, score: row.embeddingScore })),
        rerank_scores: ordered.map((row) => ({ id: row.id, score: rerankScoreById.get(row.id) ?? null })),
        source_bytes: input.expectedBytes,
      },
    },
  };
}
