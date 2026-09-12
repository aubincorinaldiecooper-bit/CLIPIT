import { createHash } from 'node:crypto';
import { analyzeInternetVideo, type InternetVideoAnalysis } from './internetVideo.js';
import { discoverInternetVideos, type InternetVideoCandidate } from './webDiscovery.js';

export interface InternetVideoEvidence {
  candidate: InternetVideoCandidate;
  analysis: InternetVideoAnalysis;
}

export interface InternetVideoSearchResult {
  query: string;
  discovered: number;
  playable: number;
  watched: number;
  evidence: InternetVideoEvidence[];
  unresolved: InternetVideoCandidate[];
  failures: Array<{ candidateId: string; reason: string }>;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function internetVideoKey(mediaUrl: string): string {
  return `internet:${createHash('sha256').update(mediaUrl).digest('hex').slice(0, 32)}`;
}

async function analyzeBatch(
  query: string,
  candidates: InternetVideoCandidate[],
): Promise<{ evidence: InternetVideoEvidence[]; failures: Array<{ candidateId: string; reason: string }> }> {
  const evidence: InternetVideoEvidence[] = [];
  const failures: Array<{ candidateId: string; reason: string }> = [];

  await Promise.all(candidates.map(async (candidate) => {
    if (!candidate.mediaUrl) return;
    try {
      const analysis = await analyzeInternetVideo({
        query,
        videoUrl: candidate.mediaUrl,
        videoKey: internetVideoKey(candidate.mediaUrl),
      });
      if (analysis.verified.length > 0) evidence.push({ candidate, analysis });
    } catch (error) {
      failures.push({
        candidateId: candidate.id,
        reason: error instanceof Error ? error.message : 'internet video analysis failed',
      });
    }
  }));

  return { evidence, failures };
}

/**
 * Search the video web without blindly paying to watch every result.
 *
 * Discovery is cheap and broad. Footage understanding happens in bounded
 * batches. As soon as one batch produces verified evidence, the search stops;
 * if it produces nothing, the next batch is tried until the watch ceiling is
 * reached. No result count is forced: zero or one verified source is valid.
 */
export async function searchInternetVideos(query: string): Promise<InternetVideoSearchResult> {
  const candidates = await discoverInternetVideos(query);
  const playable = candidates.filter((candidate) => candidate.mediaUrl !== null);
  const unresolved = candidates.filter((candidate) => candidate.mediaUrl === null);
  const batchSize = intEnv('WEB_VIDEO_WATCH_BATCH_SIZE', 3, 1, 8);
  const maxWatched = intEnv('WEB_VIDEO_MAX_WATCHED', 9, 1, 30);

  const evidence: InternetVideoEvidence[] = [];
  const failures: Array<{ candidateId: string; reason: string }> = [];
  let watched = 0;

  for (let offset = 0; offset < playable.length && watched < maxWatched; offset += batchSize) {
    const batch = playable.slice(offset, Math.min(offset + batchSize, maxWatched));
    if (batch.length === 0) break;
    watched += batch.length;
    const result = await analyzeBatch(query, batch);
    evidence.push(...result.evidence);
    failures.push(...result.failures);
    if (result.evidence.length > 0) break;
  }

  evidence.sort((left, right) => {
    const leftScore = left.analysis.verified[0]?.confidence ?? 0;
    const rightScore = right.analysis.verified[0]?.confidence ?? 0;
    return rightScore - leftScore;
  });

  return {
    query,
    discovered: candidates.length,
    playable: playable.length,
    watched,
    evidence,
    unresolved,
    failures,
  };
}
