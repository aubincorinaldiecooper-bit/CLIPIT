import type {
  DiscoveredVideoCandidate,
  ProviderVideoResult,
  VideoPlatform,
} from './types.js';

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'source',
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower);
}

function isDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

export function canonicalizeVideoUrl(value: string): { canonicalUrl: string; hostname: string | null } {
  try {
    const url = new URL(value);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    for (const key of [...url.searchParams.keys()]) {
      if (isTrackingParam(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return { canonicalUrl: url.toString(), hostname: url.hostname };
  } catch {
    return { canonicalUrl: value.trim(), hostname: null };
  }
}

export function classifyVideoPlatform(hostname: string | null): VideoPlatform {
  if (!hostname) return 'other';
  const host = hostname.toLowerCase();
  if (host === 'youtu.be' || isDomain(host, 'youtube.com')) return 'youtube';
  if (isDomain(host, 'tiktok.com')) return 'tiktok';
  if (isDomain(host, 'instagram.com')) return 'instagram';
  if (host === 'x.com' || isDomain(host, 'twitter.com')) return 'x';
  if (isDomain(host, 'facebook.com') || isDomain(host, 'fb.watch')) return 'facebook';
  if (isDomain(host, 'vimeo.com')) return 'vimeo';
  return 'other';
}

function toCandidate(
  result: ProviderVideoResult,
  provider: string,
  query: string,
): DiscoveredVideoCandidate {
  const { canonicalUrl, hostname } = canonicalizeVideoUrl(result.url);
  return {
    ...result,
    canonicalUrl,
    hostname,
    platform: classifyVideoPlatform(hostname),
    discoveredBy: [query],
    provider,
    evidenceStatus: 'unverified_search_result',
    analyzed: false,
    access: {
      status: 'discovered_only',
      ingestible: false,
      reason: 'Discovery only: no remote-video acquisition path is enabled in this phase.',
    },
  };
}

export function mergeDiscoveredCandidates(
  groups: ReadonlyArray<{ provider: string; query: string; results: readonly ProviderVideoResult[] }>,
): { candidates: DiscoveredVideoCandidate[]; duplicatesRemoved: number } {
  const byUrl = new Map<string, DiscoveredVideoCandidate>();
  let rawCount = 0;

  for (const group of groups) {
    for (const result of group.results) {
      rawCount += 1;
      const candidate = toCandidate(result, group.provider, group.query);
      const existing = byUrl.get(candidate.canonicalUrl);
      if (!existing) {
        byUrl.set(candidate.canonicalUrl, candidate);
        continue;
      }

      if (!existing.discoveredBy.includes(group.query)) existing.discoveredBy.push(group.query);
      // Keep the strongest provider rank while filling metadata gaps from duplicates.
      existing.rank = Math.min(existing.rank, candidate.rank);
      existing.title ||= candidate.title;
      existing.description ||= candidate.description;
      existing.thumbnailUrl ||= candidate.thumbnailUrl;
      existing.duration ||= candidate.duration;
      existing.creator ||= candidate.creator;
      existing.publisher ||= candidate.publisher;
      existing.publishedAt ||= candidate.publishedAt;
      existing.age ||= candidate.age;
      existing.views ??= candidate.views;
      existing.requiresSubscription ??= candidate.requiresSubscription;
    }
  }

  const candidates = [...byUrl.values()].sort((a, b) => {
    const queryCoverage = b.discoveredBy.length - a.discoveredBy.length;
    if (queryCoverage !== 0) return queryCoverage;
    return a.rank - b.rank;
  });

  return { candidates, duplicatesRemoved: Math.max(0, rawCount - candidates.length) };
}
