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

function sourceOf(candidate: Candidate): string | null {
  if (candidate.source) return candidate.source;
  try { return new URL(candidate.pageUrl).host.replace(/^www\./, ''); } catch { return null; }
}

/**
 * The approved stretches of one video, gathered into the card that plays it.
 *
 * The card keeps the video's own id rather than a running number, so a video
 * that goes on being approved stays the same card on screen: it gains places
 * to jump to and may move up the band, but it never turns into a different
 * card or a second copy of itself.
 */
function asMoment(candidate: Candidate, found: SwarmMoment<Candidate>[]): InternetSearchMoment {
  return {
    id: candidate.id,
    pageUrl: candidate.pageUrl,
    title: candidate.title,
    still: candidate.thumbnailUrl,
    source: sourceOf(candidate),
    marks: found
      .map((moment) => ({ startSeconds: moment.startSeconds, endSeconds: moment.endSeconds, description: moment.description }))
      .sort((one, other) => one.startSeconds - other.startSeconds),
  };
}

/**
 * How many approvals a video has, and how much footage they cover.
 *
 * A video the watcher approved in three separate places answers the question
 * more strongly than one it approved once, so the count leads. Total approved
 * footage settles ties between videos approved the same number of times.
 */
function strength(moment: InternetSearchMoment): [number, number] {
  const seconds = moment.marks.reduce((total, mark) => total + (mark.endSeconds - mark.startSeconds), 0);
  return [moment.marks.length, seconds];
}

/**
 * Every approved video, strongest first.
 *
 * Grouped by the video rather than by the finding, because the video is the
 * result. Sorting is stable and the grouping keeps the order the scouts found
 * them in, so videos of equal strength hold their places instead of swapping
 * between one report and the next.
 */
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
 * Internet search now uses the same source/model ports as uploaded footage.
 * SearXNG finds pages, the browser turns a page into timestamped frames, and
 * VideoChat3's online StreamingSession watches those frames with the text query
 * attached from the first round. The scout swarm remains the coordinator.
 *
 * What comes back is videos, not findings. Each approved video is one card
 * carrying the places inside it worth jumping to, ordered by how often the
 * watcher approved it.
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
  const runtime = createVideoModelScoutRuntime<Candidate>({
    model: videoChat3Adapter,
    sourceForCandidate: (candidate) => createWebFrameStreamSource({
      id: `${searchId}:${candidate.id}`,
      pageUrl: candidate.pageUrl,
      webAccessUrl,
      webAccessToken,
      maxSeconds: 90,
      fps: 1,
    }),
  });

  await report({ phase: 'searching', moments: [], candidatesFound: candidates.length });
  const result = await runScoutSwarm<Candidate>({
    searchId,
    query: job.data.query,
    candidates,
    runtime,
    onProgress: async (progress) => {
      // A moment that grew is the same card with a longer stretch, not another
      // one. Sending the swarm's whole list on either event means the screen
      // shows what it currently holds, rather than a tally kept alongside it
      // that has no way to take something back.
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
