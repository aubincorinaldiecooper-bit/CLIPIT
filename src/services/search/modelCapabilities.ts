import { env } from '../../config/env.js';
import { ExternalServiceError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

/**
 * Guards against searching video with a model OpenRouter will not route video to.
 *
 * Such a request is refused before it reaches any provider ("No endpoints found
 * that support input video", HTTP 404). That is a configuration error, but
 * without a preflight it looks like a search failure: every chunk uploads
 * several megabytes of base64 MP4, is refused in under a second, and the user
 * is told only how many chunks failed.
 *
 * The check is a routed probe rather than a metadata lookup. `input_modalities`
 * in the model catalogue describes the *model*, while the 404 is about the
 * *endpoints* currently serving it — a model can advertise video and still have
 * no provider routing it today, which is exactly the case this guard exists to
 * catch. Sending one tiny video through the real path is the only answer that
 * cannot be stale or over-optimistic.
 */

/**
 * One 32x32 black H.264 frame in an MP4 container: 814 bytes, small enough to
 * be free in practice and real enough that routing treats it as video.
 */
const PROBE_MP4_BASE64 =
  'AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAALqbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAA' +
  'AQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'AAAAAgAAAjl0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAA' +
  'AAAAAAABAAAAAAAAAAAAAAAAAABAAAAAACAAAAAgAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAAAAABAAAAAAGx' +
  'bWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAABAAAAAQABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRl' +
  'b0hhbmRsZXIAAAABXG1pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAA' +
  'AQAAARxzdGJsAAAAuHN0c2QAAAAAAAAAAQAAAKhhdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAACAAIABIAAAASAAAAAAA' +
  'AAABDExhdmMgbGlieDI2NAAAAAAAAAAAAAAAAAAAAAAAAAAAGP//AAAALmF2Y0MBQsAK/+EAFmdCwArZCWwEQAAAAwBAAAAD' +
  'AIPEiZIBAAVoy4PLIAAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAACgAAAAoAAAABhzdHRzAAAAAAAAAAEAAAABAABA' +
  'AAAAABxzdHNjAAAAAAAAAAEAAAABAAAAAQAAAAEAAAAUc3RzegAAAAAAAAAUAAAAAQAAABRzdGNvAAAAAAAAAAEAAAMaAAAA' +
  'PXVkdGEAAAA1bWV0YQAAAAAAAAAhaGRscgAAAAAAAAAAbWRpcmFwcGwAAAAAAAAAAAAAAAAIaWxzdAAAAAhmcmVlAAAAHG1k' +
  'YXQAAAAQZYiEBX///w9FAAFC3yddeA==';

const CACHE_TTL_MS = 10 * 60 * 1000;
const PROBE_TIMEOUT_MS = 30_000;
const CATALOGUE_TIMEOUT_MS = 15_000;
/** Enough to choose from without turning an error message into a model dump. */
const SUGGESTION_LIMIT = 12;

/**
 * `inconclusive` means the probe told us nothing about video support — the
 * request failed for an unrelated reason such as exhausted credits or rate
 * limiting. It is never cached and never blocks a search.
 */
type ProbeVerdict = 'supported' | 'no-video-endpoint' | 'inconclusive';

let cache: { model: string; verdict: Exclude<ProbeVerdict, 'inconclusive'>; at: number } | null = null;
let inFlight: Promise<ProbeVerdict> | null = null;

function baseUrl(): string {
  return env.OPENROUTER_API_BASE_URL.replace(/\/+$/, '');
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
    ...(env.OPENROUTER_SITE_URL ? { 'HTTP-Referer': env.OPENROUTER_SITE_URL } : {}),
    ...(env.OPENROUTER_APP_NAME ? { 'X-Title': env.OPENROUTER_APP_NAME } : {}),
  };
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Asks OpenRouter to route one minimal video request and reads the verdict off the result. */
async function probeVideoRouting(): Promise<ProbeVerdict> {
  const model = env.OPENROUTER_VIDEO_MODEL;
  const body = JSON.stringify({
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'ok' },
          { type: 'video_url', video_url: { url: `data:video/mp4;base64,${PROBE_MP4_BASE64}` } },
        ],
      },
    ],
    max_tokens: 1,
    stream: false,
  });

  let response: Response;
  try {
    response = await withTimeout(PROBE_TIMEOUT_MS, (signal) =>
      fetch(`${baseUrl()}/chat/completions`, { method: 'POST', headers: headers(), body, signal }),
    );
  } catch (error) {
    logger.warn('video routing probe could not be sent', { model, err: error });
    return 'inconclusive';
  }

  if (response.ok) return 'supported';

  const detail = await response.text().catch(() => '');

  // The one failure that is definitely about capability rather than about
  // credit, load, or a bad key. Anything else must not be read as "no video".
  if (response.status === 404 && /no endpoints found/i.test(detail)) {
    return 'no-video-endpoint';
  }

  logger.warn('video routing probe was inconclusive', {
    model,
    status: response.status,
    detail: detail.slice(0, 200),
  });
  return 'inconclusive';
}

