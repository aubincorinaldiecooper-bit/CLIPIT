export type VideoSearchFreshness = 'day' | 'week' | 'month' | 'year';
export type VideoSearchSafeSearch = 'off' | 'moderate' | 'strict';

export interface VideoSearchRequest {
  query: string;
  count: number;
  freshness?: VideoSearchFreshness;
  country?: string;
  language?: string;
  safeSearch?: VideoSearchSafeSearch;
}

export interface ProviderVideoResult {
  url: string;
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  duration: string | null;
  views: number | null;
  creator: string | null;
  publisher: string | null;
  publishedAt: string | null;
  age: string | null;
  requiresSubscription: boolean | null;
  rank: number;
}

export interface VideoSearchProvider {
  readonly id: string;
  search(request: VideoSearchRequest): Promise<ProviderVideoResult[]>;
}

export type VideoPlatform =
  | 'youtube'
  | 'tiktok'
  | 'instagram'
  | 'x'
  | 'facebook'
  | 'vimeo'
  | 'other';

export interface DiscoveredVideoCandidate extends ProviderVideoResult {
  canonicalUrl: string;
  hostname: string | null;
  platform: VideoPlatform;
  discoveredBy: string[];
  provider: string;
  evidenceStatus: 'unverified_search_result';
  analyzed: false;
  access: {
    status: 'discovered_only';
    ingestible: false;
    reason: string;
  };
}
