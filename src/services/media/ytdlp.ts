import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../../config/env.js';
import { run } from '../../lib/exec.js';
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

function baseArgs(): string[] {
  const args = ['--no-playlist', '--no-progress', '--no-warnings'];
  if (env.YTDLP_COOKIES_FILE) args.push('--cookies', env.YTDLP_COOKIES_FILE);
  return args;
}

export async function fetchYoutubeMetadata(url: string): Promise<YoutubeMetadata> {
  let stdout: string;
  try {
    ({ stdout } = await run(env.YTDLP_PATH, [...baseArgs(), '--dump-single-json', url], {
      timeoutMs: 120_000,
    }));
  } catch (error) {
    throw new ExternalServiceError('yt-dlp', `Failed to read video metadata: ${(error as Error).message}`, {
      retryable: true,
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
    ...baseArgs(),
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
    throw new ExternalServiceError('yt-dlp', `Download failed: ${(error as Error).message}`, {
      retryable: true,
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
