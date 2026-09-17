import { describe, expect, it } from 'vitest';
import { classifyFailure, decideEnding, endingForStoppedSearch, meansNothingMatched } from '../src/services/retrieval/internetSearchOutcome.js';

/** The exact string production logged on 17 September, 28 times over. */
const DEPLOYED_WITHOUT_THE_METHOD =
  "Modal cannot find clipit-videochat3/VideoChat3Service in main (Method 'watch_stream' not found on class)";

function coverage(over: Partial<Parameters<typeof decideEnding>[0]> = {}) {
  return { candidatesFound: 0, candidatesWatched: 0, candidatesFullyWatched: 0, momentsFound: 0, failureReasons: [], ...over };
}

describe('deciding how an internet search ended', () => {
  it('calls it nothing-to-watch when discovery came back empty', () => {
    const ending = decideEnding(coverage());
    expect(ending).toEqual({ phase: 'answered', outcome: 'no_candidates', candidatesWatched: 0 });
    expect(meansNothingMatched(ending)).toBe(true);
  });

  it('refuses to say nothing matched when not one video was watched', () => {
    const ending = decideEnding(coverage({
      candidatesFound: 7,
      candidatesWatched: 0,
      momentsFound: 0,
      failureReasons: Array.from({ length: 28 }, () => DEPLOYED_WITHOUT_THE_METHOD),
    }));
    expect(ending.outcome).toBe('watch_failed');
    expect(ending.phase).toBe('failed');
    expect(meansNothingMatched(ending)).toBe(false);
    expect(ending.failure).toEqual({ kind: 'video_model_unavailable', count: 28 });
  });

  it('says nothing matched only when every video found was watched through', () => {
    const ending = decideEnding(coverage({ candidatesFound: 4, candidatesWatched: 4, candidatesFullyWatched: 4, momentsFound: 0 }));
    expect(ending.outcome).toBe('no_matches');
    expect(ending.phase).toBe('answered');
    expect(meansNothingMatched(ending)).toBe(true);
  });

  it('will not call a half-watched empty search an empty answer', () => {
    const ending = decideEnding(coverage({
      candidatesFound: 7,
      candidatesWatched: 3,
      candidatesFullyWatched: 3,
      momentsFound: 0,
      failureReasons: ['the browser refused to watch this page (503)'],
    }));
    expect(ending.outcome).toBe('partly_watched');
    expect(ending.phase).toBe('answered');
    expect(meansNothingMatched(ending)).toBe(false);
    expect(ending.failure).toEqual({ kind: 'browser_unavailable', count: 1 });
  });

  it('keeps a half-watched search partial even when it did find something', () => {
    const ending = decideEnding(coverage({
      candidatesFound: 7,
      candidatesWatched: 5,
      candidatesFullyWatched: 5,
      momentsFound: 2,
      failureReasons: ['the browser refused to watch this page (503)', 'the browser refused to watch this page (503)'],
    }));
    expect(ending.outcome).toBe('partly_watched');
    expect(ending.candidatesWatched).toBe(5);
    expect(ending.failure?.count).toBe(2);
  });

  it('will not say nothing matched when a quarter of the one video was never opened', () => {
    // One video, four scouts, three ranges read and one failed. The video was
    // watched. It was not watched through, and that is a different sentence.
    const ending = decideEnding(coverage({
      candidatesFound: 1,
      candidatesWatched: 1,
      candidatesFullyWatched: 0,
      momentsFound: 0,
      failureReasons: ['the browser refused to watch this page (503)'],
    }));
    expect(ending.outcome).toBe('partly_watched');
    expect(meansNothingMatched(ending)).toBe(false);
  });

  it('calls it a match only when everything was watched and something was found', () => {
    const ending = decideEnding(coverage({ candidatesFound: 3, candidatesWatched: 3, candidatesFullyWatched: 3, momentsFound: 1 }));
    expect(ending).toEqual({ phase: 'answered', outcome: 'matched', candidatesWatched: 3 });
  });

  it('attaches nothing to a clean run', () => {
    expect(decideEnding(coverage({ candidatesFound: 2, candidatesWatched: 2, candidatesFullyWatched: 2, momentsFound: 0 })).failure).toBeUndefined();
  });

  it('never reports more watched than were found', () => {
    expect(decideEnding(coverage({ candidatesFound: 2, candidatesWatched: 9, candidatesFullyWatched: 9, momentsFound: 1 })).candidatesWatched).toBe(2);
  });
});

