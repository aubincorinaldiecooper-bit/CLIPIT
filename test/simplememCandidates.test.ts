import { describe, expect, it } from 'vitest';
import {
  decideFallback,
  mapCandidates,
  type SimpleMemItem,
} from '../src/services/retrieval/simplemem/candidates.js';

/**
 * SimpleMem answers with memories, not moments. This is the layer that turns
 * one into the other, and the two things it must never do are invent a place
 * on the timeline and drop something without saying so. Both are checked here
 * because both would look like a working search from the outside.
 */

const options = { fps: 1, groupGapSeconds: 5, minScore: 0, durationSeconds: 90 };

function frame(seconds: number, score: number, summary = 'a frame'): SimpleMemItem {
  return { mauId: `m${seconds}`, modality: 'visual', score, summary, frameIndex: seconds, seconds };
}

describe('mapCandidates', () => {
  it('folds neighbouring frames into one moment and keeps the best frame’s caption', () => {
    const { candidates } = mapCandidates(
      [frame(10, 0.4, 'the wide shot'), frame(12, 0.8, 'the sign'), frame(14, 0.5, 'the wide shot again')],
      options,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].frames).toBe(3);
    expect(candidates[0].score).toBeCloseTo(0.8);
    expect(candidates[0].description).toBe('the sign');
    expect(candidates[0].mauIds).toEqual(['m10', 'm12', 'm14']);
  });

  it('splits frames further apart than the gap into separate moments', () => {
    const { candidates } = mapCandidates([frame(10, 0.7), frame(40, 0.6)], options);

    expect(candidates).toHaveLength(2);
    expect(candidates[0].startSeconds).toBeCloseTo(10);
    expect(candidates[1].startSeconds).toBeCloseTo(40);
  });

  it('never lets a moment run past the end of the video', () => {
    const { candidates } = mapCandidates([frame(89, 0.9)], { ...options, fps: 0.25 });

    expect(candidates[0].endSeconds).toBeLessThanOrEqual(90);
  });

  it('counts what it could not use instead of dropping it silently', () => {
    const items: SimpleMemItem[] = [
      { mauId: 'summary', modality: 'video', score: 0.9, summary: 'the whole video', frameIndex: null, seconds: null },
      { mauId: 'speech', modality: 'audio', score: 0.8, summary: 'the transcript', frameIndex: null, seconds: null },
      { mauId: 'untimed', modality: 'visual', score: 0.7, summary: 'a frame', frameIndex: 3, seconds: null },
      frame(20, 0.1),
    ];

    const { candidates, ignored } = mapCandidates(items, { ...options, minScore: 0.5 });

    expect(candidates).toHaveLength(0);
    expect(ignored.notAFrame).toBe(2);
    expect(ignored.noTimestamp).toBe(1);
    expect(ignored.belowScore).toBe(1);
  });
});

describe('decideFallback', () => {
  const ready = { indexState: 'ready', mode: 'visual', correcting: false } as const;
  const empty = { candidates: [], ignored: { notAFrame: 0, noTimestamp: 0, belowScore: 0 } };

  it('sends a correction to the footage whatever SimpleMem holds', () => {
    const decision = decideFallback({
      ...ready,
      correcting: true,
      mapping: { ...empty, candidates: [{ startSeconds: 1, endSeconds: 2, score: 0.9, description: 'x', mauIds: ['a'], frames: 1 }] },
    });

    expect(decision).toEqual({ use: 'fallback', reason: 'correction', detail: expect.any(String) });
  });

  it.each([
    ['missing', 'index_missing'],
    ['queued', 'index_not_ready'],
    ['running', 'index_not_ready'],
    ['failed', 'index_unavailable'],
    ['unavailable', 'index_unavailable'],
  ] as const)('falls back with its own reason when the index is %s', (indexState, reason) => {
    const decision = decideFallback({ ...ready, indexState, mapping: empty });

    expect(decision).toMatchObject({ use: 'fallback', reason });
  });

  it('sends speech questions to the fallback, because SimpleMem’s transcript has no times', () => {
    expect(decideFallback({ ...ready, mode: 'transcript', mapping: empty })).toMatchObject({
      use: 'fallback',
      reason: 'unsupported_mode',
    });
  });

  it('uses SimpleMem when it produced a moment', () => {
    const decision = decideFallback({
      ...ready,
      mapping: { ...empty, candidates: [{ startSeconds: 10, endSeconds: 12, score: 0.7, description: 'x', mauIds: ['a'], frames: 1 }] },
    });

    expect(decision).toEqual({ use: 'primary' });
  });

  it('separates “everything scored too low” from “nothing came back”', () => {
    expect(
      decideFallback({ ...ready, mapping: { ...empty, ignored: { notAFrame: 0, noTimestamp: 0, belowScore: 4 } } }),
    ).toMatchObject({ use: 'fallback', reason: 'below_score' });

    expect(decideFallback({ ...ready, mapping: empty })).toMatchObject({
      use: 'fallback',
      reason: 'no_candidates',
    });
  });

  it('never reports an absence: an empty answer is a fallback, not “no such moment”', () => {
    const decision = decideFallback({ ...ready, mapping: empty });

    expect(decision.use).toBe('fallback');
  });

  it('falls back when the sidecar could not be asked at all', () => {
    expect(decideFallback({ ...ready, error: 'connection refused' })).toMatchObject({
      use: 'fallback',
      reason: 'primary_failed',
    });
  });
});
