import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ExternalServiceError } from '../../lib/errors.js';
import { Semaphore, sleep } from '../../lib/concurrency.js';
import { logger } from '../../lib/logger.js';

/**
 * OpenRouter speech-to-text client.
 *
 * POST {OPENROUTER_API_BASE_URL}/audio/transcriptions with multipart audio,
 * asking for verbose JSON so we get per-segment timestamps rather than a wall
 * of text. The API key never leaves the server: only the worker process calls
 * this, and nothing here is reachable from the public API.
 *
 * Timestamps returned here are relative to the audio file that was sent. The
 * caller adds each piece's offset to produce global video timestamps.
 */

const segmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
});

const responseSchema = z.object({
  text: z.string().optional(),
  segments: z.array(z.unknown()).optional(),
});

export interface TranscribedSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

const limiter = new Semaphore(env.OPENROUTER_STT_CONCURRENCY);

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function contentTypeFor(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.webm': 'audio/webm',
  };
  return map[extension] ?? 'application/octet-stream';
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
  };
  if (env.OPENROUTER_SITE_URL) headers['HTTP-Referer'] = env.OPENROUTER_SITE_URL;
  if (env.OPENROUTER_APP_NAME) headers['X-Title'] = env.OPENROUTER_APP_NAME;
  return headers;
}

async function requestTranscription(filePath: string): Promise<TranscribedSegment[]> {
  if (!env.OPENROUTER_API_KEY) {
    throw new ExternalServiceError('openrouter', 'OPENROUTER_API_KEY is not configured', { retryable: false });
  }

  const buffer = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentTypeFor(filePath) }), path.basename(filePath));
  form.append('model', env.OPENROUTER_STT_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  if (env.TRANSCRIBE_LANGUAGE) form.append('language', env.TRANSCRIBE_LANGUAGE);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.OPENROUTER_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${env.OPENROUTER_API_BASE_URL.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: buildHeaders(),
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = (error as Error).name === 'AbortError';
    throw new ExternalServiceError(
      'openrouter',
      aborted ? 'Transcription request timed out' : `Transcription request failed: ${(error as Error).message}`,
      { retryable: true, cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ExternalServiceError(
      'openrouter',
      `Transcription failed with status ${response.status}: ${body.slice(0, 400)}`,
      { retryable: RETRYABLE_STATUS.has(response.status) },
    );
  }

  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new ExternalServiceError('openrouter', 'Unexpected transcription response shape', { retryable: false });
  }

  const segments: TranscribedSegment[] = [];
  for (const raw of parsed.data.segments ?? []) {
    const segment = segmentSchema.safeParse(raw);
    if (!segment.success) continue;
    const text = segment.data.text.trim();
    if (!text) continue;
    segments.push({
      startSeconds: Math.max(0, segment.data.start),
      endSeconds: Math.max(segment.data.start, segment.data.end),
      text,
    });
  }

  // Some models return only flat text; keep it rather than losing the speech.
  if (segments.length === 0 && parsed.data.text?.trim()) {
    segments.push({ startSeconds: 0, endSeconds: 0, text: parsed.data.text.trim() });
  }

  return segments;
}

/** Transcribes one audio file, retrying transient failures with backoff. */
export async function transcribeAudioFile(filePath: string): Promise<TranscribedSegment[]> {
  return limiter.run(async () => {
    let lastError: unknown;

    for (let attempt = 0; attempt <= env.OPENROUTER_MAX_RETRIES; attempt += 1) {
      try {
        return await requestTranscription(filePath);
      } catch (error) {
        lastError = error;
        const retryable = error instanceof ExternalServiceError ? error.retryable : false;
        if (!retryable || attempt === env.OPENROUTER_MAX_RETRIES) break;
        const delay = Math.min(30_000, 1_000 * 2 ** attempt);
        logger.warn('retrying transcription', {
          attempt: attempt + 1,
          delayMs: delay,
          file: path.basename(filePath),
        });
        await sleep(delay);
      }
    }

    throw lastError;
  });
}
