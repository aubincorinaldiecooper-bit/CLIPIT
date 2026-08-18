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

  // --- MiniCPM ------------------------------------------------------------
  MINICPM_API_BASE_URL: z.string().trim().default('https://api.modelbest.cn/v1'),
  MINICPM_API_KEY: nonEmpty('MINICPM_API_KEY'),
  MINICPM_MODEL: z.string().trim().default('MiniCPM-V-4.6-1B'),
  MINICPM_CONCURRENCY: int(2, 1, 32),
  MINICPM_REQUEST_TIMEOUT_MS: int(180_000, 5_000, 900_000),
  MINICPM_MAX_RETRIES: int(3, 0, 10),
  MINICPM_MAX_TOKENS: int(1024, 128, 8192),
  MINICPM_TEMPERATURE: num(0.1, 0, 2),
  /**
   * Frames sampled from each analysis chunk and sent to the model.
   *
   * At the default 600s chunk this is one frame roughly every 4.7s, chosen so
   * short visual events (a goal, a headshot) are not missed between samples.
   * That costs proportionally more per request than a sparser sample; lower it
   * if inference volume matters more than recall on brief moments.
   */
  MINICPM_FRAMES_PER_CHUNK: int(128, 2, 512),
  /** Longest edge of each sampled frame, in pixels. */
  MINICPM_FRAME_MAX_WIDTH: int(448, 128, 1920),
  MINICPM_FRAME_JPEG_QUALITY: int(4, 1, 31),

  // --- Transcription (OpenRouter speech-to-text) -------------------------
  TRANSCRIPTION_ENABLED: bool(true),
  OPENROUTER_API_BASE_URL: z.string().trim().default('https://openrouter.ai/api/v1'),
  OPENROUTER_API_KEY: z.string().trim().optional(),
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
  ANALYSIS_CHUNK_SECONDS: int(600, 30, 3_600),
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
  YTDLP_COOKIES_FILE: z.string().trim().optional(),
  /**
   * Cookie jar contents (Netscape format) rather than a path.
   *
   * Hosted platforms block YouTube's bot check by IP, and cookies are the
   * documented remedy — but a container has no persistent disk to keep a
   * cookie file on. This is written to a file at startup so the deployment
   * needs nothing but an environment variable.
   */
  YTDLP_COOKIES_CONTENT: z.string().optional(),
  /**
   * Passed through to `--extractor-args`. YouTube's bot checks vary by player
   * client, so being able to try another one without a code change is the
   * difference between a variable edit and a deploy.
   */
  YTDLP_EXTRACTOR_ARGS: z.string().trim().optional(),
  /**
   * Base URL of a bgutil PO-token provider server.
   *
   * YouTube demands a Proof-of-Origin token from IP ranges it has flagged —
   * which is most of any cloud host — and refuses with "Sign in to confirm
   * you're not a bot" when one is absent. The provider mints them; this points
   * yt-dlp's plugin at it. Empty means no PO tokens, which on a hosted
   * platform usually means no YouTube.
   */
  YTDLP_POT_BASE_URL: z.string().trim().optional(),
  /**
   * JavaScript runtimes yt-dlp may use to solve YouTube's signature
   * challenges. These are opt-in, and YouTube extraction fails without one.
   * The runtime image is Node-based, so `node` is always present.
   */
  YTDLP_JS_RUNTIMES: z.string().trim().default('node'),
  /**
   * Optional `--proxy` for yt-dlp only. The block YouTube applies is on the
   * source address, so routing just this traffic through a residential
   * address sidesteps it where tokens and cookies fall short. Supports
   * http(s) and socks5 (e.g. socks5://user:pass@host:1080).
   */
  YTDLP_PROXY: z.string().trim().optional(),
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
