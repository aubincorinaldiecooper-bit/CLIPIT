import 'dotenv/config';
import { z } from 'zod';

/**
 * Central environment configuration.
 *
 * Both the API process and the worker process load this module at startup, so a
 * missing or malformed variable fails loudly and immediately instead of at the
 * moment the first job runs.
 */

const bool = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
    });

const int = (defaultValue: number, min?: number, max?: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? defaultValue : Number(value)))
    .pipe(
      (() => {
        let schema = z.number().int();
        if (min !== undefined) schema = schema.min(min);
        if (max !== undefined) schema = schema.max(max);
        return schema;
      })(),
    );

const num = (defaultValue: number, min?: number, max?: number) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? defaultValue : Number(value)))
    .pipe(
      (() => {
        let schema = z.number();
        if (min !== undefined) schema = schema.min(min);
        if (max !== undefined) schema = schema.max(max);
        return schema;
      })(),
    );

const nonEmpty = (name: string) =>
  z
    .string({ required_error: `${name} is required` })
    .trim()
    .min(1, `${name} must not be empty`);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PORT: int(3000, 1, 65535),
  HOST: z.string().default('0.0.0.0'),
  API_CORS_ORIGIN: z.string().default('*'),
  /** Trust X-Forwarded-For (Railway terminates TLS at its edge proxy). */
  TRUST_PROXY: bool(true),

  // --- Postgres -----------------------------------------------------------
  DATABASE_URL: nonEmpty('DATABASE_URL'),
  DATABASE_SSL: bool(false),
  DATABASE_POOL_MAX: int(10, 1, 100),

  // --- Redis / BullMQ -----------------------------------------------------
  REDIS_URL: nonEmpty('REDIS_URL'),

  // --- Storage (S3 compatible) -------------------------------------------
  AWS_ACCESS_KEY_ID: nonEmpty('AWS_ACCESS_KEY_ID'),
  AWS_SECRET_ACCESS_KEY: nonEmpty('AWS_SECRET_ACCESS_KEY'),
  AWS_ENDPOINT_URL: z.string().trim().optional(),
  AWS_REGION: z.string().trim().default('us-east-1'),
  BUCKET_NAME: nonEmpty('BUCKET_NAME'),
  S3_FORCE_PATH_STYLE: bool(true),
  SIGNED_URL_EXPIRY_SECONDS: int(3600, 60, 604800),
  UPLOAD_URL_EXPIRY_SECONDS: int(3600, 60, 604800),
  BUCKET_CORS_AUTOCONFIGURE: bool(true),
  BUCKET_CORS_ORIGINS: z.string().trim().optional(),

  // --- OpenRouter video understanding and speech-to-text -----------------
  TRANSCRIPTION_ENABLED: bool(true),
  OPENROUTER_API_BASE_URL: z.string().trim().default('https://openrouter.ai/api/v1'),
  OPENROUTER_API_KEY: nonEmpty('OPENROUTER_API_KEY'),
  /**
   * Must be a slug OpenRouter will ROUTE video to, which is not the same as a
   * model that understands video: no Qwen3-VL size has a video endpoint there,
   * and every request against one is refused before reaching a provider.
   * Qwen3.6 Flash takes native `video_url` input. `google/gemini-2.5-flash` is
   * the comparison point if this proves weak at on-screen text.
   */
  OPENROUTER_VIDEO_MODEL: z.string().trim().default('qwen/qwen3.6-flash'),
  /**
   * Chunks are independent, so this sets how much of a search runs at once.
   * Ten chunks at 2 was five sequential rounds; 4 halves that while staying
   * well inside provider rate limits. Raise from measured latency, not guesses.
   */
  OPENROUTER_VIDEO_CONCURRENCY: int(4, 1, 16),
  /**
   * Room for the ANSWER, not for the answer plus the thinking that precedes
   * it. The reasoning budget below is added on top when the request is built,
   * because whether a provider charges reasoning against `max_tokens` varies —
   * and if it does, a bare 1024 is a budget the model can spend entirely on
   * thinking, returning a 200 with no answer in it. Two matches of JSON is
   * roughly 150 tokens, so this is already generous for its actual job.
   */
  OPENROUTER_VIDEO_MAX_TOKENS: int(1024, 128, 8192),
  /**
   * How long the model may think before answering.
   *
   * Measured, not guessed. Across a full ten-chunk run every chunk that found
   * a moment spent 438-1,700 reasoning tokens; the two that ran past that
   * found nothing and cost the run its wall clock — one spent 7,692 tokens
   * over 142 seconds and returned zero matches, which was 89% of the entire
   * search. 2500 keeps the whole productive band with headroom and ends the
   * runaways. Raise it from a measurement showing matches above the band, not
   * from a hunch that more thinking must be better.
   */
  OPENROUTER_VIDEO_REASONING_MAX_TOKENS: int(2500, 256, 32_000),
  OPENROUTER_VIDEO_TEMPERATURE: num(0.1, 0, 2),
  OPENROUTER_STT_MODEL: z.string().trim().default('openai/whisper-1'),
  /** Optional attribution headers OpenRouter uses for app ranking. */
  OPENROUTER_SITE_URL: z.string().trim().optional(),
  OPENROUTER_APP_NAME: z.string().trim().optional(),
  OPENROUTER_STT_CONCURRENCY: int(2, 1, 16),
  OPENROUTER_REQUEST_TIMEOUT_MS: int(300_000, 5_000, 900_000),
  OPENROUTER_MAX_RETRIES: int(3, 0, 10),
  /**
   * Audio is extracted from the source ONCE, then split into upload-sized
   * pieces purely to respect the Whisper request size limit. This is
   * independent of ANALYSIS_CHUNK_SECONDS.
   */
  TRANSCRIBE_SEGMENT_SECONDS: int(900, 60, 3_600),
  TRANSCRIBE_AUDIO_BITRATE: z.string().default('48k'),
  TRANSCRIBE_LANGUAGE: z.string().trim().optional(),
  /** Prefer creator/auto captions from yt-dlp before paying for Whisper. */
  YOUTUBE_PREFER_CAPTIONS: bool(true),
  YOUTUBE_CAPTION_LANGS: z.string().default('en.*,en'),

  // --- Sessions & rate limiting ------------------------------------------
  SESSION_TTL_SECONDS: int(2_592_000, 3_600, 31_536_000),
  /** When false, /api routes accept unauthenticated requests (local dev only). */
  REQUIRE_SESSION: bool(true),
  RATE_LIMIT_ENABLED: bool(true),
  RATE_LIMIT_SESSION_CREATE_PER_IP_HOURLY: int(30, 1, 10_000),
  RATE_LIMIT_VIDEOS_PER_SESSION_HOURLY: int(10, 1, 10_000),
  RATE_LIMIT_VIDEOS_PER_IP_HOURLY: int(30, 1, 10_000),
  RATE_LIMIT_SEARCH_PER_SESSION_HOURLY: int(20, 1, 10_000),
  RATE_LIMIT_SEARCH_PER_IP_HOURLY: int(60, 1, 10_000),
  RATE_LIMIT_GENERATE_PER_SESSION_HOURLY: int(60, 1, 10_000),
  RATE_LIMIT_GENERATE_PER_IP_HOURLY: int(180, 1, 10_000),
  RATE_LIMIT_READ_PER_SESSION_MINUTE: int(240, 1, 100_000),

  // --- Media pipeline -----------------------------------------------------
  MAX_SOURCE_DURATION_SECONDS: int(21_600, 1, 360_000),
  ANALYSIS_CHUNK_SECONDS: int(120, 30, 3_600),
  /**
   * On start, the worker sweeps videos whose matches predate stills and gives
   * them one, so results already on a user's screen do not stay text-only
   * forever. Bounded per start because each video decodes a whole proxy, and
   * this must never compete with a search someone is waiting on. Set false to
   * stop the sweep entirely.
   */
  THUMBNAIL_BACKFILL_ON_START: bool(true),
  THUMBNAIL_BACKFILL_VIDEO_LIMIT: int(25, 1, 500),
  PROXY_HEIGHT: int(360, 144, 1080),
  PROXY_FPS: num(2, 0.5, 30),
  PROXY_CRF: int(30, 0, 51),
  PROXY_PRESET: z.string().default('veryfast'),
  CLIP_PADDING_SECONDS: num(1.5, 0, 30),
  MIN_CLIP_SECONDS: num(2, 0.5, 600),
  MAX_CLIP_SECONDS: num(300, 1, 3_600),
  CLIP_VIDEO_CRF: int(20, 0, 51),
  CLIP_PRESET: z.string().default('veryfast'),
  CLIP_AUDIO_BITRATE: z.string().default('160k'),
  MIN_MATCH_CONFIDENCE: num(0.3, 0, 1),
  /**
   * Aggregation-stage merging of matches that describe the same moment,
   * including a moment split across a chunk boundary.
   */
  MATCH_MERGE_GAP_SECONDS: num(1.5, 0, 60),
  MATCH_MERGE_MIN_OVERLAP_RATIO: num(0.5, 0, 1),
  /** Default search modality when a request does not pin one. */
  CLIP_SEARCH_MODE: z.enum(['auto', 'visual', 'transcript', 'both']).default('auto'),
  /** How long a clip search waits for an in-flight transcript before searching without it. */
  TRANSCRIPT_WAIT_TIMEOUT_MS: int(600_000, 0, 3_600_000),
  TRANSCRIPT_WAIT_POLL_MS: int(10_000, 1_000, 120_000),
  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  YTDLP_PATH: z.string().default('yt-dlp'),
  YTDLP_FORMAT: z.string().default('bv*[height<=1080]+ba/b[height<=1080]/b'),
  YTDLP_JS_RUNTIMES: z.string().trim().default('node'),
  YTDLP_POT_BASE_URL: z.string().trim().optional(),
  YTDLP_COOKIES_FILE: z.string().trim().optional(),
  YTDLP_COOKIES_CONTENT: z.string().optional(),
  YTDLP_PROXY: z.string().trim().optional(),
  YTDLP_VERBOSE: bool(false),
  YTDLP_EXTRACTOR_ARGS: z.string().trim().optional(),
  /** Root for transient ffmpeg / yt-dlp scratch files. */
  WORK_DIR: z.string().default('/tmp/clipit'),

  // --- Workers ------------------------------------------------------------
  INGESTION_CONCURRENCY: int(2, 1, 32),
  PREPROCESS_CONCURRENCY: int(2, 1, 32),
  TRANSCRIPTION_CONCURRENCY: int(2, 1, 32),
  CLIP_SEARCH_CONCURRENCY: int(2, 1, 32),
  CLIP_GENERATION_CONCURRENCY: int(2, 1, 32),
  JOB_ATTEMPTS: int(3, 1, 10),
  JOB_BACKOFF_MS: int(5_000, 100, 600_000),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    // Printed rather than thrown so the failure is readable in Railway logs.
    console.error(`\nInvalid environment configuration:\n${details}\n`);
    console.error('See .env.example for the full list of supported variables.\n');
    process.exit(1);
  }

  const value = parsed.data;
  const problems: string[] = [];

  if (value.MAX_CLIP_SECONDS < value.MIN_CLIP_SECONDS) {
    problems.push('MAX_CLIP_SECONDS must be >= MIN_CLIP_SECONDS');
  }
  if (value.TRANSCRIPTION_ENABLED && !value.OPENROUTER_API_KEY) {
    problems.push(
      'OPENROUTER_API_KEY is required when TRANSCRIPTION_ENABLED=true (set TRANSCRIPTION_ENABLED=false to run visual-only search)',
    );
  }

  if (problems.length > 0) {
    console.error(`\nInvalid environment configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    process.exit(1);
  }
  return value;
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
