import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

export interface InternetVideoCandidate {
  id: string;
  query: string;
  title: string;
  pageUrl: string;
  mediaUrl: string | null;
  thumbnailUrl: string | null;
  source: string | null;
  resolvedBy: 'direct' | 'playwright' | 'unresolved';
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

// The current Modal watch/Qwen transports fetch one media file. HLS/DASH
// manifests are intentionally excluded until the transport can resolve and
// fetch their segments rather than downloading the manifest as if it were MP4.
const MEDIA_SUFFIXES = ['.mp4', '.webm', '.mov', '.m4v'];

function configured(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for internet video discovery`);
  return value.replace(/\/$/, '');
}

function numericEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name] ?? fallback);
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

export function looksLikePlayableMedia(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname.toLowerCase();
    return MEDIA_SUFFIXES.some((suffix) => path.endsWith(suffix));
  } catch {
    return false;
  }
}

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

export function normalizeSearxResults(query: string, raw: unknown, limit: number): InternetVideoCandidate[] {
  const reply = (raw && typeof raw === 'object' ? raw : {}) as SearxReply;
  const rows = Array.isArray(reply.results) ? reply.results as SearxResult[] : [];
  const seen = new Set<string>();
  const candidates: InternetVideoCandidate[] = [];

  for (const row of rows) {
    if (typeof row.url !== 'string') continue;
    let pageUrl: string;
    try {
      const parsed = new URL(row.url);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      parsed.hash = '';
      pageUrl = parsed.toString();
    } catch {
      continue;
    }
    if (seen.has(pageUrl)) continue;
    seen.add(pageUrl);

    const direct = looksLikePlayableMedia(pageUrl);
    candidates.push({
      id: candidateId(pageUrl),
      query,
      title: typeof row.title === 'string' && row.title.trim() ? row.title.trim() : pageUrl,
      pageUrl,
      mediaUrl: direct ? pageUrl : null,
      thumbnailUrl: typeof row.thumbnail === 'string' && row.thumbnail.trim() ? row.thumbnail.trim() : null,
      source: sourceName(row),
      resolvedBy: direct ? 'direct' : 'unresolved',
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

async function querySearx(query: string): Promise<InternetVideoCandidate[]> {
  const base = configured('SEARXNG_URL');
  const limit = numericEnv('WEB_VIDEO_MAX_CANDIDATES', 20, 1, 100);
  const timeoutMs = numericEnv('WEB_VIDEO_SEARCH_TIMEOUT_MS', 10_000, 1_000, 60_000);
  const url = new URL('/search', `${base}/`);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('categories', 'videos');
  url.searchParams.set('safesearch', process.env.WEB_VIDEO_DEFAULT_SAFESEARCH?.trim() || '0');
  if (process.env.WEB_VIDEO_DEFAULT_LANGUAGE?.trim()) {
    url.searchParams.set('language', process.env.WEB_VIDEO_DEFAULT_LANGUAGE!.trim());
  }

  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`SearXNG search failed with HTTP ${response.status}`);
  return normalizeSearxResults(query, await response.json(), limit);
}

async function resolveWithPlaywright(candidate: InternetVideoCandidate): Promise<InternetVideoCandidate> {
  if (candidate.mediaUrl) return candidate;
  const base = process.env.WEB_ACCESS_URL?.trim();
  const token = process.env.WEB_ACCESS_INTERNAL_TOKEN?.trim();
  if (!base || !token) return candidate;

  await assertPublicInternetUrl(candidate.pageUrl);
  const timeoutMs = numericEnv('WEB_ACCESS_TIMEOUT_MS', 20_000, 1_000, 60_000);
  const response = await fetch(new URL('/resolve', `${base.replace(/\/$/, '')}/`), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-clipit-web-access-token': token,
    },
    body: JSON.stringify({ pageUrl: candidate.pageUrl }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return candidate;
  const body = await response.json() as { mediaUrl?: unknown };
  if (typeof body.mediaUrl !== 'string' || !body.mediaUrl.trim()) return candidate;
  if (!looksLikePlayableMedia(body.mediaUrl.trim())) return candidate;
  const mediaUrl = await assertPublicInternetUrl(body.mediaUrl.trim());
  return { ...candidate, mediaUrl, resolvedBy: 'playwright' };
}

export async function discoverInternetVideos(query: string): Promise<InternetVideoCandidate[]> {
  const trimmed = query.trim();
  if (!trimmed) throw new Error('internet video query must not be empty');

  const candidates = await querySearx(trimmed);
  const resolverLimit = numericEnv('WEB_VIDEO_PLAYWRIGHT_CANDIDATES', 8, 0, 30);
  const concurrency = numericEnv('WEB_VIDEO_RESOLVE_CONCURRENCY', 3, 1, 8);
  const output = [...candidates];
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= Math.min(output.length, resolverLimit)) return;
      const candidate = output[index];
      if (!candidate || candidate.mediaUrl) continue;
      try {
        output[index] = await resolveWithPlaywright(candidate);
      } catch {
        // Discovery remains useful even when one page cannot be resolved.
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return output;
}
