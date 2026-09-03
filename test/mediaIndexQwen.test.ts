import { beforeEach, describe, expect, it, vi } from 'vitest';

process.env.MODAL_TOKEN_ID = 'test-token-id';
process.env.MODAL_TOKEN_SECRET = 'test-token-secret';

/**
 * What the Media Index believes when a model answers.
 *
 * Everything a model returns is untrusted input — the rule this codebase
 * already applies to the JSON the video model produces. It applies harder to
 * a vector, because a wrong vector cannot be spotted by reading it. A number
 * from the wrong model, of the wrong length, unnormalized, or attached to the
 * wrong interval still sorts perfectly and still produces a confident answer.
 * That is the failure these tests exist to make impossible.
 *
 * The transport is mocked at the seam: this is about what Clipit accepts, not
 * about Modal's wire protocol, which invoke.ts owns and minicpmVideo already
 * covers.
 */
const invokeMock = vi.fn();
vi.mock('../src/services/modal/invoke.js', () => ({
  invokeModal: (...args: unknown[]) => invokeMock(...args),
  assertModalTargetAvailable: vi.fn(),
  resetModalHandles: vi.fn(),
}));

const { embedTexts, embedVideoIntervals, rerankVideoIntervals } = await import(
  '../src/services/mediaIndex/qwen.js'
);
const MODEL = 'Qwen/Qwen3-VL-Embedding-2B';
const RERANK_MODEL = 'Qwen/Qwen3-VL-Reranker-2B';
const DIMS = 2048;

