import type { Job } from 'bullmq';
import { logger } from '../../lib/logger.js';
import type { InternetSearchJob, InternetSearchMoment, InternetSearchProgress } from '../../queues/internetSearch.js';
import { search, type Candidate } from '../../services/discovery/searxng.js';
import { createGanderScoutRuntime } from '../../services/retrieval/ganderScoutRuntime.js';
import { runScoutSwarm, type SwarmMoment } from '../../services/retrieval/scoutSwarm.js';
import { ThinkerSlot } from '../../services/scout/ganderSlot.js';

/**
 * One internet search, from a question to the moments that answer it.
 *
 * SearXNG says which pages might be worth watching. Four scouts share one
 * Gander and watch them. Every moment a scout finds is reported the instant
 * it is found, so the screen fills as the search runs rather than all at once
 * at the end — which is the whole reason this is a job with progress rather
 * than a request that answers.
 *
 * The pages themselves never leave here. They are where to look, not what was
 * found, and the screen is never given them.
 */

/** The one model, shared by every scout in this worker. */
const slot = new ThinkerSlot();

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required to watch pages`);
  return value.replace(/\/$/, '');
}

/** Where a moment came from, for the line under the card. */
function sourceOf(candidate: Candidate): string | null {
  if (candidate.source) return candidate.source;
  try {
    return new URL(candidate.pageUrl).host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function asMoment(found: SwarmMoment<Candidate>): InternetSearchMoment {
  return {
    id: found.id,
    description: found.description,
    startSeconds: found.startSeconds,
    endSeconds: found.endSeconds,
    // Nothing takes a frame from the moment yet, so there is no picture to
    // show. The card says so by showing the words instead of inventing one.
    still: null,
    source: sourceOf(found.candidate),
  };
}

export async function handleInternetSearch(job: Job<InternetSearchJob>): Promise<InternetSearchProgress> {
  const searchId = job.id ?? 'unknown';
  const log = logger.child({ search_id: searchId, component: 'internet_search' });

  const report = async (progress: InternetSearchProgress) => {
    await job.updateProgress(progress as unknown as Record<string, unknown>);
  };

  // Every search starts here, whatever it is about to find. The screen shows
  // the question and nothing else until there is something to watch.
  await report({ phase: 'loading', moments: [], candidatesFound: 0 });

  const candidates = await search(job.data.query);
  if (candidates.length === 0) {
    // The provider looked and came back with nothing. There is nothing to
    // watch, so the search is over and the answer is that it found nothing.
    const done: InternetSearchProgress = { phase: 'answered', moments: [], candidatesFound: 0 };
    await report(done);
    return done;
  }

  const runtime = createGanderScoutRuntime({
    webAccessUrl: required('WEB_ACCESS_URL'),
    webAccessToken: required('WEB_ACCESS_INTERNAL_TOKEN'),
    ganderUrl: required('GANDER_URL'),
    ganderApiKey: required('GANDER_API_KEY'),
    slot,
  });

  // Pages were found and are about to be watched: the slots go up now.
  await report({ phase: 'searching', moments: [], candidatesFound: candidates.length });

  const moments: InternetSearchMoment[] = [];
  const result = await runScoutSwarm<Candidate>({
    searchId,
    query: job.data.query,
    candidates,
    runtime,
    onProgress: async (progress) => {
      if (progress.event !== 'moment.found') return;
      const found = progress.snapshot.moments.at(-1);
      if (!found) return;
      moments.push(asMoment(found));
      // Reported the instant it is found, not collected for the end.
      await report({ phase: 'searching', moments: [...moments], candidatesFound: candidates.length });
    },
  });

  /*
   * Everything the search did not get a proper look at.
   *
   * Four ways a page ends up here, and none of them is "nothing was there":
   * a scout could not watch it at all; it was still playing when the watch
   * limit came; its inspection was cut short when the search was cancelled or
   * ran out of time; or it was never reached, because discovery found more
   * pages than the coordinator's ceiling allows.
   *
   * Counting only the first would let an incomplete search report itself as a
   * complete one that found nothing, which is the one thing this whole path
   * is built not to do.
   */
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
