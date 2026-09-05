import { describe, expect, it } from 'vitest';
import {
  acceptsQuestions,
  isBeingPrepared,
  preparationWait,
  questionAcceptance,
} from '../src/services/search/readiness.js';

/**
 * A question may be sent once there is a video to ask about; the answer
 * waits for what it needs. The observed session put a minute between
 * "uploaded" and the send button lighting up, all of it downstream work the
 * question did not have to wait to be SENT for.
 */

describe('questionAcceptance — when a question may be sent', () => {
  it('accepts a question from the moment the bytes have landed, through every preparation stage', () => {
    for (const status of ['queued', 'ingesting', 'preprocessing', 'ready'] as const) {
      expect(questionAcceptance(status)).toBe('accept');
      expect(acceptsQuestions(status)).toBe(true);
    }
  });

  it('refuses while nothing has been uploaded — there is no video to ask about', () => {
    expect(questionAcceptance('pending_upload')).toBe('uploading');
    expect(acceptsQuestions('pending_upload')).toBe(false);
  });

  it('refuses a video that failed, so the person is told why rather than parked', () => {
    expect(questionAcceptance('failed')).toBe('failed');
    expect(acceptsQuestions('failed')).toBe(false);
  });
});

describe('preparationWait — what the answer waits for', () => {
  it('parks the question while the video is still being prepared', () => {
    for (const status of ['pending_upload', 'queued', 'ingesting', 'preprocessing'] as const) {
      expect(isBeingPrepared(status)).toBe(true);
      expect(preparationWait(status, 0, 60_000)).toBe('wait');
      expect(preparationWait(status, 59_999, 60_000)).toBe('wait');
    }
  });

  it('carries on the moment the video is prepared', () => {
    expect(preparationWait('ready', 0, 60_000)).toBe('proceed');
  });

  it('carries on for a failed video too — the caller reports the failure', () => {
    expect(preparationWait('failed', 0, 60_000)).toBe('proceed');
  });

  it('gives up after the allowance rather than parking a question for good', () => {
    expect(preparationWait('preprocessing', 60_000, 60_000)).toBe('timed_out');
  });
});
