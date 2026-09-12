import { Queue } from 'bullmq';
import { getQueueConnection } from './connection.js';
import type { InternetVideoSearchResult } from '../services/retrieval/internetSearch.js';

export const INTERNET_VIDEO_SEARCH_QUEUE = 'internet-video-search';

export interface InternetVideoSearchJob {
  query: string;
  sessionId: string | null;
  userId: string | null;
}

let queue: Queue<InternetVideoSearchJob, InternetVideoSearchResult> | null = null;

export function getInternetVideoSearchQueue(): Queue<InternetVideoSearchJob, InternetVideoSearchResult> {
  if (!queue) {
    queue = new Queue<InternetVideoSearchJob, InternetVideoSearchResult>(INTERNET_VIDEO_SEARCH_QUEUE, {
      connection: getQueueConnection(),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600, count: 1000 },
      },
    });
  }
  return queue;
}

export async function enqueueInternetVideoSearch(
  id: string,
  data: InternetVideoSearchJob,
): Promise<void> {
  await getInternetVideoSearchQueue().add('search', data, { jobId: id });
}

export async function closeInternetVideoSearchQueue(): Promise<void> {
  if (!queue) return;
  await queue.close();
  queue = null;
}
