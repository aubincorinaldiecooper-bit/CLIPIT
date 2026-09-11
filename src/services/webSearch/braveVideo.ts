import { z } from 'zod';
import { ExternalServiceError } from '../../lib/errors.js';
import { getWebVideoSearchConfig, requireBraveSearchApiKey } from './config.js';
import type { ProviderVideoResult, VideoSearchProvider, VideoSearchRequest } from './types.js';

const braveVideoResultSchema = z.object({
  url: z.string().url(),
  title: z.string().default(''),
  description: z.string().nullable().optional(),
  age: z.string().nullable().optional(),
  page_age: z.string().nullable().optional(),
  thumbnail: z.object({ src: z.string().url().optional() }).nullable().optional(),
  meta_url: z.object({ hostname: z.string().optional() }).nullable().optional(),
  video: z
    .object({
      duration: z.string().nullable().optional(),
      views: z.number().nullable().optional(),
      creator: z.string().nullable().optional(),
      publisher: z.string().nullable().optional(),
      requires_subscription: z.boolean().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const braveResponseSchema = z.object({
  type: z.literal('videos').optional(),
  results: z.array(braveVideoResultSchema).default([]),
});

function braveFreshness(value: VideoSearchRequest['freshness']): string | undefined {
  switch (value) {
    case 'day':
      return 'pd';
    case 'week':
      return 'pw';
    case 'month':
      return 'pm';
    case 'year':
      return 'py';
    default:
      return undefined;
  }
}

/** Brave caps q at both 400 characters and 50 words. */
function braveQuery(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  const atMostFiftyWords = collapsed.split(' ').slice(0, 50).join(' ');
  return atMostFiftyWords.slice(0, 400).trim();
}

function publishedAt(result: z.infer<typeof braveVideoResultSchema>): string | null {
  const value = result.page_age ?? null;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export class BraveVideoSearchProvider implements VideoSearchProvider {
  readonly id = 'brave-video';

  async search(request: VideoSearchRequest): Promise<ProviderVideoResult[]> {
    const config = getWebVideoSearchConfig();
    const apiKey = requireBraveSearchApiKey(config);
    const url = new URL(config.BRAVE_VIDEO_SEARCH_BASE_URL);
    url.searchParams.set('q', braveQuery(request.query));
    url.searchParams.set('count', String(Math.max(1, Math.min(50, request.count))));
    url.searchParams.set('country', (request.country ?? config.WEB_VIDEO_DEFAULT_COUNTRY).toUpperCase());
    url.searchParams.set('search_lang', (request.language ?? config.WEB_VIDEO_DEFAULT_LANGUAGE).toLowerCase());
    url.searchParams.set('safesearch', request.safeSearch ?? config.WEB_VIDEO_DEFAULT_SAFESEARCH);
    const freshness = braveFreshness(request.freshness);
    if (freshness) url.searchParams.set('freshness', freshness);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': apiKey,
        },
        signal: AbortSignal.timeout(config.WEB_VIDEO_SEARCH_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ExternalServiceError('brave-video-search', 'Brave Video Search could not be reached', {
        retryable: true,
        cause: error,
      });
    }

    let raw: string;
    try {
      raw = await response.text();
    } catch (error) {
      throw new ExternalServiceError('brave-video-search', 'Brave Video Search response could not be read', {
        retryable: true,
        cause: error,
      });
    }
    if (!response.ok) {
      throw new ExternalServiceError(
        'brave-video-search',
        `Brave Video Search failed with status ${response.status}: ${raw.slice(0, 400)}`,
        { retryable: [408, 425, 429, 500, 502, 503, 504].includes(response.status) },
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch (error) {
      throw new ExternalServiceError('brave-video-search', 'Brave Video Search returned invalid JSON', {
        retryable: false,
        cause: error,
      });
    }

    const parsed = braveResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError('brave-video-search', 'Brave Video Search response did not match the expected video contract', {
        retryable: false,
      });
    }

    return parsed.data.results.map((result, index) => ({
      url: result.url,
      title: result.title.trim(),
      description: result.description?.trim() || null,
      thumbnailUrl: result.thumbnail?.src ?? null,
      duration: result.video?.duration ?? null,
      views: result.video?.views ?? null,
      creator: result.video?.creator?.trim() || null,
      publisher: result.video?.publisher?.trim() || null,
      publishedAt: publishedAt(result),
      age: result.age ?? null,
      requiresSubscription: result.video?.requires_subscription ?? null,
      rank: index + 1,
    }));
  }
}
