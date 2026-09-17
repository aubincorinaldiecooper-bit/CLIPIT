import type { Job } from 'bullmq';
import { logger } from '../../lib/logger.js';
import type { InternetSearchJob, InternetSearchMoment, InternetSearchProgress } from '../../queues/internetSearch.js';
import { search, type Candidate } from '../../services/discovery/searxng.js';
import { decideEnding } from '../../services/retrieval/internetSearchOutcome.js';
import { runScoutSwarm, type ScoutInspectionPlan, type ScoutId, type SwarmMoment } from '../../services/retrieval/scoutSwarm.js';
import { createVideoModelScoutRuntime } from '../../services/retrieval/videoModelScoutRuntime.js';
import { videoChat3Adapter } from '../../services/video/adapters/videochat3.js';
import { createWebFrameStreamSource } from '../../services/video/webFrameSource.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to watch pages`);
  return value.replace(/\/$/, '');
}

function enabled(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] ?? '').trim().toLowerCase());
}

function boundedNumber(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, value));
}

function sourceOf(candidate: Candidate): string | null {
  if (candidate.source) return candidate.source;
  try { return new URL(candidate.pageUrl).host.replace(/^www\./, ''); } catch { return null; }
}

function asMoment(candidate: Candidate, found: SwarmMoment<Candidate>[]): InternetSearchMoment {
  const marks = found
    .map((moment) => ({
      startSeconds: moment.startSeconds,
      endSeconds: moment.endSeconds,
      description: moment.description,
      ...(moment.confidence === undefined ? {} : { confidence: moment.confidence }),
      scoutVotes: moment.scoutVotes,
    }))
    .sort((one, other) => one.startSeconds - other.startSeconds);
  const said = marks.map((mark) => mark.confidence).filter((value): value is number => value !== undefined);
  return {
    id: candidate.id,
    pageUrl: candidate.pageUrl,
    title: candidate.title,
    still: candidate.thumbnailUrl,
    source: sourceOf(candidate),
    marks,
    ...(said.length === 0 ? {} : { confidence: Math.max(...said) }),
  };
}

function strength(moment: InternetSearchMoment): [number, number, number] {
  const maxVotes = moment.marks.reduce((best, mark) => Math.max(best, mark.scoutVotes ?? 1), 1);
  const seconds = moment.marks.reduce((total, mark) => total + (mark.endSeconds - mark.startSeconds), 0);
  return [maxVotes, moment.marks.length, seconds];
}

function asMoments(found: SwarmMoment<Candidate>[]): InternetSearchMoment[] {
  const byVideo = new Map<string, { candidate: Candidate; found: SwarmMoment<Candidate>[] }>();
  for (const moment of found) {
    const gathered = byVideo.get(moment.candidate.id) ?? { candidate: moment.candidate, found: [] };
    gathered.found.push(moment);
    byVideo.set(moment.candidate.id, gathered);
  }
  return [...byVideo.values()]
    .map((gathered) => asMoment(gathered.candidate, gathered.found))
    .sort((one, other) => {
      const [oneVotes, oneMarks, oneSeconds] = strength(one);
      const [otherVotes, otherMarks, otherSeconds] = strength(other);
      return otherVotes - oneVotes || otherMarks - oneMarks || otherSeconds - oneSeconds;
    });
}

