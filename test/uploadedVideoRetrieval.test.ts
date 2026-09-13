import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * An uploaded video is read the way an internet video is: VideoChat3 watches
 * the analysis proxy, Qwen embeds and reranks what it flagged, VideoChat3
 * verifies. What an upload adds is a statement of how far the watcher read,
 * and the placing of verified moments on the chunk grid every stored match
 * lives on. Both are pinned here.
 */

const watchWithVideoChat3 = vi.fn();
const verifyWithVideoChat3 = vi.fn();
const embedQuery = vi.fn();
const embedVideoIntervals = vi.fn();
const rerankVideoIntervals = vi.fn();

vi.mock('../src/services/videochat3/client.js', () => ({ watchWithVideoChat3, verifyWithVideoChat3 }));
const listTranscriptSegmentsInRange = vi.fn(async () => []);
vi.mock('../src/db/repositories/transcripts.js', () => ({ listTranscriptSegmentsInRange }));
vi.mock('../src/services/retrieval/qwenModal.js', () => ({
  embedQuery,
  embedVideoIntervals,
  rerankVideoIntervals,
  cosineSimilarity: (left: Float32Array, right: Float32Array) =>
    left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0),
}));

const { analyzeUploadedVideo, placeMomentsOnChunks, unwatchedTail, WATCH_MAX_EVENTS } = await import(
  '../src/services/retrieval/uploadedVideo.js'
);

const chunk = (index: number, start: number, end: number) => ({
  id: `chunk-${index}`,
  videoId: 'video-1',
  chunkIndex: index,
  globalStartSeconds: start,
  globalEndSeconds: end,
  durationSeconds: end - start,
  storageKey: `chunks/${index}.mp4`,
  createdAt: new Date(0),
}) as any;
const chunks = [chunk(0, 0, 120), chunk(1, 120, 240), chunk(2, 240, 300)];

const vector = (id: string, values: number[]) => ({ id, embedding: new Float32Array(values) });

function events(count: number, secondsEach = 2) {
  return Array.from({ length: count }, (_, index) => ({
    startSeconds: index * secondsEach,
    endSeconds: index * secondsEach + secondsEach,
    description: `event ${index}`,
  }));
}

describe('placing verified moments on the chunk grid', () => {
  it('writes chunk-local and global seconds the way the stored-match contract expects', () => {
    const found = placeMomentsOnChunks(
      [{ startSeconds: 130, endSeconds: 141, confidence: 0.93, description: 'the dunk' }],
      chunks,
      { instruction: 'the dunk', provider: 'modal', model: 'MCG-NJU/VideoChat3-4B' },
    );
    expect(found).toEqual([{
      chunkId: 'chunk-1',
      localStartSeconds: 10,
      localEndSeconds: 21,
      globalStartSeconds: 130,
      globalEndSeconds: 141,
      description: 'the dunk',
      confidence: 0.93,
      source: 'visual',
      provider: 'modal',
      model: 'MCG-NJU/VideoChat3-4B',
    }]);
  });

  it('keeps the whole interval when a verified moment crosses an analysis-chunk boundary', () => {
    const [found] = placeMomentsOnChunks(
      [{ startSeconds: 118, endSeconds: 128, confidence: 0.91, description: 'crosses the boundary' }],
      chunks,
      { instruction: 'q', provider: 'modal', model: 'm' },
    );
    expect(found?.chunkId).toBe('chunk-0');
    expect(found?.globalStartSeconds).toBe(118);
    expect(found?.globalEndSeconds).toBe(128);
    expect(found?.localStartSeconds).toBe(118);
    expect(found?.localEndSeconds).toBe(128);
  });

  it('falls back to a description that names the question, and clamps confidence', () => {
    const [found] = placeMomentsOnChunks(
      [{ startSeconds: 5, endSeconds: 9, confidence: 1.4, description: '' }],
      chunks,
      { instruction: 'the sign', provider: 'modal', model: 'm' },
    );
    expect(found?.description).toBe('A moment matching "the sign"');
    expect(found?.confidence).toBe(1);
  });

  it('keeps a moment that runs past the end of the last chunk, clamped to the footage', () => {
    const [found] = placeMomentsOnChunks(
      [{ startSeconds: 295, endSeconds: 302, confidence: 0.8, description: 'tail' }],
      chunks,
      { instruction: 'q', provider: 'modal', model: 'm' },
    );
    expect(found?.chunkId).toBe('chunk-2');
    expect(found?.globalStartSeconds).toBe(295);
    expect(found?.globalEndSeconds).toBe(300);
  });

  it('drops a moment that starts after the footage ends — there is nothing there to cut', () => {
    expect(placeMomentsOnChunks(
      [{ startSeconds: 300.2, endSeconds: 302, confidence: 0.8, description: 'phantom' }],
      chunks,
      { instruction: 'q', provider: 'modal', model: 'm' },
    )).toEqual([]);
  });

  it('finds nothing to place without chunks, instead of throwing', () => {
    expect(placeMomentsOnChunks([{ startSeconds: 1, endSeconds: 2, confidence: 0.9, description: 'x' }], [], {
      instruction: 'q', provider: 'modal', model: 'm',
    })).toEqual([]);
  });
});

