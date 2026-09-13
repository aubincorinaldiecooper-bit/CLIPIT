import { mapGlobalRangeToChunk } from '../timestamps.js';
import { DEFAULT_WATCH_MAX_EVENTS, analyzeInternetVideo, type InternetVideoAnalysis } from './internetVideo.js';
import type { NewClipMatch } from '../../db/repositories/clipRequests.js';
import type { VideoChunk } from '../../domain/types.js';

/**
 * An uploaded video is read the way an internet video is: VideoChat3 watches
 * the analysis proxy for the question, Qwen embeddings and the Qwen reranker
 * order what it flagged, and VideoChat3 re-opens each candidate before it
 * becomes evidence. This module adds only what an upload needs on top of
 * that shared pipeline — a statement of how far the watcher read, and the
 * placing of verified moments on the video's chunk grid, which is where
 * every stored match lives.
 */

/**
 * The most moments one watch may flag before it stops reading. The stretch
 * after the last flagged moment is then reported as unwatched, never as
 * empty: the watcher did not look there.
 */
export const WATCH_MAX_EVENTS = DEFAULT_WATCH_MAX_EVENTS;

export interface UnwatchedTail {
  startSeconds: number;
  endSeconds: number;
}

export interface UploadedVideoAnalysis extends InternetVideoAnalysis {
  /** Seconds the watcher never reached, or null when it read to the end. */
  unwatched: UnwatchedTail | null;
}

/**
 * Where the watcher stopped, if it stopped early.
 *
 * VideoChat3's watch reads every frame in order and stops once it has flagged
 * `maxEvents` moments, so the end of the last flagged moment is exactly where
 * reading ended. A watch that flagged fewer read to the end of the video.
 */
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
  /** The row's duration, which the footage's own probe corroborates or replaces. */
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
}

/**
 * Put verified moments on the chunk grid so they can be stored as matches.
 *
 * A moment belongs to the chunk its start falls in (the last chunk when it
 * starts past the grid, which the proxy's tail rounding allows). Chunk-local
 * and global seconds are both written, the same way the per-chunk search
 * writes them, so everything downstream — merging, thumbnails, cutting —
 * treats a VideoChat3 moment and a per-chunk moment identically.
 */
export function placeMomentsOnChunks(
  moments: readonly PlaceableMoment[],
  chunks: readonly VideoChunk[],
  attribution: { instruction: string; provider: string; model: string },
): NewClipMatch[] {
  const found: NewClipMatch[] = [];
  for (const moment of moments) {
    const chunk = chunks.find((item) =>
      moment.startSeconds >= item.globalStartSeconds && moment.startSeconds < item.globalEndSeconds,
    ) ?? chunks.at(-1);
    if (!chunk) continue;
    const local = mapGlobalRangeToChunk(chunk, { startSeconds: moment.startSeconds, endSeconds: moment.endSeconds });
    if (!local) continue;
    found.push({
      chunkId: chunk.id,
      localStartSeconds: local.localStartSeconds,
      localEndSeconds: local.localEndSeconds,
      globalStartSeconds: local.globalStartSeconds,
      globalEndSeconds: local.globalEndSeconds,
      description: moment.description || `A moment matching "${attribution.instruction}"`,
      confidence: Math.max(0, Math.min(1, moment.confidence)),
      source: 'visual',
      provider: attribution.provider,
      model: attribution.model,
    });
  }
  return found;
}
