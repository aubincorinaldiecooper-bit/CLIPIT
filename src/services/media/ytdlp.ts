import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { run, type ProcessError } from '../../lib/exec.js';
import { ExternalServiceError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

/** Accepts only public YouTube watch/short URLs, and only over http(s). */
export function isSupportedYoutubeUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  return YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase());
}

export interface YoutubeMetadata {
  id: string | null;
  title: string | null;
  durationSeconds: number | null;
  uploader: string | null;
  webpageUrl: string | null;
  isLive: boolean;
  availableSubtitleLangs: string[];
  availableAutoCaptionLangs: string[];
}

/**
 * Resolved once per process: either the configured path, or a file written
 * from YTDLP_COOKIES_CONTENT. `null` means no cookies are configured.
 */
let cookiesFile: string | null | undefined;

async function resolveCookiesFile(): Promise<string | null> {
  if (cookiesFile !== undefined) return cookiesFile;

  if (env.YTDLP_COOKIES_FILE) {
    cookiesFile = env.YTDLP_COOKIES_FILE;
    return cookiesFile;
  }

  if (env.YTDLP_COOKIES_CONTENT?.trim()) {
    // Environment variables frequently arrive with escaped newlines and tabs
    // (pasted through a dashboard), but the Netscape format is defined by
    // real ones, so restore them before writing.
    const content = env.YTDLP_COOKIES_CONTENT.replace(/\\n/g, '\n').replace(/\\t/g, '\t').trim();
    const withHeader = content.startsWith('#') ? content : `# Netscape HTTP Cookie File\n${content}`;

    const target = path.join(env.WORK_DIR, 'youtube-cookies.txt');
    await mkdir(path.dirname(target), { recursive: true });
    // Readable only by this process' user: it is a live YouTube session.
    await writeFile(target, `${withHeader}\n`, { mode: 0o600 });

    logger.info('wrote yt-dlp cookie jar from configuration', { target });
    cookiesFile = target;
    return cookiesFile;
  }

  cookiesFile = null;
  return cookiesFile;
}

/** Exported so the flag wiring can be asserted without invoking yt-dlp. */
export async function baseArgs(): Promise<string[]> {
  const args = ['--no-playlist', '--no-progress'];

  // Warnings are the only place yt-dlp says a PO-token provider was
  // unreachable, so suppress them everywhere except when diagnosing.
  if (env.YTDLP_VERBOSE) args.push('--verbose');
  else args.push('--no-warnings');

  // YouTube's signature challenges need a real JS engine, and yt-dlp will not
  // pick one up unless it is named explicitly.
  if (env.YTDLP_JS_RUNTIMES) args.push('--js-runtimes', env.YTDLP_JS_RUNTIMES);

  // Applies to yt-dlp only; the rest of the pipeline keeps its own egress.
  if (env.YTDLP_PROXY) args.push('--proxy', env.YTDLP_PROXY);

  const cookies = await resolveCookiesFile();
  if (cookies) args.push('--cookies', cookies);

  // Separate --extractor-args flags rather than one joined string, so an
  // operator-supplied override cannot corrupt the provider wiring.
  if (env.YTDLP_POT_BASE_URL) {
    args.push('--extractor-args', `youtubepot-bgutilhttp:base_url=${env.YTDLP_POT_BASE_URL}`);
  }
  if (env.YTDLP_EXTRACTOR_ARGS) args.push('--extractor-args', env.YTDLP_EXTRACTOR_ARGS);

  return args;
}

/**
 * Emits yt-dlp's full stderr when YTDLP_VERBOSE is on.
 *
 * ProcessError keeps only the last handful of lines in its message, which is
 * the right default but drops exactly what a YouTube failure needs: which
 * player clients were attempted, and whether the PO-token provider was
 * consulted or unreachable.
 */
function logYtdlpDiagnostics(error: unknown): void {
  if (!env.YTDLP_VERBOSE) return;
  const stderr = (error as ProcessError)?.stderr;
  if (stderr) logger.error('yt-dlp verbose output', { stderr });
}

/** Matches YouTube's "confirm you're not a bot" refusal, however it is worded. */
export function isBotCheck(message: string): boolean {
  return /confirm you.{0,3}re not a bot|sign in to confirm|cookies-from-browser/i.test(message);
}

/**
 * YouTube's bot check is by far the most common ingestion failure on a hosted
 * platform, and yt-dlp's raw output buries the actionable part under two wiki
 * links. Say what happened and what to do instead.
 */
