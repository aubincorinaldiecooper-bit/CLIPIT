import { BraveVideoSearchProvider } from './braveVideo.js';
import { getWebVideoSearchConfig } from './config.js';
import { mergeDiscoveredCandidates } from './normalize.js';
import { planVideoSearch, type VideoSearchPlan } from './planner.js';
import type {
  DiscoveredVideoCandidate,
  VideoSearchFreshness,
  VideoSearchSafeSearch,
  VideoSearchProvider,
} from './types.js';

export interface DiscoverInternetVideosInput {
  question: string;
  freshness?: VideoSearchFreshness;
  country?: string;
  language?: string;
  safeSearch?: VideoSearchSafeSearch;
}

export interface VideoDiscoveryResult {
  question: string;
  plan: VideoSearchPlan;
  candidates: DiscoveredVideoCandidate[];
  stats: {
    provider: string;
    subqueries: number;
    searchesSucceeded: number;
    searchesFailed: number;
    rawResults: number;
    uniqueCandidates: number;
    duplicatesRemoved: number;
    candidatesReturned: number;
    latencyMs: number;
  };
  searchFailures: Array<{ query: string; message: string }>;
  evidencePolicy: {
    searchResultsAreEvidence: false;
    analyzedCandidates: 0;
    note: string;
  };
}

/**
 * Discovery only. This intentionally stops before media acquisition: a search
 * result tells Clipit where footage may exist, never what the footage proves.
 */
export async function discoverInternetVideos(
  input: DiscoverInternetVideosInput,
  provider: VideoSearchProvider = new BraveVideoSearchProvider(),
): Promise<VideoDiscoveryResult> {
  const config = getWebVideoSearchConfig();
  const started = performance.now();
  const plan = await planVideoSearch(input.question);

  const settled = await Promise.all(
    plan.queries.map(async (query) => {
      try {
        const results = await provider.search({
          query,
          count: config.WEB_VIDEO_RESULTS_PER_QUERY,
          freshness: input.freshness,
          country: input.country,
          language: input.language,
          safeSearch: input.safeSearch,
        });
        return { ok: true as const, query, results };
      } catch (error) {
        return {
          ok: false as const,
          query,
          error,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  const successful = settled.filter((entry): entry is Extract<(typeof settled)[number], { ok: true }> => entry.ok);
  const failures = settled.filter((entry): entry is Extract<(typeof settled)[number], { ok: false }> => !entry.ok);

  // Preserve the provider's typed dependency error. The API error handler can
  // then return its normal upstream-unavailable response instead of turning a
  // Brave outage into an unrelated generic 500.
  if (successful.length === 0 && failures.length > 0) {
    throw failures[0]!.error;
  }

  const rawResults = successful.reduce((sum, entry) => sum + entry.results.length, 0);
  const merged = mergeDiscoveredCandidates(
    successful.map((entry) => ({ provider: provider.id, query: entry.query, results: entry.results })),
  );
  const candidates = merged.candidates.slice(0, config.WEB_VIDEO_MAX_CANDIDATES);

  return {
    question: input.question,
    plan,
    candidates,
    stats: {
      provider: provider.id,
      subqueries: plan.queries.length,
      searchesSucceeded: successful.length,
      searchesFailed: failures.length,
      rawResults,
      uniqueCandidates: merged.candidates.length,
      duplicatesRemoved: merged.duplicatesRemoved,
      candidatesReturned: candidates.length,
      latencyMs: Math.round(performance.now() - started),
    },
    searchFailures: failures.map((failure) => ({ query: failure.query, message: failure.message })),
    evidencePolicy: {
      searchResultsAreEvidence: false,
      analyzedCandidates: 0,
      note: 'These are discovery candidates only. Clipit has not accessed or analyzed their footage in this phase.',
    },
  };
}
