import {
  cosineSimilarity,
  embedQuery,
  embedVideoIntervals,
  rerankVideoIntervals,
} from '../qwenModal.js';
import { verifyWithVideoChat3, type VideoChat3Candidate } from '../../videochat3/client.js';
import { MISSING_TRANSCRIPT_REASON, attachTranscripts, passesEvidenceGate, transcriptPolicy } from '../mixedEvidence.js';
import type { VideoUsageReporter } from '../../search/openrouterVideo.js';
import type { EvidenceRequirement, ResolvedSearchMode } from '../../../domain/types.js';
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

/**
 * Memory proposes; footage verifies. Qwen embeds and reranks the remembered
 * intervals, and VideoChat3 re-opens the exact footage before any of them
 * is evidence. `mode` and `evidence` are the request's decision, made once
 * in handleClipSearch: for a `both` that needs 'all', each candidate is
 * verified together with the transcript of its own interval and one
 * without any is rejected here rather than verified visually instead; for
 * a `both` where 'any' source may establish a moment, a candidate with
 * speech is judged with it and a silent one on the footage, each labelled
 * by what established it.
 */
export async function rerankSimpleMemCandidates(input: {
  query: string;
  candidates: readonly Candidate[];
  videoId: string;
  videoUrl: string;
  videoKey: string;
  expectedBytes: number;
  mode: ResolvedSearchMode;
  evidence: EvidenceRequirement;
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

  let toVerify: VideoChat3Candidate[] = ordered.map(({ id, candidate }) => ({
    id,
    start: candidate.startSeconds,
    end: candidate.endSeconds,
  }));
  const transcriptFailures: Array<Candidate & { reason: string }> = [];
  const policy = transcriptPolicy(input.mode, input.evidence);
  const withTranscript = new Set<string>();
  let withoutTranscript = 0;
  if (policy !== 'none') {
    const attached = await attachTranscripts(input.videoId, toVerify);
    for (const candidate of attached.verifiable) withTranscript.add(candidate.id);
    withoutTranscript = attached.missing.length;
    if (policy === 'when_present') {
      // Every candidate is verified; the ones with speech carry it.
      const spoken = new Map(attached.verifiable.map((candidate) => [candidate.id, candidate]));
      toVerify = toVerify.map((candidate) => spoken.get(candidate.id) ?? candidate);
    } else {
      for (const candidate of attached.missing) {
        const mapped = failureFor(identified, candidate.id, MISSING_TRANSCRIPT_REASON);
        if (mapped) transcriptFailures.push(mapped);
      }
      toVerify = attached.verifiable;
    }
    if (toVerify.length === 0) {
      return {
        candidates: [],
        failed: [...embeddingFailures, ...rerankFailures, ...transcriptFailures],
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
            transcript_policy: policy,
            without_transcript: withoutTranscript,
          },
        },
      };
    }
  }

  const verified = await verifyWithVideoChat3({
    videoUrl: input.videoUrl,
    query: input.query,
    expectedBytes: input.expectedBytes,
    candidates: toVerify,
  });

  const verifiedCandidates: Candidate[] = [];
  const verificationFailures: Array<Candidate & { reason: string }> = [];

  for (const verdict of verified.results) {
    const row = identified.find((item) => item.id === verdict.id);
    if (!row) continue;
    if (!passesEvidenceGate(verdict)) {
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
      // What established it: footage judged with its transcript, or footage alone.
      source: withTranscript.has(verdict.id) ? 'multimodal' : 'visual',
    });
  }

  for (const failure of verified.failed) {
    const mapped = failureFor(identified, failure.id, `VideoChat3 verification failed: ${failure.reason}`);
    if (mapped) verificationFailures.push(mapped);
  }

  verifiedCandidates.sort((left, right) => right.score - left.score);

  return {
    candidates: verifiedCandidates,
    failed: [...embeddingFailures, ...rerankFailures, ...transcriptFailures, ...verificationFailures],
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
        transcript_policy: policy,
        without_transcript: withoutTranscript,
      },
    },
  };
}
