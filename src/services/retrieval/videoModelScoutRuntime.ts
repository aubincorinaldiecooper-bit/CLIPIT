import type { VideoModelAdapter } from '../video/model.js';
import { watchVideo } from '../video/model.js';
import type { FrameStreamVideoSource } from '../video/source.js';
import type { ScoutCandidate, ScoutRuntime } from './scoutSwarm.js';

/**
 * Generic scout runtime: candidate -> video source -> chosen video model.
 *
 * This is the seam that makes internet search model-agnostic. Swapping
 * VideoChat3 for another live-capable model changes the adapter, not discovery,
 * browser playback, scout coordination, timestamps, or frontend progress.
 */
export function createVideoModelScoutRuntime<Candidate extends ScoutCandidate>(input: {
  model: VideoModelAdapter;
  sourceForCandidate(candidate: Candidate): FrameStreamVideoSource;
  maxEvents?: number;
}): ScoutRuntime<Candidate> {
  return {
    async inspect({ query, candidate, signal, onMoment }) {
      const source = input.sourceForCandidate(candidate);
      const watched = await watchVideo({
        model: input.model,
        source,
        query,
        signal,
        maxEvents: input.maxEvents,
        onMoment,
      });
      return {
        // Live moments have already been emitted through onMoment. Returning
        // them again would duplicate cards in the swarm. Direct callers that do
        // not supply a callback still receive the model's collected moments.
        moments: onMoment ? [] : watched.moments,
        mediaSecondsObserved: watched.watchedThroughSeconds,
        exhausted: watched.exhausted,
        metrics: { model: watched.model, revision: watched.revision, ...watched.metrics },
      };
    },
  };
}
