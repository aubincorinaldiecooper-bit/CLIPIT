import type { VideoModelAdapter } from '../video/model.js';
import { watchVideo } from '../video/model.js';
import type { FrameStreamVideoSource } from '../video/source.js';
import type { ScoutCandidate, ScoutInspectionPlan, ScoutRuntime, ScoutId } from './scoutSwarm.js';

/**
 * Generic scout runtime: candidate + inspection plan -> video source -> model.
 *
 * This keeps internet search model-agnostic while allowing the orchestration to
 * decide where and how densely to look in a video.
 */
export function createVideoModelScoutRuntime<Candidate extends ScoutCandidate>(input: {
  model: VideoModelAdapter;
  sourceForInspection(candidate: Candidate, plan: ScoutInspectionPlan, scoutId: ScoutId): FrameStreamVideoSource;
  maxEvents?: number;
}): ScoutRuntime<Candidate> {
  return {
    async inspect({ query, candidate, scoutId, plan, signal, onMoment }) {
      const source = input.sourceForInspection(candidate, plan, scoutId);
      const watched = await watchVideo({
        model: input.model,
        source,
        query,
        signal,
        maxEvents: input.maxEvents,
        onMoment,
      });
      const completion = await source.completion;
      return {
        moments: onMoment ? [] : watched.moments,
        mediaSecondsObserved: completion.mediaSecondsObserved ?? watched.watchedThroughSeconds,
        exhausted: completion.exhausted && watched.exhausted === true,
        exhaustive: source.scanMode !== 'coarse' && completion.exhausted && watched.exhausted === true,
        metrics: { model: watched.model, revision: watched.revision, ...watched.metrics },
      };
    },
  };
}
