import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * How much of a video the notes describe is the seconds they cover, not the
 * furthest second any note reaches: parts are read out of order, and the
 * furthest reached called a video with a four-minute hole in the middle
 * fully read (2026-09-02).
 */

const queryRows = vi.fn();
const queryOne = vi.fn();
vi.mock('../src/db/pool.js', () => ({
  queryRows: (...args: unknown[]) => queryRows(...args),
  queryOne: (...args: unknown[]) => queryOne(...args),
}));

const { coveredSeconds, sceneProgress } = await import('../src/db/repositories/scenes.js');

beforeEach(() => {
  queryRows.mockReset();
  queryOne.mockReset();
});

describe('coveredSeconds', () => {
  it('sums what the notes cover, and leaves the unread middle out', async () => {
    // Parts 0, 1, 2 and 5 read; 3 and 4 (361–601 s) not yet.
    queryRows.mockResolvedValue([
      { start_seconds: 0, end_seconds: 60 }, { start_seconds: 60, end_seconds: 121 },
      { start_seconds: 121, end_seconds: 241 }, { start_seconds: 241, end_seconds: 361 },
      { start_seconds: 601, end_seconds: 685.383 },
    ]);
    await expect(coveredSeconds('video-1')).resolves.toBe(445.383);
  });

  it('merges scenes that overlap, and treats a second of rounding as no gap', async () => {
    queryRows.mockResolvedValue([
      { start_seconds: 0, end_seconds: 30 }, { start_seconds: 20, end_seconds: 50 }, { start_seconds: 50.6, end_seconds: 90 },
    ]);
    await expect(coveredSeconds('video-1')).resolves.toBe(90);
  });

  it('is nothing for a video with no notes', async () => {
    queryRows.mockResolvedValue([]);
    await expect(coveredSeconds('video-1')).resolves.toBe(0);
  });
});

describe('sceneProgress', () => {
  it('reports the count and the coverage, never the furthest second', async () => {
    queryOne.mockResolvedValue({ count: 5 });
    queryRows.mockResolvedValue([{ start_seconds: 0, end_seconds: 121 }, { start_seconds: 601, end_seconds: 685 }]);
    await expect(sceneProgress('video-1')).resolves.toEqual({ count: 5, readThroughSeconds: 205 });
  });
});
