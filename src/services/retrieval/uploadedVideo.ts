import { DEFAULT_WATCH_MAX_EVENTS, analyzeInternetVideo, type InternetVideoAnalysis } from './internetVideo.js';
import type { NewClipMatch } from '../../db/repositories/clipRequests.js';
import type { VideoChunk } from '../../domain/types.js';

export const WATCH_MAX_EVENTS = DEFAULT_WATCH_MAX_EVENTS;

export interface UnwatchedTail {
  startSeconds: number;
  endSeconds: number;
}

export interface UploadedVideoAnalysis extends InternetVideoAnalysis {
  unwatched: UnwatchedTail | null;
}

export function unwatchedTail(input: {
  watchedThroughSeconds: number;
  durationSeconds: number;
}): UnwatchedTail | null {
  const start = Math.max(0, input.watchedThroughSeconds);
  if (!Number.isFinite(input.durationSeconds) || start + 0.001 >= input.durationSeconds) return null;
  return { startSeconds: start, endSeconds: input.durationSeconds };
}

export async function analyzeUploadedVideo(input: {
  query: string;
  videoUrl: string;
  videoKey: string;
  expectedBytes?: number;
  durationSeconds: number | null;
}): Promise<UploadedVideoAnalysis> {
  const analysis = await analyzeInternetVideo({
    query: input.query,
    videoUrl: input.videoUrl,
    videoKey: input.videoKey,
    expectedBytes: input.expectedBytes,
    maxEvents: WATCH_MAX_EVENTS,
  });
  const durationSeconds = input.durationSeconds ?? analysis.durationSeconds;
  return {
    ...analysis,
    unwatched: unwatchedTail({ watchedThroughSeconds: analysis.watchedThroughSeconds, durationSeconds }),
  };
}

export interface PlaceableMoment {
  startSeconds: number;
  endSeconds: number;
  confidence: number;
  description: string;
  source?: NewClipMatch['source'];
  quote?: string | null;
  provider?: string | null;
  model?: string | null;
  promptVersion?: string | null;
}

/**
 * A chunk is only the stored row's anchor. Global seconds remain the source of
 * truth and may cross the anchor chunk's end. Only the full video's bounds
 * clamp a verified interval.
 */
export function placeMomentsOnChunks(
  moments: readonly PlaceableMoment[],
  chunks: readonly VideoChunk[],
  attribution: { instruction: string; provider: string; model: string; promptVersion?: string | null },
): NewClipMatch[] {
  const first = chunks[0];
  const last = chunks.at(-1);
  if (!first || !last) return [];
  const videoStart = first.globalStartSeconds;
  const videoEnd = last.globalEndSeconds;
  const found: NewClipMatch[] = [];

  for (const moment of moments) {
    const globalStartSeconds = Math.max(videoStart, moment.startSeconds);
    const globalEndSeconds = Math.min(videoEnd, moment.endSeconds);
    if (!Number.isFinite(globalStartSeconds) || !Number.isFinite(globalEndSeconds) || globalEndSeconds <= globalStartSeconds) {
      continue;
    }
    const chunk = chunks.find((item) =>
      globalStartSeconds >= item.globalStartSeconds && globalStartSeconds < item.globalEndSeconds,
    );
    if (!chunk) continue;

    found.push({
      chunkId: chunk.id,
      localStartSeconds: Number((globalStartSeconds - chunk.globalStartSeconds).toFixed(3)),
      localEndSeconds: Number((globalEndSeconds - chunk.globalStartSeconds).toFixed(3)),
      globalStartSeconds: Number(globalStartSeconds.toFixed(3)),
      globalEndSeconds: Number(globalEndSeconds.toFixed(3)),
      description: moment.description || `A moment matching "${attribution.instruction}"`,
      confidence: Math.max(0, Math.min(1, moment.confidence)),
      source: moment.source ?? 'visual',
      quote: moment.quote ?? null,
      provider: moment.provider ?? attribution.provider,
      model: moment.model ?? attribution.model,
      promptVersion: moment.promptVersion ?? attribution.promptVersion ?? null,
    });
  }
  return found;
}
