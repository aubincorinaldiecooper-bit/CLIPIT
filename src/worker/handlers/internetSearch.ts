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

function asMoment(found: SwarmMoment<Candidate>): InternetSearchMoment {
  return {
    id: found.id,
    description: found.description,
    startSeconds: found.startSeconds,
    endSeconds: found.endSeconds,
    still: null,
    source: sourceOf(found.candidate),
  };
}

/**
 * Internet search now uses the same source/model ports as uploaded footage.
 * SearXNG finds pages, the browser turns a page into timestamped frames, and
 * VideoChat3's online StreamingSession watches those frames with the text query
 * attached from the first round. The scout swarm remains the coordinator.
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
      await report({ phase: 'searching', moments: progress.snapshot.moments.map(asMoment), candidatesFound: candidates.length });
    },
  });

  const moments: InternetSearchMoment[] = result.moments.map(asMoment);

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
    moments: moments.length,
    candidates_considered: result.candidatesConsidered,
    candidates_completed: result.candidatesCompleted,
    partly_examined: result.candidatesPartlyExamined,
    unexamined,
    status: result.status,
    wall_ms: result.metrics.wallMs,
  });
  return done;
}
