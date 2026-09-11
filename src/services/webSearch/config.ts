import { z } from 'zod';

const optionalTrimmed = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
  z.string().trim().optional(),
);

const configSchema = z.object({
  BRAVE_SEARCH_API_KEY: optionalTrimmed,
  BRAVE_VIDEO_SEARCH_BASE_URL: z
    .string()
    .trim()
    .url()
    .default('https://api.search.brave.com/res/v1/videos/search'),
  WEB_VIDEO_SEARCH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(12_000),
  WEB_VIDEO_MAX_SUBQUERIES: z.coerce.number().int().min(1).max(8).default(4),
  WEB_VIDEO_RESULTS_PER_QUERY: z.coerce.number().int().min(1).max(50).default(12),
  WEB_VIDEO_MAX_CANDIDATES: z.coerce.number().int().min(1).max(100).default(30),
  WEB_VIDEO_DEFAULT_COUNTRY: z.string().trim().min(2).max(3).default('ALL'),
  WEB_VIDEO_DEFAULT_LANGUAGE: z.string().trim().min(2).max(10).default('en'),
  WEB_VIDEO_DEFAULT_SAFESEARCH: z.enum(['off', 'moderate', 'strict']).default('moderate'),
});

export type WebVideoSearchConfig = z.infer<typeof configSchema>;

let cached: WebVideoSearchConfig | null = null;

/**
 * Web discovery is optional infrastructure, so its credential is validated
 * when the feature is called rather than preventing uploads from booting.
 */
export function getWebVideoSearchConfig(): WebVideoSearchConfig {
  if (cached) return cached;
  const parsed = configSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid web video search configuration: ${details}`);
  }
  cached = parsed.data;
  return cached;
}

export function requireBraveSearchApiKey(config = getWebVideoSearchConfig()): string {
  const key = config.BRAVE_SEARCH_API_KEY;
  if (!key) {
    throw new Error('BRAVE_SEARCH_API_KEY is required to use internet video discovery');
  }
  return key;
}

/** Tests can clear the lazy process-env snapshot without touching global app config. */
export function resetWebVideoSearchConfigForTests(): void {
  cached = null;
}
