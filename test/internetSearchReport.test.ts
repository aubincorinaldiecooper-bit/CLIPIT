import { describe, expect, it } from 'vitest';
import { reportFor } from '../src/api/routes/internetSearch.js';

const loading = { phase: 'loading', moments: [], candidatesFound: 0 };
const searching = { phase: 'searching', moments: [], candidatesFound: 3 };
const answered = { phase: 'answered', moments: [], candidatesFound: 3 };

describe('what a search tells the screen', () => {
  it('says it is still starting while it sits in the queue', () => {
    // BullMQ starts progress at the number 0, not null. Read as a report, it
    // would answer with no phase — and the screen reads a reply with no phase
    // as a search that finished and found nothing.
    expect(reportFor(0, undefined)).toEqual(loading);
  });

  it('is not fooled by anything else that is not a report', () => {
    for (const notAReport of [null, undefined, '', 'queued', 42, [], {}, { moments: [] }]) {
      expect(reportFor(notAReport, undefined)).toEqual(loading);
    }
  });

  it('passes on what the worker last reported', () => {
    expect(reportFor(searching, undefined)).toEqual(searching);
  });

  it('prefers the finished answer over the last report', () => {
    expect(reportFor(searching, answered)).toEqual(answered);
  });
});
