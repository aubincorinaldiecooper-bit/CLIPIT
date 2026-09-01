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

  // --- Social publishing (Zernio) ----------------------------------------
  // All optional: without them, publishing answers honestly that it is not
  // configured — the same pattern sign-in uses on the frontend.
  ZERNIO_BASE_URL: z.string().url().optional(),
  ZERNIO_API_KEY: z.string().min(1).optional(),
  /** Must point at this API's /api/connect/callback, reachable from a browser. */
  ZERNIO_CONNECT_REDIRECT_URL: z.string().url().optional(),
  ZERNIO_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** The frontend origin the connect callback bounces people back to. */
  FRONTEND_URL: z.string().url().optional(),

  // --- Team invitations ---------------------------------------------------
  // The same Resend account the sign-in links use. Optional: without a key,
  // an invite is still created and its link still works — the API says the
  // email could not be sent rather than pretending it arrived.
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM: z.string().min(1).optional(),
  UPLOAD_URL_EXPIRY_SECONDS: int(3600, 60, 604800),
  BUCKET_CORS_AUTOCONFIGURE: bool(true),
  BUCKET_CORS_ORIGINS: z.string().trim().optional(),

  // --- OpenRouter video understanding and speech-to-text -----------------
  TRANSCRIPTION_ENABLED: bool(true),
  /**
   * Which service reads the actual video. `openrouter` is the current
   * behaviour, unchanged. `minicpm` sends chunks to our own MiniCPM-V 4.6
   * deployment on Modal instead. Notes lookups and transcription stay on
   * OpenRouter under either setting — this switch governs only the calls that
   * carry video.
   */
  VIDEO_PROVIDER: z.enum(['openrouter', 'minicpm']).default('openrouter'),
  /**
   * The deployed Modal app, class and method that read video. Invoked through
   * Modal's SDK as private compute — there is no public HTTP endpoint to
   * protect, and nothing to reach without the API token.
   */
  MODAL_APP_NAME: z.string().trim().default('clipit-minicpm-v46'),
  MODAL_CLASS_NAME: z.string().trim().default('MiniCPMVideoService'),
  /** The environment holding the deployed app; passed explicitly to Modal. */
  MODAL_ENVIRONMENT: z.string().trim().default('main'),
  /**
   * One request's whole allowance, cold start included: Modal pulling the
   * model onto a GPU takes minutes when the app has scaled to zero, and a
   * timeout shorter than that would fail every first request of the day.
   * Also the lifetime of the signed chunk URL handed to Modal.
   */
  MINICPM_REQUEST_TIMEOUT_SECONDS: int(900, 30, 3600),
  /**
   * Deliberately 1 until measured. Each in-flight request can hold a GPU, and
   * unlike OpenRouter the bill here is per-second of GPU time, not per token
   * — eight concurrent chunks could mean eight containers. Raising this is a
   * cost decision the owner makes with numbers, not a default.
   */
  MINICPM_VIDEO_CONCURRENCY: int(1, 1, 8),
  MINICPM_MAX_RETRIES: int(2, 0, 5),
  /**
   * Wake the GPU when an upload STARTS, so the model loads while the bytes
   * are still arriving instead of after them.
   *
   * A cold MiniCPM container measured 36 seconds in production
   * (2026-08-30), and all of it landed after the upload finished — the exact
   * moment someone is waiting. Warming overlaps it with work already in
   * flight. The cost is an L4 held for the idle window below even when the
   * person never asks anything, so this is a latency-for-money trade and it
   * is switchable.
   */
  MINICPM_WARM_ON_UPLOAD: bool(true),
  /**
   * How long Modal keeps the warmed container after the last call. It is the
   * backstop under our own cool-down: if the worker dies mid-read, Modal
   * still releases the GPU rather than billing it indefinitely.
   */
  MINICPM_WARM_IDLE_SECONDS: int(300, 30, 3600),
  /**
   * The narrowest source-space 9:16 crop still worth delivering as a
   * smart_crop, in pixels of real source width.
   *
   * MiniCPM answers whether a crop is semantically safe; this answers whether
   * it is sharp enough. A 640x360 source crops to about 202px wide, which has
   * to be scaled more than fivefold in area to reach 1080x1920 — the meaning
   * survives and the picture does not. Below this, blurred_background is used
   * instead, which keeps the whole frame and so keeps every pixel a low-res
   * source actually has.
   *
   * 540 is half the 1080 delivery width: under it, more than half of every
   * horizontal pixel in the output is interpolated. A judgement, hence a knob.
   */
  VERTICAL_MIN_CROP_WIDTH: int(540, 64, 1080),
  /**
   * How many extra candidates to prepare per requested moment, so one media
   * failure does not shrink the deck. Every extra is a real clip cut, a real
   * GPU call and a real encode, so it is bounded twice — by ratio and ceiling.
   */
  VERTICAL_CANDIDATE_OVERFETCH: num(1.7, 1, 4),
  VERTICAL_CANDIDATE_CEILING: int(8, 1, 24),
  /** Bounded automatic retries per candidate. Creators never retry our faults. */
  VERTICAL_MAX_RENDER_ATTEMPTS: int(2, 1, 5),
  /**
   * How much footage around a moment a Re-clip re-examines. The point of the
   * window is boundary reconsideration — enough room before the hook and
   * after the payoff to move either edge meaningfully, without re-reading
   * footage that cannot belong to this moment. Clamped to the video's edges
   * at use.
   */
  RECLIP_CONTEXT_BEFORE_SECONDS: int(10, 0, 120),
  RECLIP_CONTEXT_AFTER_SECONDS: int(10, 0, 120),
  /**
   * Re-clips per moment, total, ever. Each one is a paid model call on GPU
   * time, requested by a single tap — without a ceiling, one frustrated
   * person rage-tapping is an unbounded bill. Two is the starting point, to
   * be revisited with re-clip acceptance data, not a felt sense.
   */
  MAX_RECLIPS_PER_MOMENT: int(2, 0, 10),
  /**
   * Clipit's own Modal API token — server-side only, never logged, never in
   * the browser. The Modal SDK also reads these names from the environment
   * itself; they are declared here so a missing credential fails at startup
   * instead of at the first video.
   */
  MODAL_TOKEN_ID: z.string().trim().optional(),
  MODAL_TOKEN_SECRET: z.string().trim().optional(),
  /**
   * What one hour of the Modal L4 costs, in dollars — the single place a GPU
   * price lives, for the estimated half of cost-per-source-hour.
   *
   * Deliberately no default. Modal's JS SDK exposes no supported billing API
   * (checked against modal@0.10.0's exports: only an internal gRPC message,
   * whose direct use Modal's own docs discourage), so estimates are computed
   * from measured GPU time × this rate — and a rate nobody verified would
   * quietly price everything wrong. Unset, estimated costs report "rate not
   * configured" instead of a number. Set it from modal.com/pricing or the
   * workspace's own billing page, and note the date in the dashboard note.
   */
  MODAL_L4_USD_PER_GPU_HOUR: z
    .string()
    .trim()
    .optional()
    .transform((value) => {
      if (value === undefined || value === '') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    }),
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
   * How many calls carrying video may be in flight at once — the whole
   * account, covering both reading a video at upload and searching its
   * footage. One number because the provider's limit is one limit: giving
   * reading its own allowance simply meant reading and searching could add up
   * to more than either was allowed.
   *
   * Measured: ten chunks at 4 read a 20-minute video in 130 seconds, three
   * rounds of about forty-five. 8 makes it two. Raise it from a real upload,
   * not a guess — past the provider's ceiling this turns into retries, which
   * makes everything slower rather than faster.
   */
  OPENROUTER_VIDEO_CONCURRENCY: int(8, 1, 16),
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
  /**
   * Reading a video into notes at upload, so a question can be answered from
   * text instead of re-watching the whole video every time it is asked.
   *
   * This was built, then switched off as a side effect of merging the
   * actual-video search — see CLAUDE.md. It is back on the model that watches
   * video rather than the sampled stills it originally used.
   */
  INDEXING_ENABLED: bool(true),
  /**
   * How long a question waits for the video to finish being read.
   *
   * Measured: reading a 20-minute video takes about 130 seconds, and searching
   * the same video's footage takes about the same. So waiting costs the person
   * nothing in time and saves fifty times the money — a question answered from
   * notes cost $0.0013 against $0.06 for the same question against footage.
   * Past the timeout we stop waiting and read the footage, because a person
   * waiting on a stuck index must still get an answer.
   */
  INDEX_WAIT_TIMEOUT_MS: int(240_000, 0, 900_000),
  INDEX_WAIT_POLL_MS: int(4_000, 500, 60_000),
  /**
   * Room for a description of everything in one chunk, which runs far longer
   * than a list of matching moments. An answer cut off mid-scene leaves a hole
   * in the notes that nothing downstream can see.
   */
  INDEX_ANSWER_MAX_TOKENS: int(3000, 512, 16_000),
  /**
   * How many notes lookups run at once. Higher than the video concurrency
   * because these carry no video: they are a text prompt and a short answer.
   */
  OPENROUTER_TEXT_CONCURRENCY: int(8, 1, 32),
  /**
   * Notes sent to the model in one request. A long video's notes do not fit
   * comfortably in a single prompt, and splitting them keeps every note in
   * front of the model rather than truncating the tail of a long video —
   * which would silently make the end of it unsearchable.
   */
  NOTES_PER_LOOKUP: int(250, 20, 2000),
  /** Room for the answer to a notes lookup: a list of moments, nothing more. */
  NOTES_ANSWER_MAX_TOKENS: int(1500, 256, 8192),
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
  /**
   * Shared secret between the frontend server and this API, for exchanging a
   * verified Better Auth sign-in for an API session. Optional: without it the
   * exchange route answers 503 and the app runs guest-only, which is how it
   * ran before accounts existed.
   */
  AUTH_BRIDGE_SECRET: z.string().trim().min(32).optional(),
  /**
   * Who may read the evaluation numbers: a comma-separated list of sign-in
   * email addresses. The product has no admin role, and quality, cost and
   * error rates are the owner's reading, not a user feature. Unset, the
   * evaluation route answers 404 for everyone — absent, not merely locked.
   */
  EVAL_OWNER_EMAILS: z.string().trim().optional(),
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
  /**
   * How long a session may go quiet before its footage is considered
   * unreachable and removed. Generous on purpose: a guest token lives in the
   * browser tab, so silence usually means the browser closed — but a tab left
   * open overnight is still someone's session, and deleting their video out
   * from under them is far worse than another day of storage.
   */
  FOOTAGE_IDLE_SECONDS: int(86_400, 300, 2_592_000),
  RETENTION_SWEEP_ENABLED: bool(true),
  RETENTION_SWEEP_INTERVAL_MS: int(3_600_000, 60_000, 86_400_000),
  RETENTION_VIDEO_LIMIT: int(50, 1, 500),
  /**
   * The daily summary of what people asked and whether we could answer it.
   * Footage is deleted when a session ends, so this is the form the learning
   * takes — see docs/learning-loop.md.
   */
  LEARNING_REPORT_ENABLED: bool(true),
  LEARNING_REPORT_INTERVAL_MS: int(86_400_000, 60_000, 604_800_000),
  LEARNING_REPORT_HOURS: int(24, 1, 720),
  THUMBNAIL_BACKFILL_ON_START: bool(true),
  THUMBNAIL_BACKFILL_VIDEO_LIMIT: int(25, 1, 500),
  PROXY_HEIGHT: int(360, 144, 1080),
  PROXY_FPS: num(2, 0.5, 30),
  PROXY_CRF: int(30, 0, 51),
  PROXY_PRESET: z.string().default('veryfast'),
  // The model is responsible for the moment's boundaries. Adding another
  // handle here made the rendered file longer than the timestamps shown in
  // the result, and compounded the prompt's former request for context.
  CLIP_PADDING_SECONDS: num(0, 0, 30),
  MIN_CLIP_SECONDS: num(2, 0.5, 600),
  MAX_CLIP_SECONDS: num(300, 1, 3_600),
  CLIP_VIDEO_CRF: int(20, 0, 51),
  CLIP_PRESET: z.string().default('veryfast'),
  /**
   * Longest the SHORTER side of a delivered clip may be. A clip is cut from
   * the original at the original's resolution, and a 4K original made that
   * a 4K encode: two of them at once took the worker to its 8GB ceiling and
   * the kernel killed ffmpeg mid-cut (2026-09-01, two clips lost after three
   * attempts each, a 240-second one delivered at 723MB). 1080 lines is what
   * every short-form platform re-encodes to anyway. Never upscales; raise to
   * 2160 to deliver 4K again.
   */
  CLIP_MAX_SHORT_SIDE: int(1080, 360, 4320),
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
  /**
   * Whether a video may be created from a YouTube URL. Off: the route refuses
   * one, the worker neither requires nor calls yt-dlp, and uploads are the
   * only way in. Everything yt-dlp needs to work from a server is still here
   * and is turned back on with one variable.
   */
  YOUTUBE_INGESTION_ENABLED: bool(false),
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
