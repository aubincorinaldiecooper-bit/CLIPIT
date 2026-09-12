import type { Job } from 'bullmq';
import type { InternetVideoSearchJob } from '../../queues/internetVideoSearch.js';
import { searchInternetVideos } from '../../services/retrieval/internetSearch.js';

export async function handleInternetVideoSearch(job: Job<InternetVideoSearchJob>) {
  await job.updateProgress({ stage: 'searching', message: 'Searching video across the web…' });
  const result = await searchInternetVideos(job.data.query);
  await job.updateProgress({
    stage: 'complete',
    message: `Watched ${result.watched} of ${result.playable} playable candidates`,
    discovered: result.discovered,
    playable: result.playable,
    watched: result.watched,
    sourcesWithEvidence: result.evidence.length,
  });
  return result;
}