describe('naming what went wrong, coarsely', () => {
  it('knows a deployment that does not offer what we called', () => {
    expect(classifyFailure(DEPLOYED_WITHOUT_THE_METHOD)).toBe('video_model_unavailable');
  });

  it('knows missing credentials and missing configuration from a broken watch', () => {
    expect(classifyFailure("Modal rejected Clipit's credentials (unauthenticated)")).toBe('video_model_unavailable');
    expect(classifyFailure('videochat3-watch-stream is not configured')).toBe('video_model_unavailable');
    expect(classifyFailure('watch_stream failed remotely: CUDA out of memory')).toBe('video_model_failed');
  });

  it('knows a page that would not open', () => {
    expect(classifyFailure('the browser refused to watch this page (503)')).toBe('browser_unavailable');
    expect(classifyFailure('the video never started playing')).toBe('browser_unavailable');
  });

  it('knows running out of time', () => {
    expect(classifyFailure('watch_stream exceeded the 600s client deadline')).toBe('timed_out');
    expect(classifyFailure('watch_stream exceeded its Modal timeout: 1800s')).toBe('timed_out');
  });

  it('says unknown rather than guessing', () => {
    expect(classifyFailure('something nobody has written a pattern for')).toBe('unknown');
  });

  it('reports the commonest kind, and the total count across all of them', () => {
    const ending = decideEnding(coverage({
      candidatesFound: 3,
      candidatesWatched: 0,
      failureReasons: [
        'the browser refused to watch this page (503)',
        'the browser refused to watch this page (502)',
        'watch_stream exceeded the 600s client deadline',
      ],
    }));
    expect(ending.failure).toEqual({ kind: 'browser_unavailable', count: 3 });
  });
});

/**
 * A search that stopped rather than ended.
 *
 * On 17 September one candidate page with no video in it killed the worker,
 * the job was re-run and killed it again, and the person was shown BullMQ's
 * own words: "job stalled more than allowable limit". Nothing about that
 * sentence is for a human, and nothing about the search that produced it is
 * an answer about the videos.
 */
describe('a search that was cut off before it could decide anything', () => {
  const nothing = { moments: [], candidatesFound: 0 };
  const moment = (id: string): never =>
    ({ id, pageUrl: `https://publisher.example/${id}`, title: id, still: null, source: null, marks: [] }) as never;

  it('never lets an empty result be read as an answer about the videos', () => {
    const done = endingForStoppedSearch({ moments: [], candidatesFound: 7 }, 'job stalled more than allowable limit');
    expect(done.phase).toBe('failed');
    expect(done.outcome).toBe('search_failed');
    expect(meansNothingMatched(done)).toBe(false);
  });

  it('keeps what was actually approved before it died', () => {
    // Those moments were verified footage. They are still true — they are
    // just not the whole answer, which is what `search_failed` says.
    const done = endingForStoppedSearch(
      { moments: [moment('a'), moment('b')], candidatesFound: 7, candidatesWatched: 3 },
      'job stalled more than allowable limit',
    );
    expect(done.moments).toHaveLength(2);
    expect(done.candidatesFound).toBe(7);
    expect(done.candidatesWatched).toBe(3);
  });

  it('does not repeat the internal wording to the person', () => {
    const done = endingForStoppedSearch(nothing, 'job stalled more than allowable limit');
    expect(JSON.stringify(done)).not.toContain('stalled');
    expect(JSON.stringify(done)).not.toContain('allowable');
    expect(done.failure).toEqual({ kind: 'unknown', count: 1 });
  });

  it('still names the cause when the reason says what it was', () => {
    const modal = endingForStoppedSearch(nothing, "Modal cannot find clipit-videochat3/VideoChat3Service in main (Method 'watch_stream' not found on class)");
    expect(modal.failure?.kind).toBe('video_model_unavailable');
    const browser = endingForStoppedSearch(nothing, 'the browser refused to watch this page (503)');
    expect(browser.failure?.kind).toBe('browser_unavailable');
  });

  it('leaves out a watched count it was never told', () => {
    expect('candidatesWatched' in endingForStoppedSearch(nothing, 'anything')).toBe(false);
  });
});