/**
 * Probe verdict for the configured model, cached per process.
 *
 * Only definite verdicts are cached: caching an inconclusive result would let
 * one momentary blip suppress the check for the rest of the TTL.
 */
async function cachedVerdict(): Promise<ProbeVerdict> {
  const model = env.OPENROUTER_VIDEO_MODEL;
  if (cache && cache.model === model && Date.now() - cache.at < CACHE_TTL_MS) return cache.verdict;
  if (inFlight) return inFlight;

  inFlight = probeVideoRouting()
    .then((verdict) => {
      if (verdict !== 'inconclusive') {
        cache = { model, verdict, at: Date.now() };
        logger.info('video routing probe complete', { model, verdict });
      }
      return verdict;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/** Only the catalogue fields the suggestion list reads. */
interface CatalogueResponse {
  data?: Array<{ id?: unknown; architecture?: { input_modalities?: unknown } }>;
}

/**
 * Models advertising video input, used only to suggest replacements.
 *
 * These are model-level claims, so any one of them may still fail to route —
 * which is why this never decides whether a search may proceed.
 */
async function videoCapableCandidates(): Promise<string[]> {
  try {
    const response = await withTimeout(CATALOGUE_TIMEOUT_MS, (signal) =>
      fetch(`${baseUrl()}/models`, { headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` }, signal }),
    );
    if (!response.ok) return [];

    const payload = (await response.json()) as CatalogueResponse;
    const slugs: string[] = [];
    for (const entry of payload.data ?? []) {
      if (typeof entry?.id !== 'string') continue;
      const modalities = entry.architecture?.input_modalities;
      if (!Array.isArray(modalities)) continue;
      if (modalities.some((value) => typeof value === 'string' && value.toLowerCase() === 'video')) {
        slugs.push(entry.id);
      }
    }
    return slugs.sort();
  } catch (error) {
    logger.warn('could not list video-capable model candidates', { err: error });
    return [];
  }
}

/**
 * Fails fast when `OPENROUTER_VIDEO_MODEL` will not accept video.
 *
 * A probe that cannot reach a verdict lets the search through: a diagnostic
 * must not become a hard dependency that can take down search on its own, and
 * the per-chunk request will still surface the real error.
 */
export async function assertVideoInputSupported(): Promise<void> {
  if ((await cachedVerdict()) !== 'no-video-endpoint') return;

  const model = env.OPENROUTER_VIDEO_MODEL;
  const candidates = await videoCapableCandidates();
  const shown = candidates.slice(0, SUGGESTION_LIMIT).join(', ');
  const extra = candidates.length > SUGGESTION_LIMIT ? ` (+${candidates.length - SUGGESTION_LIMIT} more)` : '';
  const suggestion = shown
    ? ` Models advertising video input: ${shown}${extra}.`
    : '';

  throw new ExternalServiceError(
    'openrouter-video',
    `OPENROUTER_VIDEO_MODEL is set to "${model}", which has no OpenRouter endpoint accepting video input.${suggestion}`,
    { retryable: false },
  );
}

/** Test seam: drops the cached probe verdict. */
export function resetVideoModelCapabilityCache(): void {
  cache = null;
  inFlight = null;
}
