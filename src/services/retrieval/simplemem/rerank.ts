import { rerankVideoIntervals, type RerankResult } from '../../mediaIndex/qwen.js';
import type { Candidate } from './candidates.js';

export interface VerifiedSimpleMemCandidates {
  candidates: Candidate[];
  failed: Array<Candidate & { reason: string }>;
  result: RerankResult;
}

/**
 * Verifies Omni-SimpleMem's coarse memories against the actual source video.
 * Only intervals the reranker scored are allowed to become chat evidence;
 * unread intervals remain explicit failures rather than silently losing.
 */
export async function rerankSimpleMemCandidates(input: {
  query: string;
  candidates: readonly Candidate[];
  videoUrl: string;
  videoKey: string;
  expectedBytes: number;
}): Promise<VerifiedSimpleMemCandidates> {
  const ids = input.candidates.map((_, index) => `simplemem-${index}`);
  const byId = new Map(ids.map((id, index) => [id, input.candidates[index]!]));
  const result = await rerankVideoIntervals({
    query: input.query,
    videoUrl: input.videoUrl,
    videoKey: input.videoKey,
    expectedBytes: input.expectedBytes,
    candidates: input.candidates.map((candidate, index) => ({
      id: ids[index]!,
      start: candidate.startSeconds,
      end: candidate.endSeconds,
    })),
  });

  const candidates = result.ranked.flatMap((ranked) => {
    const candidate = byId.get(ranked.id);
    return candidate ? [{ ...candidate, score: ranked.score }] : [];
  });
  const failed = result.failed.flatMap((failure) => {
    const candidate = byId.get(failure.id);
    return candidate ? [{ ...candidate, reason: failure.reason }] : [];
  });
  return { candidates, failed, result };
}