/** A unit vector, as the service promises to return. */
function unit(seed = 1): number[] {
  const values = Array.from({ length: DIMS }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return values.map((value) => value / norm);
}

const intervals = [
  { id: '000000000-000010000', start: 0, end: 10 },
  { id: '000005000-000015000', start: 5, end: 15 },
];

function reply(overrides: Record<string, unknown> = {}) {
  return {
    model: MODEL,
    dim: DIMS,
    sampling: { fps: 2, max_frames: 16 },
    results: intervals.map((interval, index) => ({
      id: interval.id, start: interval.start, end: interval.end, embedding: unit(index + 1), frames: 16,
    })),
    failed: [],
    metrics: { total_ms: 900 },
    ...overrides,
  };
}

beforeEach(() => invokeMock.mockReset());

describe('embedVideoIntervals', () => {
  it('carries the signed URL and the stable key as two different things', async () => {
    // The URL is minted per call and expires; the key is the video's identity
    // and is what the remote container caches its one download under. Caching
    // by URL would never hit, because no two signed URLs are the same string.
    invokeMock.mockResolvedValue(reply());
    await embedVideoIntervals({
      videoUrl: 'https://storage.example/proxy.mp4?signature=abc',
      videoKey: 'proxies/vid-1/proxy.mp4',
      expectedBytes: 12_345_678,
      intervals,
    });
    const [, kwargs] = invokeMock.mock.calls[0]!;
    expect(kwargs).toMatchObject({
      video_url: 'https://storage.example/proxy.mp4?signature=abc',
      video_key: 'proxies/vid-1/proxy.mp4',
      // The size the identity was read at. The far side refuses anything
      // else, which catches a video re-processed between the two.
      expect_bytes: 12_345_678,
      intervals,
    });
  });

  it('matches results by id, never by position', async () => {
    // A batch that comes back reordered is normal. Reading it positionally
    // would attach every vector to the wrong stretch of video, and nothing
    // downstream could ever notice.
    invokeMock.mockResolvedValue(reply({
      results: [
        { id: intervals[1]!.id, embedding: unit(2), frames: 16 },
        { id: intervals[0]!.id, embedding: unit(1), frames: 16 },
      ],
    }));
    const result = await embedVideoIntervals({ videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, intervals });
    const byId = new Map(result.embedded.map((row) => [row.id, row.embedding[0]]));
    expect(byId.get(intervals[0]!.id)).toBeCloseTo(unit(1)[0]!, 6);
    expect(byId.get(intervals[1]!.id)).toBeCloseTo(unit(2)[0]!, 6);
  });

  it('refuses vectors from a different model', async () => {
    // Two models' vectors in one index look exactly like working retrieval.
    invokeMock.mockResolvedValue(reply({ model: 'Qwen/Qwen3-VL-Embedding-8B' }));
    await expect(embedVideoIntervals({ videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, intervals })).rejects.toThrow(
      /Qwen3-VL-Embedding-8B/,
    );
  });

  it('refuses vectors of the wrong length', async () => {
    invokeMock.mockResolvedValue(reply({
      dim: 1024,
      results: [{ id: intervals[0]!.id, embedding: unit(1).slice(0, 1024), frames: 8 }],
    }));
    await expect(embedVideoIntervals({ videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, intervals })).rejects.toThrow(/1024/);
  });

  it('refuses a vector that is not normalized', async () => {
    // The service normalizes. One that is far off unit length means something
    // changed on the other side — different pooling, a half-loaded checkpoint
    // — and cosine over it still sorts, so nothing else would catch it.
    invokeMock.mockResolvedValue(reply({
      results: [{ id: intervals[0]!.id, embedding: unit(1).map((v) => v * 3), frames: 16 }],
    }));
    await expect(embedVideoIntervals({ videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, intervals })).rejects.toThrow(/not normalized/);
  });

  it('refuses an id nobody asked for', async () => {
    invokeMock.mockResolvedValue(reply({
      results: [{ id: '000900000-000910000', embedding: unit(1), frames: 16 }],
    }));
    await expect(embedVideoIntervals({ videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, intervals })).rejects.toThrow(/nobody asked for/);
  });

  it('refuses a non-finite component', async () => {
    const broken = unit(1); broken[7] = Number.NaN;
    invokeMock.mockResolvedValue(reply({ results: [{ id: intervals[0]!.id, embedding: broken, frames: 16 }] }));
    await expect(embedVideoIntervals({ videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, intervals })).rejects.toThrow(/non-finite/);
  });

  it('names a range that came back with neither a vector nor a reason', async () => {
    // The silent hole. A window that simply vanishes from the reply would be
    // a stretch of video with no embedding that nothing ever reports as
    // missing — the exact shape of "reported an absence we never verified".
    invokeMock.mockResolvedValue(reply({
      results: [{ id: intervals[0]!.id, embedding: unit(1), frames: 16 }],
      failed: [],
    }));
    const result = await embedVideoIntervals({ videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, intervals });
    expect(result.embedded).toHaveLength(1);
    expect(result.failed).toEqual([
      { id: intervals[1]!.id, reason: expect.stringContaining('neither an embedding nor a failure') },
    ]);
  });

  it('keeps a reported failure as a failure, not as a zero vector', async () => {
    invokeMock.mockResolvedValue(reply({
      results: [{ id: intervals[0]!.id, embedding: unit(1), frames: 16 }],
      failed: [{ id: intervals[1]!.id, reason: 'no frames decoded for this range' }],
    }));
    const result = await embedVideoIntervals({ videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, intervals });
    expect(result.failed).toEqual([{ id: intervals[1]!.id, reason: 'no frames decoded for this range' }]);
    expect(result.embedded.some((row) => row.id === intervals[1]!.id)).toBe(false);
  });

  it('refuses a failure for a range nobody asked for', async () => {
    // The failure list is coverage. A wrong entry attaches a hole to a stretch
    // of video that was never in question.
    invokeMock.mockResolvedValue(reply({
      results: [], failed: [{ id: '000900000-000910000', reason: 'x' }],
    }));
    await expect(embedVideoIntervals({ videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, intervals }))
      .rejects.toThrow(/nobody asked for/);
  });

  it('refuses the same range failed twice', async () => {
    invokeMock.mockResolvedValue(reply({
      results: [],
      failed: [{ id: intervals[0]!.id, reason: 'a' }, { id: intervals[0]!.id, reason: 'b' }],
    }));
    await expect(embedVideoIntervals({ videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, intervals }))
      .rejects.toThrow(/twice/);
  });

  it('refuses a range that is both embedded and failed', async () => {
    // Reported as indexed and as missing at once. One is wrong, nothing says
    // which, so neither is believed.
    invokeMock.mockResolvedValue(reply({
      results: [{ id: intervals[0]!.id, embedding: unit(1), frames: 16 }],
      failed: [{ id: intervals[0]!.id, reason: 'could not decode' }],
    }));
    await expect(embedVideoIntervals({ videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, intervals }))
      .rejects.toThrow(/both answered and failed/);
  });

  it('refuses duplicate ids in the request, before paying for the call', async () => {
    await expect(embedVideoIntervals({
      videoUrl: 'u', videoKey: 'k',
      intervals: [intervals[0]!, { ...intervals[0]! }],
    })).rejects.toThrow(/unique/);
    // The point is that the GPU is never asked: the reply would have been
    // ordinary and the client would have rejected it as duplicated anyway.
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('refuses duplicate ids on the text and rerank calls too', async () => {
    await expect(embedTexts({
      texts: [{ id: 'a', text: 'one' }, { id: 'a', text: 'two' }], isQuery: false,
    })).rejects.toThrow(/unique/);
    await expect(rerankVideoIntervals({
      query: 'q', videoUrl: 'u', videoKey: 'k',
      candidates: [intervals[0]!, { ...intervals[0]! }],
    })).rejects.toThrow(/unique/);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('does not call the GPU for an empty list', async () => {
    const result = await embedVideoIntervals({ videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, intervals: [] });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.embedded).toEqual([]);
  });
});

describe('embedTexts', () => {
  it('states whether the text is a question or a document', async () => {
    // These models are asymmetric. Swapping the two does not raise anything —
    // it returns well-ordered, confident, wrong results — so it is never
    // inferred.
    invokeMock.mockResolvedValue({
      model: MODEL, dim: DIMS, results: [{ id: 'q', embedding: unit(3) }], failed: [], metrics: {},
    });
    await embedTexts({ texts: [{ id: 'q', text: 'where do they discuss pricing' }], isQuery: true });
    expect(invokeMock.mock.calls[0]![1]).toMatchObject({ is_query: true });
  });
});

describe('rerankVideoIntervals', () => {
  it('returns candidates best first, by id', async () => {
    invokeMock.mockResolvedValue({
      model: RERANK_MODEL,
      results: [
        { id: intervals[0]!.id, start: 0, end: 10, score: 0.21 },
        { id: intervals[1]!.id, start: 5, end: 15, score: 0.88 },
      ],
      failed: [], metrics: {},
    });
    const result = await rerankVideoIntervals({ query: 'q', videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, candidates: intervals });
    expect(result.ranked.map((row) => row.id)).toEqual([intervals[1]!.id, intervals[0]!.id]);
  });

  it('refuses a ranking from a different reranker', async () => {
    // A stale or misrouted deployment scores every candidate and returns a
    // clean ranking. Nothing in the output would say the comparison the
    // experiment exists to make had been invalidated.
    invokeMock.mockResolvedValue({
      model: 'Qwen/Qwen3-VL-Reranker-8B',
      results: [{ id: intervals[0]!.id, score: 0.9 }], failed: [], metrics: {},
    });
    await expect(rerankVideoIntervals({ query: 'q', videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, candidates: intervals }))
      .rejects.toThrow(/Reranker-8B/);
  });

  it('refuses a ranking that names no model at all', async () => {
    invokeMock.mockResolvedValue({ results: [{ id: intervals[0]!.id, score: 0.9 }], failed: [], metrics: {} });
    await expect(rerankVideoIntervals({ query: 'q', videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, candidates: intervals }))
      .rejects.toThrow(/none given/);
  });

  it('refuses a score that is not a number', async () => {
    invokeMock.mockResolvedValue({
      model: RERANK_MODEL, results: [{ id: intervals[0]!.id, score: 'very relevant' }], failed: [], metrics: {},
    });
    await expect(rerankVideoIntervals({ query: 'q', videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, candidates: intervals }))
      .rejects.toThrow(/non-numeric/);
  });

  it('names a candidate that came back with neither a score nor a reason', async () => {
    // Devin's finding on #93, and it was real. A reply that quietly drops a
    // candidate still sorts and still reads as a considered ranking — and the
    // experiment would have counted unread footage as footage that was read
    // and judged irrelevant. A shorter list is not a verdict.
    invokeMock.mockResolvedValue({
      model: RERANK_MODEL, results: [{ id: intervals[0]!.id, score: 0.7 }], failed: [], metrics: {},
    });
    const result = await rerankVideoIntervals({ query: 'q', videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, candidates: intervals });
    expect(result.ranked).toHaveLength(1);
    expect(result.failed).toEqual([
      { id: intervals[1]!.id, reason: expect.stringContaining('neither a score nor a failure') },
    ]);
  });

  it('refuses a score for an id nobody asked for', async () => {
    invokeMock.mockResolvedValue({
      model: RERANK_MODEL, results: [{ id: '000900000-000910000', score: 0.9 }], failed: [], metrics: {},
    });
    await expect(rerankVideoIntervals({ query: 'q', videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, candidates: intervals }))
      .rejects.toThrow(/nobody asked for/);
  });

  it('refuses a failure for an id nobody asked for', async () => {
    invokeMock.mockResolvedValue({
      model: RERANK_MODEL, results: [], failed: [{ id: 'not-ours', reason: 'x' }], metrics: {},
    });
    await expect(rerankVideoIntervals({ query: 'q', videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, candidates: intervals }))
      .rejects.toThrow(/nobody asked for/);
  });

  it('refuses the same candidate scored twice', async () => {
    invokeMock.mockResolvedValue({
      model: RERANK_MODEL,
      results: [{ id: intervals[0]!.id, score: 0.7 }, { id: intervals[0]!.id, score: 0.2 }],
      failed: [], metrics: {},
    });
    await expect(rerankVideoIntervals({ query: 'q', videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, candidates: intervals }))
      .rejects.toThrow(/twice/);
  });

  it('refuses a candidate that is both scored and failed', async () => {
    // One of the two is wrong and nothing says which, so neither is believed.
    // Same wording as the embedding side: one rule, one message, one helper.
    invokeMock.mockResolvedValue({
      model: RERANK_MODEL,
      results: [{ id: intervals[0]!.id, score: 0.7 }],
      failed: [{ id: intervals[0]!.id, reason: 'could not decode' }],
      metrics: {},
    });
    await expect(rerankVideoIntervals({ query: 'q', videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, candidates: intervals }))
      .rejects.toThrow(/both answered and failed/);
  });

  it('reports an unreadable candidate rather than scoring it zero', async () => {
    // A zero would sort last and read exactly like a considered judgement
    // that the moment was irrelevant.
    invokeMock.mockResolvedValue({
      model: RERANK_MODEL,
      results: [{ id: intervals[0]!.id, score: 0.5 }],
      failed: [{ id: intervals[1]!.id, reason: 'no frames decoded for this range' }],
      metrics: {},
    });
    const result = await rerankVideoIntervals({ query: 'q', videoUrl: 'u', videoKey: 'k', expectedBytes: 1000, candidates: intervals });
    expect(result.ranked).toHaveLength(1);
    expect(result.failed[0]!.id).toBe(intervals[1]!.id);
  });
});
