import { describe, expect, it } from 'vitest';
import {
  boundaryErrors,
  boundaryShift,
  costPerSourceHour,
  percentile,
  summariseBoundaryErrors,
  summariseBoundaryShifts,
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

describe('boundaryShift', () => {
  it('reports signed and absolute movement per boundary, and their average', () => {
    // Start pulled 2s earlier, end pushed 1s later — the classic "hook was
    // late, payoff was cut" correction.
    const shift = boundaryShift(
      { startSeconds: 194.2, endSeconds: 228.7 },
      { startSeconds: 192.2, endSeconds: 229.7 },
    );
    expect(shift.startShiftSeconds).toBe(-2);
    expect(shift.endShiftSeconds).toBe(1);
    expect(shift.absoluteStartShiftSeconds).toBe(2);
    expect(shift.absoluteEndShiftSeconds).toBe(1);
    expect(shift.averageBoundaryShiftSeconds).toBe(1.5);
  });

  it('an unchanged cut is a zero shift, not an error', () => {
    const shift = boundaryShift({ startSeconds: 10, endSeconds: 20 }, { startSeconds: 10, endSeconds: 20 });
    expect(shift.averageBoundaryShiftSeconds).toBe(0);
  });
});

describe('summariseBoundaryShifts', () => {
  it('reports nulls over no re-clips instead of a confident zero', () => {
    const summary = summariseBoundaryShifts([]);
    expect(summary.reclipsMeasured).toBe(0);
    expect(summary.medianBoundaryShiftSeconds).toBeNull();
    expect(summary.p90BoundaryShiftSeconds).toBeNull();
    expect(summary.withinSeconds['1']).toBeNull();
  });

  it('keeps signed averages signed — a consistent direction is the finding', () => {
    // Every re-clip moved the start EARLIER: signed average is negative
    // while the absolute average stays positive.
    const shifts = [
      boundaryShift({ startSeconds: 100, endSeconds: 130 }, { startSeconds: 98, endSeconds: 130 }),
      boundaryShift({ startSeconds: 50, endSeconds: 70 }, { startSeconds: 46, endSeconds: 70 }),
    ];
    const summary = summariseBoundaryShifts(shifts);
    expect(summary.averageSignedStartShiftSeconds).toBe(-3);
    expect(summary.averageAbsoluteStartShiftSeconds).toBe(3);
    expect(summary.averageSignedEndShiftSeconds).toBe(0);
  });

  it('median, P90 and the within-N bands come from per-reclip averages', () => {
    const mk = (s: number) => boundaryShift({ startSeconds: 0, endSeconds: 0 }, { startSeconds: s, endSeconds: s });
    // Average shifts: 0.5, 0.5, 1.5, 2.5, 6 — one bad tail.
    const summary = summariseBoundaryShifts([mk(0.5), mk(0.5), mk(1.5), mk(2.5), mk(6)]);
    expect(summary.reclipsMeasured).toBe(5);
    expect(summary.medianBoundaryShiftSeconds).toBe(1.5);
    expect(summary.withinSeconds['1']).toBe(0.4);
    expect(summary.withinSeconds['2']).toBe(0.6);
    expect(summary.withinSeconds['3']).toBe(0.8);
    expect(summary.withinSeconds['5']).toBe(0.8);
    expect(summary.p90BoundaryShiftSeconds).toBeGreaterThan(2.5);
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