export function describeYtdlpFailure(message: string): string {
  if (!isBotCheck(message)) return message;

  // Listed in the order worth trying: a token provider is the purpose-built
  // remedy, cookies are the fallback, a residential address is the last resort.
  const remedies: string[] = [];
  if (!env.YTDLP_POT_BASE_URL) {
    remedies.push('point YTDLP_POT_BASE_URL at a bgutil PO-token provider');
  }
  remedies.push(
    env.YTDLP_COOKIES_CONTENT || env.YTDLP_COOKIES_FILE
      ? 'refresh the configured cookies, which expire'
      : 'set YTDLP_COOKIES_CONTENT from a logged-in browser',
  );
  if (!env.YTDLP_PROXY) {
    remedies.push('route yt-dlp through a residential address with YTDLP_PROXY');
  }

  return `YouTube refused this request as automated traffic, which it does for most cloud hosts. Upload the file directly, or ${remedies.join('; ')}.`;
}

export async function fetchYoutubeMetadata(url: string): Promise<YoutubeMetadata> {
  let stdout: string;
  try {
    ({ stdout } = await run(env.YTDLP_PATH, [...(await baseArgs()), '--dump-single-json', url], {
      timeoutMs: 120_000,
    }));
  } catch (error) {
    const message = (error as Error).message;
    logYtdlpDiagnostics(error);
    throw new ExternalServiceError('yt-dlp', describeYtdlpFailure(message), {
      // Retrying a bot check just burns the attempt budget on the same answer.
      retryable: !isBotCheck(message),
      cause: error,
    });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(stdout) as Record<string, unknown>;
  } catch (error) {
    throw new ExternalServiceError('yt-dlp', 'Could not parse video metadata', { retryable: false, cause: error });
  }

  const duration = typeof parsed.duration === 'number' ? parsed.duration : null;

  return {
    id: typeof parsed.id === 'string' ? parsed.id : null,
    title: typeof parsed.title === 'string' ? parsed.title : null,
    durationSeconds: duration,
    uploader: typeof parsed.uploader === 'string' ? parsed.uploader : null,
    webpageUrl: typeof parsed.webpage_url === 'string' ? parsed.webpage_url : null,
    isLive: parsed.is_live === true,
    availableSubtitleLangs: Object.keys((parsed.subtitles as Record<string, unknown>) ?? {}),
    availableAutoCaptionLangs: Object.keys((parsed.automatic_captions as Record<string, unknown>) ?? {}),
  };
}

export interface YoutubeDownload {
  videoPath: string;
  /** Path to a downloaded WebVTT caption file, when the video has captions. */
  captionPath: string | null;
  captionLanguage: string | null;
  captionIsAutomatic: boolean;
}

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.m4v', '.flv', '.avi']);

/**
 * Downloads the source and, when enabled, its captions. Captions are requested
 * in the same pass so a video with creator or auto captions never needs paid
 * transcription.
 */
export async function downloadYoutubeVideo(url: string, outputDir: string): Promise<YoutubeDownload> {
  const args = [
    ...(await baseArgs()),
    '-f', env.YTDLP_FORMAT,
    '--merge-output-format', 'mp4',
    '--restrict-filenames',
    '-o', path.join(outputDir, 'source.%(ext)s'),
  ];

  if (env.YOUTUBE_PREFER_CAPTIONS) {
    args.push(
      '--write-subs',
      '--write-auto-subs',
      '--sub-langs', env.YOUTUBE_CAPTION_LANGS,
      '--sub-format', 'vtt/best',
      '--convert-subs', 'vtt',
    );
  }

  args.push(url);

  try {
    await run(env.YTDLP_PATH, args, { timeoutMs: 6 * 60 * 60 * 1000 });
  } catch (error) {
    const message = (error as Error).message;
    logYtdlpDiagnostics(error);
    throw new ExternalServiceError('yt-dlp', describeYtdlpFailure(message), {
      retryable: !isBotCheck(message),
      cause: error,
    });
  }

  const files = await readdir(outputDir);

  const videoFile = files.find((file) => {
    const extension = path.extname(file).toLowerCase();
    return file.startsWith('source.') && VIDEO_EXTENSIONS.has(extension);
  });

  if (!videoFile) {
    throw new ExternalServiceError('yt-dlp', 'Download produced no video file', { retryable: false });
  }

  // yt-dlp writes captions as `source.<lang>.vtt`; a manual track is preferred
  // over an automatic one when both exist.
  const captionFiles = files.filter((file) => file.startsWith('source.') && file.endsWith('.vtt'));
  const chosen = captionFiles[0] ?? null;
  const captionLanguage = chosen ? (chosen.split('.').at(-2) ?? null) : null;

  if (chosen) {
    logger.info('captions downloaded with source', { captionFile: chosen, captionLanguage });
  }

  return {
    videoPath: path.join(outputDir, videoFile),
    captionPath: chosen ? path.join(outputDir, chosen) : null,
    captionLanguage,
    // yt-dlp does not label the file, so treat any track as potentially
    // automatic; both are handled identically downstream.
    captionIsAutomatic: Boolean(chosen),
  };
}

export async function assertYtdlpAvailable(): Promise<void> {
  await run(env.YTDLP_PATH, ['--version'], { timeoutMs: 30_000 });
}
