import { Queue } from 'bullmq';
import { getQueueConnection } from './connection.js';

export const INTERNET_SEARCH_QUEUE = 'internet-search';

export interface InternetSearchJob {
  query: string;
  sessionId: string | null;
  userId: string | null;
}

/** Somewhere in a video the watcher approved, for jumping to. */
export interface InternetSearchMark {
  startSeconds: number;
  endSeconds: number;
  /** What the watcher said was happening there. */
  description: string;
  /**
   * How sure the watcher said it was, 0 to 1.
   *
   * Absent when it did not say, which is ordinary: it is asked for a number
   * and a model asked for something does not have to give it. Absent is not
   * zero. This is the watcher's opinion of its own reading, not a measure of
   * how often it is right — nothing here has ever been scored against known
   * answers.
   */
  confidence?: number;
}

/**
 * A video the scouts approved, as the screen needs it.
 *
 * The video is the result. A video that answers the question in three places
 * is one card with three places to jump to, not three cards — the same video
 * appearing repeatedly would eat a band that holds five and bury the others.
 * Answering repeatedly makes it a stronger answer, which is how the list is
 * ordered, not a more numerous one.
 *
 * The page travels with it because the card plays it: the person opens the
 * video and jumps to what the watcher called out. Only a video something was
 * actually approved in ever becomes one of these. A page discovery merely
 * turned up has no marks and is not a result.
 */
export interface InternetSearchMoment {
  /** The video's own id, held steady as marks accumulate under it. */
  id: string;
  /** Where the video plays. */
  pageUrl: string;
  /** The video's title, as the site gives it. */
  title: string;
  /** A frame the site already publishes. Null when it publishes none. */
  still: string | null;
  /** The site it came from, for attribution. */
  source: string | null;
  /** Everywhere the watcher approved, earliest first. Never empty. */
  marks: InternetSearchMark[];
  /**
   * The surest the watcher was about anything in this video, 0 to 1.
   *
   * Absent when it said so about none of them. A video is worth opening for
   * its best moment, so the best is what the card carries.
   */
  confidence?: number;
}

/**
 * What the screen is told while a search runs.
 *
 * The three states the results stage draws, and nothing else. `loading` is
 * every search's first state, before it is known whether there is anything to
 * watch; `searching` means pages were found and are being watched, which is
 * what puts the slots up; `answered` means the scouts are done and `moments`
 * is everything they found, which may be none.
 *
 * Moments are carried in full on every update rather than as a delta. A page
 * that polls every couple of seconds and misses one update would otherwise be
 * permanently short a moment, and the list is at most a handful of small rows.
 */
export interface InternetSearchProgress {
  phase: 'loading' | 'searching' | 'answered';
  moments: InternetSearchMoment[];
  /** How many pages the scouts were given. Never shown as results. */
  candidatesFound: number;
  /** Set when the search ended without looking at everything it found. */
  unexamined?: number;
}

export type InternetSearchResult = InternetSearchProgress;

let queue: Queue<InternetSearchJob, InternetSearchResult> | null = null;

export function getInternetSearchQueue(): Queue<InternetSearchJob, InternetSearchResult> {
  if (!queue) {
    queue = new Queue<InternetSearchJob, InternetSearchResult>(INTERNET_SEARCH_QUEUE, {
      connection: getQueueConnection(),
      defaultJobOptions: {
        // Watching pages is expensive and a retry would watch them all again.
        attempts: 1,
        // Long enough to come back to a search from a link or a reload.
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 24 * 3600, count: 1000 },
      },
    });
  }
  return queue;
}

export async function enqueueInternetSearch(id: string, data: InternetSearchJob): Promise<void> {
  await getInternetSearchQueue().add('search', data, { jobId: id });
}

export async function closeInternetSearchQueue(): Promise<void> {
  if (!queue) return;
  await queue.close();
  queue = null;
}
