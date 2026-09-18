import type { Job } from 'bullmq';
import { logger } from '../../lib/logger.js';
import type { InternetSearchCandidate, InternetSearchJob, InternetSearchMoment, InternetSearchProgress } from '../../queues/internetSearch.js';
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

/**
 * Query parameters that say *which* video, rather than authorise access to one.
 *
 * An allowlist, not a denylist, and deliberately tiny. Guessing which names
 * look like credentials is a game you lose once and then keep losing quietly.
 */
const IDENTIFYING = new Set(['v']);

/**
 * A page address safe to write into a shared log.
 *
 * Discovery hands back whatever the search engine indexed, and
 * `navigablePageUrl` (searxng.ts:150) only drops the fragment — the whole
 * query string survives, credentials and all. So an address arriving as
 * `…/video?token=…` would otherwise be written out verbatim, which
 * `CLAUDE.md` forbids outright: credentials stay server-side and signed URLs
 * are never logged.
 *
 * What is kept is the origin, the path, and the handful of parameters that
 * name a video rather than unlock one — enough to open the page and see why
 * it could not be watched, which is the only reason this is logged at all.
 */
export function loggablePage(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    const keep = new URLSearchParams();
    for (const [name, value] of url.searchParams) {
      if (IDENTIFYING.has(name.toLowerCase())) keep.set(name, value);
    }
    url.search = keep.toString();
    url.hash = '';
    return url.toString().slice(0, 300);
  } catch {
    return null;
  }
}

/**
 * How many pages ride along on each poll. Twenty discovered candidates is the
 * usual shape; the cap is here so a strange day cannot put a megabyte through
 * a two-second poll.
 */
export const MAX_REPORTED_CANDIDATES = 40;

/**
 * The pages the search was given, and how far it got with each.
 *
 * Everything this needs is already assembled where the search reports
 * progress — the discovered list, which ids have been handed to a scout, and
 * which the swarm has got a watch out of. Until now it went into a log line
 * and no further, so the only way to ask "which of the seven would not open"
 * was to read the worker's logs.
 *
 * The one rule it exists to hold: a page nobody was ever sent to is
 * `not_reached`, never `unwatched`. The swarm takes at most `maxCandidates`
 * of what discovery found, and a search that dies stops handing them out, so
 * "we never tried" is a real and common outcome. Reporting it as "would not
 * open" would be inventing a failure for a page that was never opened.
 */
