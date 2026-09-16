import { ExternalServiceError } from '../../../lib/errors.js';
import { verifyWithVideoChat3, watchStreamWithVideoChat3, watchWithVideoChat3 } from '../../videochat3/client.js';
import type { VideoModelAdapter, VideoVerificationCandidate, VideoWatchResult } from '../model.js';
import { isFrameStreamVideoSource, isStoredVideoSource } from '../source.js';

const DEFAULT_MAX_EVENTS = 64;

export const videoChat3Adapter: VideoModelAdapter = {
  id: 'videochat3',
  sourceKinds: new Set(['stored-video', 'frame-stream']),

  async watch({ source, query, maxEvents, signal, onMoment }): Promise<VideoWatchResult> {
    const eventCap = maxEvents ?? DEFAULT_MAX_EVENTS;
    if (isStoredVideoSource(source)) {
      const watched = await watchWithVideoChat3({ videoUrl: source.videoUrl, query, expectedBytes: source.expectedBytes, maxEvents: eventCap });
      for (const moment of watched.events) await onMoment?.(moment);
      // A capped offline watch did not reach the tail of the video. Preserve
      // the old evidence semantics: only the footage through the last emitted
      // event was actually examined, even though the downloaded file's total
      // duration is known.
      const capped = watched.events.length >= eventCap;
      const watchedThroughSeconds = capped
        ? (watched.events.at(-1)?.endSeconds ?? 0)
        : watched.durationSeconds;
      return {
        model: watched.model,
        revision: watched.revision,
        durationSeconds: watched.durationSeconds,
        watchedThroughSeconds,
        exhausted: !capped,
        moments: watched.events,
        metrics: watched.metrics,
      };
    }
    if (isFrameStreamVideoSource(source)) {
      const watched = await watchStreamWithVideoChat3({ source, query, signal, maxEvents: eventCap, onMoment });
      return {
        model: watched.model,
        revision: watched.revision,
        durationSeconds: watched.durationSeconds,
        watchedThroughSeconds: watched.watchedThroughSeconds ?? watched.durationSeconds,
        exhausted: watched.exhausted,
        moments: watched.events,
        metrics: watched.metrics,
      };
    }
    throw new ExternalServiceError('videochat3', `VideoChat3 cannot read source kind "${(source as { kind: string }).kind}"`, { retryable: false });
  },

  async verify({ source, query, candidates }) {
    if (!isStoredVideoSource(source)) throw new ExternalServiceError('videochat3', 'VideoChat3 interval verification requires stored footage', { retryable: false });
    return verifyWithVideoChat3({ videoUrl: source.videoUrl, query, expectedBytes: source.expectedBytes, candidates: candidates as VideoVerificationCandidate[] });
  },
};