describe('how far the watcher read', () => {
  it('reports nothing unwatched when the watch reached the end', () => {
    expect(unwatchedTail({ watchedThroughSeconds: 300, durationSeconds: 300 })).toBeNull();
    expect(unwatchedTail({ watchedThroughSeconds: 300.0005, durationSeconds: 300 })).toBeNull();
  });

  it('names the seconds after the point the watch stopped', () => {
    expect(unwatchedTail({ watchedThroughSeconds: 128, durationSeconds: 300 })).toEqual({ startSeconds: 128, endSeconds: 300 });
  });
});

describe('analyzeUploadedVideo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    embedQuery.mockResolvedValue({ model: 'e', revision: 'r', embedded: [vector('query', [1, 0])], failed: [], metrics: {} });
    embedVideoIntervals.mockImplementation(async (input: { intervals: Array<{ id: string }> }) => ({
      model: 'e', revision: 'r', failed: [], metrics: {},
      embedded: input.intervals.map((row) => vector(row.id, [1, 0])),
    }));
    rerankVideoIntervals.mockImplementation(async (input: { candidates: Array<{ id: string }> }) => ({
      model: 'rr', revision: 'r', failed: [], metrics: {},
      ranked: input.candidates.map((row, index) => ({ id: row.id, score: 1 - index * 0.001 })),
    }));
    verifyWithVideoChat3.mockImplementation(async (input: { candidates: Array<{ id: string; start: number; end: number }> }) => ({
      model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', failed: [], metrics: {},
      results: input.candidates.map((row) => ({
        id: row.id, startSeconds: row.start, endSeconds: row.end, match: true, confidence: 0.9, description: 'seen',
      })),
    }));
  });

  it('asks the watch for the upload cap and reads to the end when the cap is not hit', async () => {
    watchWithVideoChat3.mockResolvedValue({
      model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', durationSeconds: 300, events: events(3), metrics: {},
    });
    const analysis = await analyzeUploadedVideo({
      query: 'q', videoId: 'video-1', mode: 'visual', evidence: 'all', videoUrl: 'https://signed/proxy.mp4', videoKey: 'proxies/v.mp4', expectedBytes: 10, durationSeconds: 300,
    });
    expect(watchWithVideoChat3.mock.calls[0]?.[0].maxEvents).toBe(WATCH_MAX_EVENTS);
    expect(analysis.watchedThroughSeconds).toBe(300);
    expect(analysis.unwatched).toBeNull();
    expect(analysis.verified).toHaveLength(3);
  });

  it('reports the tail after the cap as unwatched, never as empty', async () => {
    watchWithVideoChat3.mockResolvedValue({
      model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', durationSeconds: 300, events: events(WATCH_MAX_EVENTS), metrics: {},
    });
    const analysis = await analyzeUploadedVideo({
      query: 'q', videoId: 'video-1', mode: 'visual', evidence: 'all', videoUrl: 'https://signed/proxy.mp4', videoKey: 'proxies/v.mp4', durationSeconds: 300,
    });
    expect(analysis.watchedThroughSeconds).toBe(WATCH_MAX_EVENTS * 2);
    expect(analysis.unwatched).toEqual({ startSeconds: WATCH_MAX_EVENTS * 2, endSeconds: 300 });
  });

  it('uses the footage\'s own duration when the row has none', async () => {
    watchWithVideoChat3.mockResolvedValue({
      model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', durationSeconds: 90, events: [], metrics: {},
    });
    const analysis = await analyzeUploadedVideo({
      query: 'q', videoId: 'video-1', mode: 'visual', evidence: 'all', videoUrl: 'https://signed/proxy.mp4', videoKey: 'proxies/v.mp4', durationSeconds: null,
    });
    expect(analysis.unwatched).toBeNull();
    expect(analysis.verified).toEqual([]);
    expect(embedQuery).not.toHaveBeenCalled();
  });

  it('carries the seconds of a stretch a stage could not judge, so the gap can be named', async () => {
    watchWithVideoChat3.mockResolvedValue({
      model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', durationSeconds: 300, events: events(2, 10), metrics: {},
    });
    verifyWithVideoChat3.mockResolvedValue({
      model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', metrics: {},
      results: [{ id: 'watch-0', startSeconds: 0, endSeconds: 10, match: true, confidence: 0.9, description: 'seen' }],
      failed: [{ id: 'watch-1', reason: 'ffmpeg exited 1' }],
    });
    const analysis = await analyzeUploadedVideo({
      query: 'q', videoId: 'video-1', mode: 'visual', evidence: 'all', videoUrl: 'https://signed/proxy.mp4', videoKey: 'proxies/v.mp4', durationSeconds: 300,
    });
    expect(analysis.failures).toEqual([
      { id: 'watch-1', reason: 'VideoChat3 verification failed: ffmpeg exited 1', startSeconds: 10, endSeconds: 20 },
    ]);
  });
});
