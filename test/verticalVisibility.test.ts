import { describe, expect, it } from 'vitest';
import {
  candidateTargetFor,
  isCreatorVisible,
  isRetryableFailure,
  selectCreatorVisible,
  shouldRetry,
  suppressedByPipeline,
  type VerticalCandidate,
} from '../src/services/media/verticalVisibility.js';

/**
 * Two audiences, two truths. The creator sees finished moments; we see
 * everything that failed making them. These tests hold the line between them
 * — especially the one that would be most tempting to cross, handing back a
 * landscape clip when the 9:16 file never arrived.
 */

const candidate = (over: Partial<VerticalCandidate> = {}): VerticalCandidate => ({
  matchId: 'm1',
  derivativeStatus: 'ready',
  derivativeStorageKey: 'clips/v1/c1-vertical.mp4',
  posterStorageKey: 'posters/v1/c1.jpg',
  confidence: 0.9,
  ...over,
});

describe('isCreatorVisible — finished, and actually finished', () => {
  it('shows a ready candidate that really has its files', () => {
    expect(isCreatorVisible(candidate())).toBe(true);
  });

  it('withholds a derivative still being made', () => {
    expect(isCreatorVisible(candidate({ derivativeStatus: 'pending', derivativeStorageKey: null }))).toBe(false);
  });

  it('withholds a derivative that failed for good', () => {
    expect(isCreatorVisible(candidate({ derivativeStatus: 'failed', derivativeStorageKey: null }))).toBe(false);
  });

  it('trusts the FILE over the label: ready with no derivative is not ready', () => {
    // A row marked ready with nothing behind it is a bug upstream. Believing
    // the label would put a card on screen that plays nothing.
    expect(isCreatorVisible(candidate({ derivativeStorageKey: null }))).toBe(false);
  });

  it('requires the poster too — a post-ready card with no still is not post-ready', () => {
    expect(isCreatorVisible(candidate({ posterStorageKey: null }))).toBe(false);
  });
});

describe('selectCreatorVisible — a failure must not cost a result', () => {
  it('fills the requested count from ready candidates, best first', () => {
    const { visible } = selectCreatorVisible(
      [
        candidate({ matchId: 'a', confidence: 0.5 }),
        candidate({ matchId: 'b', confidence: 0.9 }),
        candidate({ matchId: 'c', confidence: 0.7 }),
      ],
      2,
    );
    expect(visible.map((c) => c.matchId)).toEqual(['b', 'c']);
  });

  it("the brief's own example: 5 candidates, one failed, 3 returned", () => {
    const { visible, withheld } = selectCreatorVisible(
      [
        candidate({ matchId: '1', confidence: 0.95 }),
        candidate({ matchId: '2', confidence: 0.9, derivativeStatus: 'failed', derivativeStorageKey: null }),
        candidate({ matchId: '3', confidence: 0.85 }),
        candidate({ matchId: '4', confidence: 0.8 }),
        candidate({ matchId: '5', confidence: 0.75 }),
      ],
      3,
    );
    expect(visible.map((c) => c.matchId)).toEqual(['1', '3', '4']);
    // The failed one is withheld, and the spare ready one simply was not needed.
    expect(withheld.map((c) => c.matchId).sort()).toEqual(['2', '5']);
  });

  it('a permanently failed candidate never consumes one of the requested slots', () => {
    const { visible } = selectCreatorVisible(
      [
        candidate({ matchId: 'bad', confidence: 0.99, derivativeStatus: 'failed', derivativeStorageKey: null }),
        candidate({ matchId: 'good', confidence: 0.4 }),
      ],
      1,
    );
    // Despite ranking highest, the failure is not the answer.
    expect(visible.map((c) => c.matchId)).toEqual(['good']);
  });

  it('returns fewer rather than padding when not enough finished', () => {
    const { visible } = selectCreatorVisible(
      [candidate({ matchId: 'only' }), candidate({ matchId: 'x', derivativeStatus: 'pending', derivativeStorageKey: null })],
      3,
    );
    // Two short is honest. Substituting anything to reach three is not.
    expect(visible).toHaveLength(1);
  });

  it('NEVER substitutes a landscape canonical clip for a failed derivative', () => {
    const failed = candidate({ matchId: 'f', derivativeStatus: 'failed', derivativeStorageKey: null });
    const { visible } = selectCreatorVisible([failed], 1);
    expect(visible).toEqual([]);
    // The canonical clip existing changes nothing: the creator asked for
    // something postable to TikTok, and a 16:9 file is not that.
    const withCanonical = { ...failed, canonicalUrl: 'clips/v1/c1.mp4' } as VerticalCandidate;
    expect(isCreatorVisible(withCanonical)).toBe(false);
  });
});

describe('suppressedByPipeline — the quality number', () => {
  it('counts only what the pipeline failed to finish, not what was surplus', () => {
    const { withheld } = selectCreatorVisible(
      [
        candidate({ matchId: 'ok1', confidence: 0.9 }),
        candidate({ matchId: 'broke', confidence: 0.8, derivativeStatus: 'failed', derivativeStorageKey: null }),
        candidate({ matchId: 'spare', confidence: 0.7 }),
      ],
      1,
    );
    // 'spare' finished fine and simply was not needed — counting it as a
    // suppression would make the pipeline look worse than it is.
    expect(suppressedByPipeline(withheld).map((c) => c.matchId)).toEqual(['broke']);
  });
});

describe('candidateTargetFor — over-select, but bounded', () => {
  it('prepares more than asked so one failure is absorbed', () => {
    expect(candidateTargetFor(3, 1.7, 12)).toBe(6);
  });

  it('never prepares fewer than requested', () => {
    expect(candidateTargetFor(4, 0.5, 12)).toBe(4);
  });

  it('caps the overfetch — every extra candidate is a real GPU call and encode', () => {
    expect(candidateTargetFor(10, 2, 12)).toBe(12);
  });

  it('asks for nothing when nothing was requested', () => {
    expect(candidateTargetFor(0, 2, 12)).toBe(0);
  });
});

describe('retry policy — automatic, bounded, and only where it could differ', () => {
  it('retries transport and render failures, which might genuinely differ', () => {
    expect(isRetryableFailure('storage_upload')).toBe(true);
    expect(isRetryableFailure('composition_decision')).toBe(true);
    expect(isRetryableFailure('smart_crop_render')).toBe(true);
    expect(isRetryableFailure('blurred_background_render')).toBe(true);
    expect(isRetryableFailure('poster_generation')).toBe(true);
  });

  it('does not retry what will fail identically', () => {
    // The same malformed answer re-parses the same way; an unreadable file
    // stays unreadable; serialization failing is our bug, and retrying hides it.
    expect(isRetryableFailure('composition_validation')).toBe(false);
    expect(isRetryableFailure('media_probe')).toBe(false);
    expect(isRetryableFailure('serialization')).toBe(false);
  });

  it('stops at the bound — no infinite loop, no creator action needed', () => {
    expect(shouldRetry('storage_upload', 1, 2)).toBe(true);
    expect(shouldRetry('storage_upload', 2, 2)).toBe(false);
    expect(shouldRetry('storage_upload', 9, 2)).toBe(false);
  });

  it('a recovered retry is what turns a failed attempt into a shown moment', () => {
    // Attempt 1 failed transiently and was retryable; attempt 2 produced the
    // files, and the candidate is now visible on exactly the same rules.
    expect(shouldRetry('storage_upload', 1, 2)).toBe(true);
    expect(isCreatorVisible(candidate())).toBe(true);
  });
});