function numeric(metrics: Record<string, unknown>, key: string): number | null {
  const value = metrics[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function text(metrics: Record<string, unknown>, key: string): string | null {
  const value = metrics[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function sum(values: Array<number | null>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function max(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value !== null);
  return finite.length === 0 ? null : Math.max(...finite);
}

/**
 * Realtime v2 keeps discovery narrow and spends model time inside the video.
 * The top seven candidates are searched in rank order. For each candidate all
 * four scouts make staggered sparse passes over the same first-ten-minute
 * horizon. Their overlapping signals are aggregated into candidate strength;
 * search does not spend time re-watching promising windows.
 */
export async function handleInternetSearch(job: Job<InternetSearchJob>): Promise<InternetSearchProgress> {
  const searchId = job.id ?? 'unknown';
  const log = logger.child({ search_id: searchId, component: 'internet_search' });
  const report = async (progress: InternetSearchProgress) => job.updateProgress(progress as unknown as Record<string, unknown>);
  const searchStartedAt = Date.now();

  await report({ phase: 'loading', moments: [], candidatesFound: 0 });
  const discoveryStartedAt = Date.now();
  const discovered = await search(job.data.query);
  const discoveryMs = Date.now() - discoveryStartedAt;
  if (discovered.length === 0) {
    const done: InternetSearchProgress = { phase: 'answered', moments: [], candidatesFound: 0, candidatesWatched: 0, outcome: 'no_candidates' };
    await report(done);
    log.info('internet search finished', {
      model: videoChat3Adapter.id,
      query_length: job.data.query.length,
      discovery_ms: discoveryMs,
      candidates_discovered: 0,
      candidates_considered: 0,
      videos: 0,
      marks: 0,
      wall_ms: Date.now() - searchStartedAt,
      status: 'completed',
      outcome: 'no_candidates',
    });
    return done;
  }

  const webAccessUrl = required('WEB_ACCESS_URL');
  const webAccessToken = required('WEB_ACCESS_INTERNAL_TOKEN');
  const realtimeV2 = enabled('VIDEO_STREAM_V2');
  const captureFps = realtimeV2 ? boundedNumber('VIDEO_STREAM_CAPTURE_FPS', 6, 0.2, 30) : 1;
  const horizonSeconds = realtimeV2 ? boundedNumber('INTERNET_WATCH_MAX_SECONDS', 600, 60, 600) : 90;
  const maxCandidates = realtimeV2 ? Math.round(boundedNumber('INTERNET_SEARCH_MAX_CANDIDATES', 7, 1, 7)) : 7;
  const coarseBurstSeconds = boundedNumber('VIDEO_STREAM_COARSE_BURST_SECONDS', 1, 0.25, 5);
  const coarseStrideSeconds = boundedNumber('VIDEO_STREAM_COARSE_STRIDE_SECONDS', 5, coarseBurstSeconds, 30);
  const candidates = discovered.slice(0, maxCandidates);

  log.info('internet search started', {
    model: videoChat3Adapter.id,
    stream_v2: realtimeV2,
    query_length: job.data.query.length,
    discovery_ms: discoveryMs,
    candidates_discovered: discovered.length,
    candidates_selected: candidates.length,
    capture_fps: captureFps,
    horizon_seconds: horizonSeconds,
    candidates_limit: maxCandidates,
    coarse_burst_seconds: coarseBurstSeconds,
    coarse_stride_seconds: coarseStrideSeconds,
  });

  // Being deployed is not the same as being able to take the call. If the
  // watcher cannot, there is nothing to learn from finding that out once per
  // page: stop here, name it, and spend nothing on browsers or queues.
  try {
    await videoChat3Adapter.assertReady?.('frame-stream');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const ending = decideEnding({ candidatesFound: candidates.length, candidatesWatched: 0, candidatesFullyWatched: 0, momentsFound: 0, failureReasons: [reason] });
    const done: InternetSearchProgress = {
      phase: ending.phase,
      moments: [],
      candidatesFound: candidates.length,
      candidatesWatched: 0,
      unexamined: candidates.length,
      outcome: ending.outcome,
      ...(ending.failure ? { failure: ending.failure } : {}),
    };
    await report(done);
    log.error('internet search could not start', {
      model: videoChat3Adapter.id,
      stream_v2: realtimeV2,
      query_length: job.data.query.length,
      discovery_ms: discoveryMs,
      candidates_discovered: discovered.length,
      candidates_selected: candidates.length,
      candidates_watched: 0,
      videos: 0,
      marks: 0,
      unexamined: candidates.length,
      outcome: ending.outcome,
      failure_kind: ending.failure?.kind ?? null,
      readiness_reason: reason,
      wall_ms: Date.now() - searchStartedAt,
      status: 'failed',
    });
    return done;
  }

  const runtime = createVideoModelScoutRuntime<Candidate>({
    model: videoChat3Adapter,
    sourceForInspection: (candidate: Candidate, plan: ScoutInspectionPlan, scoutId: ScoutId) => createWebFrameStreamSource({
      id: `${searchId}:${candidate.id}:${scoutId}:${plan.mode}:${plan.startSeconds.toFixed(1)}-${plan.endSeconds.toFixed(1)}`,
      pageUrl: candidate.pageUrl,
      webAccessUrl,
      webAccessToken,
      maxSeconds: Math.max(1, plan.endSeconds - plan.startSeconds),
      fps: captureFps,
      realtimeV2,
      startSeconds: plan.startSeconds,
      endSeconds: plan.endSeconds,
      scanMode: plan.mode === 'coarse' ? 'coarse' : 'continuous',
      burstSeconds: plan.burstSeconds,
      strideSeconds: plan.strideSeconds,
    }),
  });

  await report({ phase: 'searching', moments: [], candidatesFound: candidates.length });
  const result = await runScoutSwarm<Candidate>({
    searchId,
    query: job.data.query,
    candidates,
    runtime,
    maxCandidates,
    horizonSeconds,
    coarseBurstSeconds,
    coarseStrideSeconds,
    timeoutMs: realtimeV2 ? 10 * 60_000 : 5 * 60_000,
    onProgress: async (progress) => {
      if (progress.event !== 'moment.found' && progress.event !== 'moment.extended') return;
      await report({ phase: 'searching', moments: asMoments(progress.snapshot.moments), candidatesFound: candidates.length });
    },
  });

  const moments: InternetSearchMoment[] = asMoments(result.moments);
  const neverReached = Math.max(0, result.candidatesAvailable - result.candidatesConsidered);
  const notStarted = Math.max(0, result.candidatesConsidered - result.candidatesCompleted);
  const unexamined = result.failures.length + result.candidatesPartlyExamined + neverReached + notStarted;

  const successful = result.inspections.filter((inspection) => inspection.success);
  // A video counts as watched when at least one scout got a watch out of it.
  // Read from the inspections and not from `failures`, which also holds
  // moments rejected for being too long and drops inspections cut short by a
  // cancelled search — neither of which says whether the video was opened.
  const watchedCandidates = new Set(successful.map((inspection) => inspection.candidateId));
  const failedInspections = result.inspections.filter((inspection) => !inspection.success);
  // Watched right through means every second of the video was actually seen —
  // which is stricter than every watch coming back. A coarse scan samples a
  // second out of every five and reports `exhaustive: false` having succeeded,
  // and a watch stopped by its event cap reports `exhausted: false`. Counting
  // either as full coverage would let a fifth of a video stand in for all of
  // it, which is the same false absence this whole path exists to prevent,
  // one level down. A failed inspection carries both flags false already, so
  // this excludes those too.
  const seenInFull = new Map<string, boolean>();
  for (const inspection of result.inspections) {
    const whole = inspection.exhaustive === true && inspection.exhausted === true;
    seenInFull.set(inspection.candidateId, (seenInFull.get(inspection.candidateId) ?? true) && whole);
  }
  const fullyWatched = [...seenInFull.entries()].filter(([, whole]) => whole).map(([id]) => id);
  const failureReasons = failedInspections.map((inspection) => inspection.failureReason ?? 'the watch failed without saying why');
  const ending = decideEnding({
    candidatesFound: candidates.length,
    candidatesWatched: watchedCandidates.size,
    candidatesFullyWatched: fullyWatched.length,
    momentsFound: moments.length,
    failureReasons,
  });

  const done: InternetSearchProgress = {
    phase: ending.phase,
    moments,
    candidatesFound: candidates.length,
    candidatesWatched: ending.candidatesWatched,
    outcome: ending.outcome,
    ...(unexamined > 0 ? { unexamined } : {}),
    ...(ending.failure ? { failure: ending.failure } : {}),
  };
  await report(done);

  const inspectionMetrics = successful.map((inspection) => inspection.metrics);
  const containers = [...new Set(inspectionMetrics.map((metrics) => text(metrics, 'container')).filter((value): value is string => value !== null))];
  const framesSent = sum(inspectionMetrics.map((metrics) => numeric(metrics, 'client_frames_sent')));
  const framesProcessed = sum(inspectionMetrics.map((metrics) => numeric(metrics, 'client_frames_processed')));
  const framesDropped = sum(inspectionMetrics.map((metrics) => numeric(metrics, 'client_frames_dropped_for_lag')));
  const roundsProcessed = sum(inspectionMetrics.map((metrics) => numeric(metrics, 'rounds_processed')));
  const highResRounds = sum(inspectionMetrics.map((metrics) => numeric(metrics, 'high_res_rounds')));
  const maxVideoLagMs = max(inspectionMetrics.map((metrics) => numeric(metrics, 'max_video_lag_ms')));
  const modalTotalMs = sum(inspectionMetrics.map((metrics) => numeric(metrics, 'total_ms')));
  const modelRoundRate = modalTotalMs > 0 ? roundsProcessed / (modalTotalMs / 1000) : null;
  const frameDropRate = framesSent + framesDropped > 0 ? framesDropped / (framesSent + framesDropped) : 0;

  const resultEvidence = result.moments.map((moment) => ({
    moment_id: moment.id,
    candidate_id: moment.candidate.id,
    scout_id: moment.scoutId,
    start_seconds: moment.startSeconds,
    end_seconds: moment.endSeconds,
    confidence: moment.confidence ?? null,
    scout_votes: moment.scoutVotes,
    description: moment.description,
  }));

  const record = ending.phase === 'failed' ? log.error.bind(log) : log.info.bind(log);
  record(ending.phase === 'failed' ? 'internet search failed' : 'internet search finished', {
    model: videoChat3Adapter.id,
    stream_v2: realtimeV2,
    query_length: job.data.query.length,
    discovery_ms: discoveryMs,
    capture_fps: captureFps,
    horizon_seconds: horizonSeconds,
    candidates_limit: maxCandidates,
    coarse_burst_seconds: coarseBurstSeconds,
    coarse_stride_seconds: coarseStrideSeconds,
    candidates_discovered: discovered.length,
    videos: moments.length,
    marks: moments.reduce((total, moment) => total + moment.marks.length, 0),
    candidates_watched: watchedCandidates.size,
    candidates_watched_through: fullyWatched.length,
    outcome: ending.outcome,
    failure_kind: ending.failure?.kind ?? null,
    failure_count: ending.failure?.count ?? 0,
    candidates_considered: result.candidatesConsidered,
    candidates_completed: result.candidatesCompleted,
    partly_examined: result.candidatesPartlyExamined,
    media_seconds_observed: result.metrics.mediaSecondsObserved,
    inspect_operations: result.metrics.inspectOperations,
    first_moment_ms: result.metrics.firstMomentMs,
    unexamined,
    failures: result.failures,
    status: ending.phase === 'failed' ? 'failed' : result.status,
    swarm_status: result.status,
    wall_ms: result.metrics.wallMs,
    total_request_wall_ms: Date.now() - searchStartedAt,
    frames_sent: framesSent,
    frames_processed: framesProcessed,
    frames_dropped_for_lag: framesDropped,
    frame_drop_rate: Number(frameDropRate.toFixed(6)),
    rounds_processed: roundsProcessed,
    rounds_per_second: modelRoundRate === null ? null : Number(modelRoundRate.toFixed(3)),
    high_res_rounds: highResRounds,
    max_video_lag_ms: maxVideoLagMs,
    modal_containers: containers,
    modal_container_count: containers.length,
    shared_single_container: realtimeV2 ? containers.length === 1 : null,
    inspections: result.inspections,
    results: resultEvidence,
  });
  return done;
}