export function candidateRoll(
  candidates: Candidate[],
  announced: ReadonlySet<string>,
  watchedIds: Iterable<string>,
  stillRunning: boolean,
): InternetSearchCandidate[] {
  const watched = new Set(watchedIds);
  return candidates.slice(0, MAX_REPORTED_CANDIDATES).map((candidate) => {
    let state: InternetSearchCandidate['state'];
    if (watched.has(candidate.id)) state = 'watched';
    else if (!announced.has(candidate.id)) state = 'not_reached';
    else state = stillRunning ? 'watching' : 'unwatched';
    return { id: candidate.id, page: loggablePage(candidate.pageUrl), source: sourceOf(candidate), state };
  });
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

function strength(moment: InternetSearchMoment): [number, number] {
  const seconds = moment.marks.reduce((total, mark) => total + (mark.endSeconds - mark.startSeconds), 0);
  return [moment.marks.length, seconds];
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
      const [oneMarks, oneSeconds] = strength(one);
      const [otherMarks, otherSeconds] = strength(other);
      return otherMarks - oneMarks || otherSeconds - oneSeconds;
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
 * four scouts inspect separate quarters of the first ten minutes using sparse
 * one-second bursts, then promising windows are re-watched continuously.
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
    const done: InternetSearchProgress = { phase: 'answered', moments: [], candidatesFound: 0, candidatesWatched: 0, outcome: 'no_candidates', candidates: [] };
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
  const densePaddingSeconds = boundedNumber('VIDEO_STREAM_DENSE_PADDING_SECONDS', 6, 1, 30);
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
    dense_padding_seconds: densePaddingSeconds,
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

  await report({
    phase: 'searching',
    moments: [],
    candidatesFound: candidates.length,
    candidatesWatched: 0,
    candidates: candidateRoll(candidates, new Set(), [], true),
  });

  // Which page each scout went to, recorded as it happens.
  //
  // The swarm is generic over candidates and knows only their ids, so this is
  // the only place that can put a page address next to one. Without it, a
  // search that dies leaves "no video element on the page" and no way to tell
  // which page — which is exactly where the 17 September post-mortem stalled.
  // Once per candidate rather than once per scout: four scouts take a quarter
  // of the same video each, and four identical lines say nothing extra.
  const announced = new Set<string>();
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  // The last thing we knew, kept outside the run so it is still here if the
  // run does not come back.
  let watchedSoFar = 0;
  let momentsSoFar = 0;
  // Kept out here for the same reason as the counts above: if the run does not
  // come back, this is the last true thing we knew about the pages.
  let lastRoll: InternetSearchCandidate[] = candidateRoll(candidates, new Set(), [], true);

  const started = await runScoutSwarm<Candidate>({
    searchId,
    query: job.data.query,
    candidates,
    runtime,
    maxCandidates,
    horizonSeconds,
    coarseBurstSeconds,
    coarseStrideSeconds,
    densePaddingSeconds,
    timeoutMs: realtimeV2 ? 10 * 60_000 : 5 * 60_000,
    onProgress: async (progress) => {
      let firstSightOf = false;
      if (progress.event === 'scout.candidate_assigned' && progress.candidateId && !announced.has(progress.candidateId)) {
        announced.add(progress.candidateId);
        firstSightOf = true;
        const candidate = byId.get(progress.candidateId);
        log.info('watching a page', {
          candidate_id: progress.candidateId,
          page_url: candidate ? loggablePage(candidate.pageUrl) : null,
          source: candidate ? sourceOf(candidate) : null,
          candidates_watched_so_far: progress.snapshot.candidatesWatched,
        });
      }
      // Coverage is reported as it changes, not only at the end. A search that
      // dies is answered from whatever progress last recorded, so a completed
      // candidate that never reaches the summary still counts.
      //
      // Handing a page to a scout counts as a change, and only the first time
      // for each page. `announced` grew in memory but nothing was written
      // down, so a worker killed between the hand-out and the first result
      // left the persisted progress at the opening roll, where every page
      // reads `not_reached`. A page four scouts had open would then be
      // reported to the person as one nobody ever went to — the mirror of the
      // mistake `not_reached` was added to prevent, and in exactly the case
      // this record exists for. Caught by Codex on #155.
      const moved = progress.event === 'moment.found'
        || progress.event === 'moment.extended'
        || progress.event === 'scout.candidate_completed';
      if (!moved && !firstSightOf) return;
      watchedSoFar = progress.snapshot.candidatesWatched;
      momentsSoFar = progress.snapshot.momentsFound;
      lastRoll = candidateRoll(candidates, announced, progress.snapshot.watchedIds, true);
      await report({
        phase: 'searching',
        moments: asMoments(progress.snapshot.moments),
        candidates: lastRoll,
        candidatesFound: candidates.length,
        candidatesWatched: progress.snapshot.candidatesWatched,
      });
    },
  }).catch((error: unknown) => {
    // A search that throws used to take its whole account with it. The summary
    // below never ran, so the 17 September post-mortem had a stack trace, no
    // per-candidate record, and no idea how far the search had got. Whatever
    // was known at the last progress event is written down here before the
    // error carries on to fail the job.
    log.error('internet search stopped part-way', {
      model: videoChat3Adapter.id,
      stream_v2: realtimeV2,
      query_length: job.data.query.length,
      discovery_ms: discoveryMs,
      candidates_discovered: discovered.length,
      candidates_selected: candidates.length,
      candidates_watched: watchedSoFar,
      candidates_announced: [...announced],
      moments_so_far: momentsSoFar,
      wall_ms: Date.now() - searchStartedAt,
      status: 'stopped',
      err: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  });
  const result = started;

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
    // Settled from the inspections rather than the last snapshot, which is the
    // same source `candidatesWatched` is taken from just above, so the roll and
    // the count cannot disagree at the one moment anyone reads them carefully.
    candidates: candidateRoll(candidates, announced, watchedCandidates, false),
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
    dense_padding_seconds: densePaddingSeconds,
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
