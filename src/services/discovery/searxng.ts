import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { logger } from '../../lib/logger.js';

/**
 * Discovery, as a search provider and nothing more.
 *
 * A candidate is a page worth opening, not a file worth downloading. The
 * browser runtime plays the page and Gander watches the result, so nothing
 * here tries to resolve a page down to a media URL — that was the old
 * download-oriented path and it is deliberately absent.
 */
export interface Candidate {
  id: string;
  query: string;
  title: string;
  pageUrl: string;
  thumbnailUrl: string | null;
  source: string | null;
}

/** What any discovery provider has to offer. SearXNG is today's. */
export interface SearchProvider {
  search(query: string): Promise<Candidate[]>;
}

interface SearxResult {
  url?: unknown;
  title?: unknown;
  thumbnail?: unknown;
  engine?: unknown;
  engines?: unknown;
}

interface SearxReply {
  results?: unknown;
}

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'igshid',
  'mc_cid',
  'mc_eid',
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('utm_') || TRACKING_PARAMS.has(lower);
}

function configured(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for internet search`);
  return value.replace(/\/$/, '');
}

/**
 * First of these names that is actually set.
 *
 * This provider gave the discovery settings new names, but deployments were
 * configured under the old ones long before it existed. Reading both means an
 * existing deployment keeps the safe-search, language and limits it was given,
 * rather than having them silently replaced by the defaults below.
 */
function setting(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function numericSetting(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = Number(value ?? fallback);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

function isPrivateIp(address: string): boolean {
  if (net.isIP(address) === 4) {
    const [a = 0, b = 0] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  if (net.isIP(address) === 6) {
    const value = address.toLowerCase();
    return value === '::1' || value === '::' || value.startsWith('fe80:') ||
      value.startsWith('fc') || value.startsWith('fd') || value.startsWith('ff');
  }
  return true;
}

/**
 * Refuse anything that points back inside our own network.
 *
 * Carried over unchanged from the discovery path this replaces: a candidate
 * URL comes from a search engine, which means it comes from the internet,
 * which means it is not trusted.
 */
export async function assertPublicInternetUrl(raw: string): Promise<string> {
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('only http/https URLs are allowed');
  if (parsed.username || parsed.password) throw new Error('URLs containing credentials are not allowed');
  const records = await dns.lookup(parsed.hostname, { all: true });
  if (!records.length || records.some((row) => isPrivateIp(row.address))) {
    throw new Error('URL resolves to a private or unsupported network address');
  }
  return parsed.toString();
}

/**
 * Build a stable identity for a discovered page without changing the URL the
 * browser will actually navigate to.
 *
 * Search providers commonly return the same page with fragments, unambiguous
 * tracking parameters, `www`, parameter-order differences, or a trailing
 * slash. Those variants should consume one candidate slot, not several. The
 * canonical URL is therefore used only for deduplication and candidate
 * identity; `pageUrl` preserves the provider's real destination (apart from
 * its fragment).
 *
 * Generic parameters such as `source` and `ref` are deliberately preserved:
 * on arbitrary video sites they may select different content rather than act
 * as tracking metadata.
 */
export function canonicalizeCandidateUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    for (const key of [...url.searchParams.keys()]) {
      if (isTrackingParam(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch {
    return null;
  }
}

function navigablePageUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

function sourceName(row: SearxResult): string | null {
  if (typeof row.engine === 'string' && row.engine.trim()) return row.engine.trim();
  if (Array.isArray(row.engines)) {
    const first = row.engines.find((value): value is string => typeof value === 'string' && Boolean(value.trim()));
    if (first) return first.trim();
  }
  return null;
}

function candidateId(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 24);
}

/** Turn a SearXNG reply into candidates: deduplicated, capped, http(s) only. */
export function normalizeSearxResults(query: string, raw: unknown, limit: number): Candidate[] {
  const reply = (raw && typeof raw === 'object' ? raw : {}) as SearxReply;
  const rows = Array.isArray(reply.results) ? reply.results as SearxResult[] : [];
  const seen = new Set<string>();
  const candidates: Candidate[] = [];

  for (const row of rows) {
    if (typeof row.url !== 'string') continue;
    const pageUrl = navigablePageUrl(row.url);
    const canonicalUrl = canonicalizeCandidateUrl(row.url);
    if (!pageUrl || !canonicalUrl) continue;
    if (seen.has(canonicalUrl)) continue;
    seen.add(canonicalUrl);

    candidates.push({
      id: candidateId(canonicalUrl),
      query,
      title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : pageUrl,
      pageUrl,
      thumbnailUrl: typeof row.thumbnail === 'string' && row.thumbnail.trim() ? row.thumbnail.trim() : null,
      source: sourceName(row),
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

export const SEARCH_CANDIDATE_CEILING = 20;

/**
 * Drop anything that points inside our own network, before it is handed out.
 *
 * These URLs come from a search engine, so they come from the internet, and
 * the browser runtime will navigate to whatever is returned here. A result
 * naming localhost or a private range would make it fetch our own services on
 * an attacker's behalf, so the guard runs on every candidate rather than on
 * none: a page that fails it is discarded, and a thumbnail that fails it is
 * dropped from an otherwise good candidate.
 */
async function publicOnly(candidates: Candidate[]): Promise<Candidate[]> {
  const checked = await Promise.all(candidates.map(async (candidate) => {
    try {
      await assertPublicInternetUrl(candidate.pageUrl);
    } catch (error) {
      logger.warn('discarded a search result pointing inside the network', {
        pageUrl: candidate.pageUrl,
        reason: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    if (!candidate.thumbnailUrl) return candidate;
    try {
      await assertPublicInternetUrl(candidate.thumbnailUrl);
      return candidate;
    } catch {
      // The page is fine; only its picture is not worth fetching.
      return { ...candidate, thumbnailUrl: null };
    }
  }));

  const kept = checked.filter((row): row is Candidate => row !== null);
  if (kept.length !== candidates.length) {
    logger.warn('some search results were refused', {
      returned: candidates.length,
      kept: kept.length,
    });
  }
  return kept;
}

/**
 * Ask SearXNG what is worth watching for this query.
 *
 * Whatever the user typed is what is searched, passed through verbatim.
 */
export async function search(query: string): Promise<Candidate[]> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error('search query must not be empty');

  const base = configured('SEARXNG_URL');
  const limit = numericSetting(
    setting('WEB_SEARCH_MAX_CANDIDATES', 'WEB_VIDEO_MAX_CANDIDATES'),
    SEARCH_CANDIDATE_CEILING,
    1,
    100,
  );
  const timeoutMs = numericSetting(
    setting('WEB_SEARCH_TIMEOUT_MS', 'WEB_VIDEO_SEARCH_TIMEOUT_MS'),
    10_000,
    1_000,
    60_000,
  );
  const url = new URL('/search', `${base}/`);
  url.searchParams.set('q', trimmed);
  url.searchParams.set('format', 'json');
  url.searchParams.set('categories', 'videos');
  url.searchParams.set(
    'safesearch',
    setting('WEB_SEARCH_SAFESEARCH', 'WEB_VIDEO_DEFAULT_SAFESEARCH') ?? '0',
  );
  const language = setting('WEB_SEARCH_LANGUAGE', 'WEB_VIDEO_DEFAULT_LANGUAGE');
  if (language) url.searchParams.set('language', language);

  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`SearXNG search failed with HTTP ${response.status}`);
  return publicOnly(normalizeSearxResults(trimmed, await response.json(), limit));
}

export const searxngProvider: SearchProvider = { search };
