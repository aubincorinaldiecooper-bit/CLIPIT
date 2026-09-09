import { describe, expect, it, vi } from 'vitest';

const rerankVideoIntervals = vi.fn();
vi.mock('../src/services/mediaIndex/qwen.js', () => ({ rerankVideoIntervals }));

const { rerankSimpleMemCandidates } = await import('../src/services/retrieval/simplemem/rerank.js');

const candidates = [
  { startSeconds: 10, endSeconds: 15, score: 0.9, description: 'first', mauIds: ['a'], frames: 1 },
  { startSeconds: 30, endSeconds: 36, score: 0.8, description: 'second', mauIds: ['b'], frames: 1 },
];

describe('Omni-SimpleMem candidate verification', () => {
  it('uses the existing footage reranker and returns only candidates it verified', async () => {
    rerankVideoIntervals.mockResolvedValue({
      model: 'Qwen/Qwen3-VL-Reranker-2B', revision: 'r1',
      ranked: [{ id: 'simplemem-1', score: 0.95 }],
      failed: [{ id: 'simplemem-0', reason: 'interval unreadable' }], metrics: { gpu_ms: 20 },
    });

    const result = await rerankSimpleMemCandidates({
      query: 'find the right sign', candidates, videoUrl: 'https://signed/video',
      videoKey: 'proxy#etag', expectedBytes: 123,
    });

    expect(rerankVideoIntervals).toHaveBeenCalledWith({
      query: 'find the right sign', videoUrl: 'https://signed/video', videoKey: 'proxy#etag', expectedBytes: 123,
      candidates: [
        { id: 'simplemem-0', start: 10, end: 15 },
        { id: 'simplemem-1', start: 30, end: 36 },
      ],
    });
    expect(result.candidates).toEqual([{ ...candidates[1], score: 0.95 }]);
    expect(result.failed).toEqual([{ ...candidates[0], reason: 'interval unreadable' }]);
  });

  it('preserves the reranker order rather than SimpleMem similarity order', async () => {
    rerankVideoIntervals.mockResolvedValue({
      model: 'Qwen/Qwen3-VL-Reranker-2B', revision: 'r1',
      ranked: [{ id: 'simplemem-1', score: 0.9 }, { id: 'simplemem-0', score: 0.7 }],
      failed: [], metrics: {},
    });

    const result = await rerankSimpleMemCandidates({
      query: 'x', candidates, videoUrl: 'u', videoKey: 'k', expectedBytes: 1,
    });
    expect(result.candidates.map((candidate: { description: string }) => candidate.description)).toEqual(['second', 'first']);
  });
});
