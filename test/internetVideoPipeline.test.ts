import { beforeEach, describe, expect, it, vi } from 'vitest';

const watchWithVideoChat3 = vi.fn();
const verifyWithVideoChat3 = vi.fn();
const embedQuery = vi.fn();
const embedVideoIntervals = vi.fn();
const rerankVideoIntervals = vi.fn();

vi.mock('../src/services/videochat3/client.js', () => ({
  watchWithVideoChat3,
  verifyWithVideoChat3,
}));

vi.mock('../src/services/retrieval/qwenModal.js', () => ({
  embedQuery,
  embedVideoIntervals,
  rerankVideoIntervals,
  cosineSimilarity: (left: Float32Array, right: Float32Array) =>
    left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0),
}));

const { analyzeInternetVideo } = await import('../src/services/retrieval/internetVideo.js');

function vector(id: string, values: number[]) {
  return { id, embedding: new Float32Array(values) };
}

describe('internet video analysis pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    watchWithVideoChat3.mockResolvedValue({
      model: 'MCG-NJU/VideoChat3-4B',
      revision: 'vc3-rev',
      durationSeconds: 60,
      events: [
        { startSeconds: 10, endSeconds: 14, description: 'first event' },
        { startSeconds: 30, endSeconds: 35, description: 'second event' },
      ],
      metrics: { watch: true },
    });
    embedQuery.mockResolvedValue({
      model: 'Qwen/Qwen3-VL-Embedding-2B',
      revision: 'embed-rev',
      embedded: [vector('query', [1, 0])],
      failed: [],
      metrics: {},
    });
    embedVideoIntervals.mockResolvedValue({
      model: 'Qwen/Qwen3-VL-Embedding-2B',
      revision: 'embed-rev',
      embedded: [vector('watch-0', [0.1, 0.9]), vector('watch-1', [0.9, 0.1])],
      failed: [],
      metrics: {},
    });
    rerankVideoIntervals.mockResolvedValue({
      model: 'Qwen/Qwen3-VL-Reranker-2B',
      revision: 'rerank-rev',
      ranked: [{ id: 'watch-1', score: 0.98 }, { id: 'watch-0', score: 0.2 }],
      failed: [],
      metrics: {},
    });
    verifyWithVideoChat3.mockResolvedValue({
      model: 'MCG-NJU/VideoChat3-4B',
      revision: 'vc3-rev',
      results: [
        { id: 'watch-1', startSeconds: 30, endSeconds: 35, match: true, confidence: 0.94, description: 'verified second' },
        { id: 'watch-0', startSeconds: 10, endSeconds: 14, match: false, confidence: 0.12, description: '' },
      ],
      failed: [],
      metrics: { verify: true },
    });
  });

  it('uses VideoChat3 watch before Qwen retrieval and VideoChat3 verification', async () => {
    const result = await analyzeInternetVideo({
      query: 'find the sign',
      videoUrl: 'https://media.example/video.mp4',
      videoKey: 'internet:abc',
      expectedBytes: 1234,
    });

    expect(watchWithVideoChat3).toHaveBeenCalledOnce();
    expect(rerankVideoIntervals.mock.calls[0]?.[0].candidates.map((row: { id: string }) => row.id)).toEqual([
      'watch-1',
      'watch-0',
    ]);
    expect(verifyWithVideoChat3.mock.calls[0]?.[0].candidates.map((row: { id: string }) => row.id)).toEqual([
      'watch-1',
      'watch-0',
    ]);
    expect(result.verified).toEqual([
      { startSeconds: 30, endSeconds: 35, confidence: 0.94, description: 'verified second' },
    ]);
    expect(result.model).toBe('MCG-NJU/VideoChat3-4B');
  });

  it('does not call Qwen or verification when the first watch yields no temporal leads', async () => {
    watchWithVideoChat3.mockResolvedValue({
      model: 'MCG-NJU/VideoChat3-4B',
      revision: 'vc3-rev',
      durationSeconds: 60,
      events: [],
      metrics: {},
    });

    const result = await analyzeInternetVideo({
      query: 'not present',
      videoUrl: 'https://media.example/video.mp4',
      videoKey: 'internet:abc',
    });

    expect(result.verified).toEqual([]);
    expect(embedQuery).not.toHaveBeenCalled();
    expect(rerankVideoIntervals).not.toHaveBeenCalled();
    expect(verifyWithVideoChat3).not.toHaveBeenCalled();
  });
});
