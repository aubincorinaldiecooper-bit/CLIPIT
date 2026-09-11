import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const run = vi.fn();
const uploadFile = vi.fn();
const remove = vi.fn();
const searchVideoChunk = vi.fn();
vi.mock('../src/lib/exec.js', () => ({ run }));
vi.mock('../src/services/storage/s3.js', () => ({ getStorage: () => ({ uploadFile, remove }) }));
vi.mock('../src/services/search/openrouterVideo.js', () => ({ searchVideoChunk }));

const { rerankSimpleMemCandidates } = await import('../src/services/retrieval/simplemem/rerank.js');
const candidates = [
  { startSeconds: 10, endSeconds: 15, score: 0.9, description: 'first', mauIds: ['a'], frames: 1 },
  { startSeconds: 30, endSeconds: 36, score: 0.8, description: 'second', mauIds: ['b'], frames: 1 },
];

describe('Omni-SimpleMem candidate verification', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]))));
    run.mockResolvedValue({ stdout: '', stderr: '' });
    uploadFile.mockResolvedValue(undefined);
    remove.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('keeps only moments the normal footage watcher confirms', async () => {
    searchVideoChunk
      .mockResolvedValueOnce({ matches: [], warnings: [], rawResponse: '{"matches":[]}', provider: 'openrouter', model: 'qwen', promptVersion: 'p1' })
      .mockResolvedValueOnce({ matches: [{ startSeconds: 0.5, endSeconds: 3, confidence: 0.95, description: 'confirmed' }], warnings: [], rawResponse: '{}', provider: 'openrouter', model: 'qwen', promptVersion: 'p1' });
    const result = await rerankSimpleMemCandidates({
      query: 'find the right sign', candidates, videoUrl: 'https://signed/video', videoKey: 'proxy', expectedBytes: 123,
    });
    expect(result.candidates).toEqual([{ ...candidates[1], score: 0.95, description: 'confirmed' }]);
    expect(result.failed[0]?.description).toBe('first');
    expect(result.result.metrics.verifier).toBe('clipit-actual-footage');
    expect(searchVideoChunk).toHaveBeenCalledTimes(2);
  });
});
