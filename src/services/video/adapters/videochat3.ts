import { ExternalServiceError } from '../../../lib/errors.js';
import {
  verifyWithVideoChat3,
  watchWithVideoChat3,
} from '../../videochat3/client.js';
import type {
  VideoModelAdapter,
  VideoVerificationCandidate,
  VideoWatchResult,
} from '../model.js';
import { isStoredVideoSource } from '../source.js';

const DEFAULT_MAX_EVENTS = 64;

/**
 * Current VideoChat3 adapter.
 *
 * The model itself uses VideoChat3's StreamingSession internally, but the
 * deployed Modal boundary still accepts a fetchable video URL. Declaring only
 * `stored-video` here is intentional: the future live-frame adapter can be
 * added without lying to orchestration about what today's deployment accepts.
 */
export const videoChat3Adapter: VideoModelAdapter = {
  id: 'videochat3',
  sourceKinds: new Set(['stored-video']),

  async watch({ source, query, maxEvents }): Promise<VideoWatchResult> {
    if (!isStoredVideoSource(source)) {
      throw new ExternalServiceError('videochat3', `VideoChat3 cannot read source kind "${source.kind}"`, { retryable: false });
    }
    const eventCap = maxEvents ?? DEFAULT_MAX_EVENTS;
    const watched = await watchWithVideoChat3({
      videoUrl: source.videoUrl,
      query,
      expectedBytes: source.expectedBytes,
      maxEvents: eventCap,
    });
    const watchedThroughSeconds = watched.events.length >= eventCap
      ? (watched.events.at(-1)?.endSeconds ?? watched.durationSeconds)
      : watched.durationSeconds;

    return {
      model: watched.model,
      revision: watched.revision,
      durationSeconds: watched.durationSeconds,
      watchedThroughSeconds,
      moments: watched.events,
      metrics: watched.metrics,
    };
  },

  async verify({ source, query, candidates }): Promise<{
    model: string;
    revision: string;
    results: Array<{
      id: string;
      startSeconds: number;
      endSeconds: number;
      match: boolean;
      confidence: number;
      description: string;
    }>;
    failed: Array<{ id: string; reason: string }>;
    metrics: Record<string, unknown>;
  }> {
    if (!isStoredVideoSource(source)) {
      throw new ExternalServiceError('videochat3', `VideoChat3 cannot verify source kind "${source.kind}"`, { retryable: false });
    }
    return verifyWithVideoChat3({
      videoUrl: source.videoUrl,
      query,
      expectedBytes: source.expectedBytes,
      candidates: candidates as VideoVerificationCandidate[],
    });
  },
};
