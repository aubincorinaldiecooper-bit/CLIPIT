import type { Job } from 'bullmq';
import { logger } from '../../lib/logger.js';
import type { InternetSearchJob, InternetSearchMoment, InternetSearchProgress } from '../../queues/internetSearch.js';
import { search, type Candidate } from '../../services/discovery/searxng.js';
import { runScoutSwarm, type SwarmMoment } from '../../services/retrieval/scoutSwarm.js';
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

/**
 * V2 is feature-gated while we compare it with the original one-fps path.
 * Capture begins modestly at six fps; VideoChat3 groups those pictures into
 * temporal rounds instead of making six language-model decisions per second.
 */
export async function handleInternetSearch(job: Job<InternetSearchJob>): Promise<InternetSearchProgress> {
  const searchId = job.id ?? 'unknown';
  const log = logger.child({ search_id: searchId, component: 'internet_search' });
  const report = async (progress: InternetSearchProgress) => job.updateProgress(progress as unknown as Record<string, unknown>);

  await report({ phase: 'loading', moments: [], candidatesFound: 0 });
  const candidates = await search(job.data.query);
  if (candidates.length === 0) {
    const done: InternetSearchProgress = { phase: 'answered', moments: [], candidatesFound: 0 };
    await report(done);
    return done;
  }

  const webAccessUrl = required('WEB_ACCESS_URL');
  const webAccessToken = required('WEB_ACCESS_INTERNAL_TOKEN');
  const realtimeV2 = enabled('VIDEO_STREAM_V2');
  const captureFps = realtimeV2 ? boundedNumber('VIDEO_STREAM_CAPTURE_FPS', 6, 0.2, 30) : 1;
  // Whole-video coarse navigation is the next retrieval change. Keep this
  // first perception experiment on the existing time budget so recall, lag,
  // and GPU cost can be compared without moving two variables at once.
  const maxSeconds = boundedNumber('INTERNET_WATCH_MAX_SECONDS', 90, 1, 600);

  const runtime = createVideoModelScoutRuntime<Candidate>({
    model: videoChat3Adapter,
    sourceForCandidate: (candidate) => createWebFrameStreamSource({
      id: `${searchId}:${candidate.id}`,
      pageUrl: candidate.pageUrl,
      webAccessUrl,
      webAccessToken,
      maxSeconds,
      fps: captureFps,
      realtimeV2,
    }),
  });

  await report({ phase: 'searching', moments: [], candidatesFound: candidates.length });
  const result = await runScoutSwarm<Candidate>({
    searchId,
    query: job.data.query,
    candidates,
    runtime,
    onProgress: async (progress) => {
      if (progress.event !== 'moment.found' && progress.event !== 'moment.extended') return;
      await report({ phase: 'searching', moments: asMoments(progress.snapshot.moments), candidatesFound: candidates.length });
    },
  });

  const moments: InternetSearchMoment[] = asMoments(result.moments);
  const neverReached = Math.max(0, result.candidatesAvailable - result.candidatesConsidered);
  const notStarted = Math.max(0, result.candidatesConsidered - result.candidatesCompleted);
  const unexamined = result.failures.length + result.candidatesPartlyExamined + neverReached + notStarted;
  const done: InternetSearchProgress = {
    phase: 'answered',
    moments,
    candidatesFound: candidates.length,
    ...(unexamined > 0 ? { unexamined } : {}),
  };
  await report(done);

  log.info('internet search finished', {
    model: videoChat3Adapter.id,
    stream_v2: realtimeV2,
    capture_fps: captureFps,
    videos: moments.length,
    marks: moments.reduce((total, moment) => total + moment.marks.length, 0),
    candidates_considered: result.candidatesConsidered,
    candidates_completed: result.candidatesCompleted,
    partly_examined: result.candidatesPartlyExamined,
    unexamined,
    status: result.status,
    wall_ms: result.metrics.wallMs,
  });
  return done;
}
