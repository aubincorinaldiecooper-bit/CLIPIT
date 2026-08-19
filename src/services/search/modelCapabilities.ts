import { env } from '../../config/env.js';
import { ExternalServiceError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

/**
 * Guards against searching video with a model that cannot accept video.
 *
 * A model whose endpoints do not take video input is rejected by OpenRouter
 * before it ever reaches a provider ("No endpoints found that support input
 * video", HTTP 404). That is a configuration error, but without a preflight it
 * looks like a search failure: every chunk uploads several megabytes of base64
 * MP4, is refused in under a second, and the user is told only how many chunks
 * failed. Asking the catalogue first turns that into one cheap request and an
 * error that names the fix.
 *
 * The catalogue is authoritative here in a way this codebase cannot be — which
 * models expose video endpoints changes without any deploy on our side — so
 * the check reads it at runtime rather than hardcoding a list of known-good
 * slugs that would silently rot.
 */

/** Only the catalogue fields this check reads; everything else is ignored. */
interface CatalogueResponse {
  data?: Array<{ id?: unknown; architecture?: { input_modalities?: unknown } }>;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const CATALOGUE_TIMEOUT_MS = 15_000;
/** Enough to choose from without turning an error message into a model dump. */
const SUGGESTION_LIMIT = 12;

let cache: { slugs: Set<string>; fetchedAt: number } | null = null;
let inFlight: Promise<Set<string>> | null = null;

function catalogueUrl(): string {
  return `${env.OPENROUTER_API_BASE_URL.replace(/\/+$/, '')}/models`;
}

async function fetchVideoCapableSlugs(): Promise<Set<string>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CATALOGUE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(catalogueUrl(), {
      headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` },
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = (error as Error).name === 'AbortError';
    throw new ExternalServiceError(
      'openrouter-models',
      aborted ? 'Model catalogue request timed out' : `Model catalogue request failed: ${(error as Error).message}`,
      { retryable: true, cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new ExternalServiceError(
      'openrouter-models',
      `Model catalogue request failed with status ${response.status}`,
      { retryable: true },
    );
  }

  const payload = (await response.json()) as CatalogueResponse;
  const slugs = new Set<string>();
  for (const entry of payload.data ?? []) {
    if (typeof entry?.id !== 'string') continue;
    const modalities = entry.architecture?.input_modalities;
    if (!Array.isArray(modalities)) continue;
    if (modalities.some((value) => typeof value === 'string' && value.toLowerCase() === 'video')) {
      slugs.add(entry.id);
    }
  }
  return slugs;
}

/**
 * Cached list of slugs whose endpoints accept video input.
 *
 * Only successes are cached: caching a failed lookup would keep a worker
 * blind for the rest of the TTL over what may be a momentary blip.
 */
async function videoCapableSlugs(): Promise<Set<string>> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return cache.slugs;
  if (inFlight) return inFlight;

  inFlight = fetchVideoCapableSlugs()
    .then((slugs) => {
      cache = { slugs, fetchedAt: Date.now() };
      logger.info('loaded OpenRouter video-capable model list', { count: slugs.size });
      return slugs;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Fails fast when `OPENROUTER_VIDEO_MODEL` cannot accept video.
 *
 * If the catalogue itself is unreachable the search is allowed to proceed: a
 * diagnostic aid must not become a hard dependency that can take down search
 * on its own. The per-chunk request will still surface the real error.
 */
export async function assertVideoInputSupported(): Promise<void> {
  const model = env.OPENROUTER_VIDEO_MODEL;

  let slugs: Set<string>;
  try {
    slugs = await videoCapableSlugs();
  } catch (error) {
    logger.warn('could not verify video model capability, continuing', { model, err: error });
    return;
  }

  // An empty catalogue means we failed to understand the response, not that
  // video input is universally unavailable. Do not block search on that.
  if (slugs.size === 0) {
    logger.warn('model catalogue reported no video-capable models, continuing', { model });
    return;
  }

  if (slugs.has(model)) return;

  const suggestions = [...slugs].sort();
  const shown = suggestions.slice(0, SUGGESTION_LIMIT).join(', ');
  const extra = suggestions.length > SUGGESTION_LIMIT ? ` (+${suggestions.length - SUGGESTION_LIMIT} more)` : '';

  throw new ExternalServiceError(
    'openrouter-video',
    `OPENROUTER_VIDEO_MODEL is set to "${model}", which does not accept video input on OpenRouter. ` +
      `Set it to a video-capable model instead: ${shown}${extra}.`,
    { retryable: false },
  );
}

/** Test seam: drops the cached catalogue. */
export function resetVideoModelCapabilityCache(): void {
  cache = null;
  inFlight = null;
}
