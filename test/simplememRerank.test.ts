import { beforeEach, describe, expect, it, vi } from 'vitest';

const embedQuery = vi.fn();
const embedVideoIntervals = vi.fn();
const rerankVideoIntervals = vi.fn();
const verifyWithVideoChat3 = vi.fn();

vi.mock('../src/services/retrieval/qwenModal.js', () => ({
  embedQuery,
  embedVideoIntervals,
  rerankVideoIntervals,
  cosineSimilarity: (left: Float32Array, right: Float32Array) =>
    left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0),
}));

vi.mock('../src/services/videochat3/client.js', () => ({ verifyWithVideoChat3 }));
const listTranscriptSegmentsInRange = vi.fn();
vi.mock('../src/db/repositories/transcripts.js', () => ({ listTranscriptSegmentsInRange }));

const { rerankSimpleMemCandidates } = await import('../src/services/retrieval/simplemem/rerank.js');

const candidates = [
  { startSeconds: 10, endSeconds: 15, score: 0.9, description: 'first', mauIds: ['a'], frames: 1 },
  { startSeconds: 30, endSeconds: 36, score: 0.8, description: 'second', mauIds: ['b'], frames: 1 },
];

function embedding(id: string, values: number[]) {
  return { id, embedding: new Float32Array(values) };
}

describe('Omni-SimpleMem candidate verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    embedQuery.mockResolvedValue({
      model: 'Qwen/Qwen3-VL-Embedding-2B',
      revision: 'embed-rev',
      embedded: [embedding('query', [1, 0])],
      failed: [],
      metrics: { query: true },
    });
    embedVideoIntervals.mockResolvedValue({
      model: 'Qwen/Qwen3-VL-Embedding-2B',
      revision: 'embed-rev',
      embedded: [
        embedding('candidate-0', [0.2, 0.8]),
        embedding('candidate-1', [0.9, 0.1]),
      ],
      failed: [],
      metrics: { video: true },
    });
    rerankVideoIntervals.mockResolvedValue({
      model: 'Qwen/Qwen3-VL-Reranker-2B',
      revision: 'rerank-rev',
      ranked: [
        { id: 'candidate-1', score: 0.97 },
        { id: 'candidate-0', score: 0.3 },
      ],
      failed: [],
      metrics: { rerank: true },
    });
    verifyWithVideoChat3.mockResolvedValue({
      model: 'MCG-NJU/VideoChat3-4B',
      revision: 'vc3-rev',
      results: [
        {
          id: 'candidate-1',
          startSeconds: 30,
          endSeconds: 36,
          match: true,
          confidence: 0.95,
          description: 'confirmed by footage',
        },
        {
          id: 'candidate-0',
          startSeconds: 10,
          endSeconds: 15,
          match: false,
          confidence: 0.1,
          description: '',
        },
      ],
      failed: [],
      metrics: { verify: true },
    });
  });

  it('embeds broadly, reranks, then keeps only VideoChat3-verified moments', async () => {
    const result = await rerankSimpleMemCandidates({
      query: 'find the right sign',
      candidates,
      videoId: 'video-1',
      mode: 'visual',
      videoUrl: 'https://signed/video',
      videoKey: 'proxy',
      expectedBytes: 123,
    });

    expect(embedQuery).toHaveBeenCalledWith('find the right sign');
    expect(embedVideoIntervals).toHaveBeenCalledOnce();
    expect(rerankVideoIntervals.mock.calls[0]?.[0].candidates.map((row: { id: string }) => row.id)).toEqual([
      'candidate-1',
      'candidate-0',
    ]);
    expect(verifyWithVideoChat3.mock.calls[0]?.[0].candidates.map((row: { id: string }) => row.id)).toEqual([
      'candidate-1',
      'candidate-0',
    ]);
    expect(result.candidates).toEqual([
      { ...candidates[1], score: 0.95, description: 'confirmed by footage' },
    ]);
    expect(result.failed).toContainEqual(expect.objectContaining({
      description: 'first',
      reason: 'VideoChat3 did not verify this interval as a matching moment',
    }));
    expect(result.result.model).toBe('MCG-NJU/VideoChat3-4B');
    expect(result.result.revision).toBe('vc3-rev');
  });

  it('never sends an interval forward when its Qwen embedding failed', async () => {
    embedVideoIntervals.mockResolvedValue({
      model: 'Qwen/Qwen3-VL-Embedding-2B',
      revision: 'embed-rev',
      embedded: [embedding('candidate-1', [0.9, 0.1])],
      failed: [{ id: 'candidate-0', reason: 'decode failed' }],
      metrics: {},
    });
    rerankVideoIntervals.mockResolvedValue({
      model: 'Qwen/Qwen3-VL-Reranker-2B',
      revision: 'rerank-rev',
      ranked: [{ id: 'candidate-1', score: 0.97 }],
      failed: [],
      metrics: {},
    });
    verifyWithVideoChat3.mockResolvedValue({
      model: 'MCG-NJU/VideoChat3-4B',
      revision: 'vc3-rev',
      results: [{
        id: 'candidate-1', startSeconds: 30, endSeconds: 36,
        match: true, confidence: 0.9, description: 'confirmed',
      }],
      failed: [],
      metrics: {},
    });

    const result = await rerankSimpleMemCandidates({
      query: 'find it', candidates, videoId: 'video-1', mode: 'visual', videoUrl: 'https://signed/video', videoKey: 'proxy', expectedBytes: 123,
    });

    expect(rerankVideoIntervals.mock.calls[0]?.[0].candidates).toHaveLength(1);
    expect(result.failed).toContainEqual(expect.objectContaining({
      description: 'first',
      reason: 'embedding failed: decode failed',
    }));
  });
});
