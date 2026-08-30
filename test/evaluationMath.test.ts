import { describe, expect, it } from 'vitest';
import {
  boundaryErrors,
  classifyClipState,
  costPerSourceHour,
  percentile,
  summariseBoundaryErrors,
} from '../src/services/evaluation.js';

/**
 * The arithmetic the evaluation layer stands on. Every number the owner
 * reads — MAE, median, P90, within-±Ns, cost per source hour — reduces to
 * these functions, so each rule is pinned where getting it quietly wrong
 * would misreport the product: signs carry direction, absent data is null
 * rather than zero, and a rate over no footage is no number at all.
 */

describe('boundaryErrors', () => {
  it('signs the error as final minus predicted, per boundary', () => {
    const error = boundaryErrors({
      predictedStartSeconds: 10,
      predictedEndSeconds: 30,
      finalStartSeconds: 7.6,
      finalEndSeconds: 33,
    });
    // Moved the start 2.4s EARLIER: negative. Extended the end 3s: positive.
    expect(error.startErrorSeconds).toBe(-2.4);
    expect(error.endErrorSeconds).toBe(3);
    expect(error.absoluteStartErrorSeconds).toBe(2.4);
    expect(error.absoluteEndErrorSeconds).toBe(3);
    expect(error.boundaryMaeSeconds).toBe(2.7);
  });

  it('reports an untouched boundary as exactly zero', () => {
    const error = boundaryErrors({
      predictedStartSeconds: 12.5,
      predictedEndSeconds: 30,
      finalStartSeconds: 12.5,
      finalEndSeconds: 28,
    });
    expect(error.startErrorSeconds).toBe(0);
    expect(error.endErrorSeconds).toBe(-2);
    expect(error.boundaryMaeSeconds).toBe(1);
  });
});

describe('summariseBoundaryErrors', () => {
  const errorsFor = (pairs: Array<[number, number]>) =>
    pairs.map(([startShift, endShift]) =>
      boundaryErrors({
        predictedStartSeconds: 100,
        predictedEndSeconds: 200,
        finalStartSeconds: 100 + startShift,
        finalEndSeconds: 200 + endShift,
      }),
    );

  it('returns nulls, not zeros, when nothing has been edited', () => {
    const summary = summariseBoundaryErrors([]);
    expect(summary.editedClips).toBe(0);
    expect(summary.boundaryMaeSeconds).toBeNull();
    expect(summary.medianBoundaryErrorSeconds).toBeNull();
    expect(summary.p90BoundaryErrorSeconds).toBeNull();
    expect(summary.withinSeconds['2']).toBeNull();
    expect(summary.averageStartShiftSeconds).toBeNull();
  });

  it('computes MAE per boundary and overall from per-clip means', () => {
    const summary = summariseBoundaryErrors(errorsFor([[-1, 3], [2, -1]]));
    expect(summary.editedClips).toBe(2);
    expect(summary.startMaeSeconds).toBe(1.5); // (1 + 2) / 2
    expect(summary.endMaeSeconds).toBe(2); // (3 + 1) / 2
    expect(summary.boundaryMaeSeconds).toBe(1.75); // mean of per-clip MAEs 2 and 1.5
  });

  it('keeps signed averages signed, so systematic direction survives', () => {
    // Both edits moved the start LATER — the "starts too early" signature.
    const summary = summariseBoundaryErrors(errorsFor([[2, 0], [3, 0]]));
    expect(summary.averageStartShiftSeconds).toBe(2.5);
    expect(summary.averageEndShiftSeconds).toBe(0);
  });

  it('counts within-±N only when BOTH boundaries are inside the band', () => {
    const summary = summariseBoundaryErrors(errorsFor([[0.5, 0.5], [0.5, 4], [6, 6]]));
    expect(summary.withinSeconds['1']).toBe(round4(1 / 3));
    expect(summary.withinSeconds['5']).toBe(round4(2 / 3));
  });

  it('median resists the terrible tail the mean cannot', () => {
    const summary = summariseBoundaryErrors(errorsFor([[1, 1], [1, 1], [1, 1], [1, 1], [60, 60]]));
    expect(summary.medianBoundaryErrorSeconds).toBe(1);
    expect(summary.boundaryMaeSeconds).toBeGreaterThan(10);
    expect(summary.p90BoundaryErrorSeconds).toBeGreaterThan(1);
  });
});

describe('percentile', () => {
  it('interpolates between ranks', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it('handles a single sample and the extremes', () => {
    expect(percentile([7], 90)).toBe(7);
    expect(percentile([1, 9], 0)).toBe(1);
    expect(percentile([1, 9], 100)).toBe(9);
  });
});

describe('classifyClipState', () => {
  it('a rejection wins over an edit — a discarded moment is not ground truth', () => {
    // Someone can adjust a clip's boundaries and THEN throw the moment away;
    // its timing must not score the model on a moment the person said was wrong.
    expect(classifyClipState({ edited: true, feedback: 'rejected' })).toBe('rejected');
  });

  it('maps the remaining states from the two facts', () => {
    expect(classifyClipState({ edited: true, feedback: 'approved' })).toBe('edited_and_kept');
    expect(classifyClipState({ edited: true, feedback: null })).toBe('edited_and_kept');
    expect(classifyClipState({ edited: false, feedback: 'approved' })).toBe('accepted_without_edit');
    expect(classifyClipState({ edited: false, feedback: null })).toBe('generated_never_reviewed');
    expect(classifyClipState({ edited: false, feedback: 'rejected' })).toBe('rejected');
  });
});

describe('costPerSourceHour', () => {
  it('matches the worked example: $0.08 for 20 minutes ≈ $0.24/hour', () => {
    expect(costPerSourceHour(0.08, 20 * 60)).toBe(0.24);
  });

  it('refuses to price zero or negative footage', () => {
    // A rate over nothing is not a small number — it is no number.
    expect(costPerSourceHour(0.08, 0)).toBeNull();
    expect(costPerSourceHour(0.08, -5)).toBeNull();
  });

  it('refuses non-finite inputs rather than emitting NaN dollars', () => {
    expect(costPerSourceHour(Number.NaN, 3600)).toBeNull();
    expect(costPerSourceHour(1, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

function round4(value: number): number {
  return Number(value.toFixed(4));
}
