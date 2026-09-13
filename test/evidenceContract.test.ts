import { readFile } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The evidence contract for uploaded videos.
 *
 * There is exactly one answer to "what evidence does this request need":
 * the ResolvedSearchMode decided in handleClipSearch. `visual` needs
 * footage; `transcript` needs speech; `both` needs footage AND the
 * timestamp-aligned transcript of the same interval, judged together, and
 * neither alone is enough. Downstream nothing re-reads the question, a
 * verdict is evidence only through the one confidence gate, and a visual
 * or mixed question never falls back to the retired per-chunk watcher.
 */

const read = (path: string) => readFile(new URL('../' + path, import.meta.url), 'utf8');

const watchWithVideoChat3 = vi.fn();
const verifyWithVideoChat3 = vi.fn();
const embedQuery = vi.fn();
const embedVideoIntervals = vi.fn();
const rerankVideoIntervals = vi.fn();
const listTranscriptSegmentsInRange = vi.fn();

vi.mock('../src/services/videochat3/client.js', () => ({ watchWithVideoChat3, verifyWithVideoChat3 }));
vi.mock('../src/services/retrieval/qwenModal.js', () => ({
  embedQuery,
  embedVideoIntervals,
  rerankVideoIntervals,
  cosineSimilarity: (left: Float32Array, right: Float32Array) =>
    left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0),
}));
vi.mock('../src/db/repositories/transcripts.js', () => ({ listTranscriptSegmentsInRange }));

// --- The handler-level harness: the retired per-chunk watcher is a spy that must stay silent.
const searchVideoChunk = vi.fn();
const assertVideoInputSupported = vi.fn();
const releaseDeckAndComplete = vi.fn(async () => true);
const recordChunkFailure = vi.fn(async () => true);
const recordRetrievalOutcome = vi.fn(async () => undefined);
const finishClipRequest = vi.fn(async () => true);
const insertMatches = vi.fn(async () => []);
const listMatches = vi.fn(async (): Promise<Array<Record<string, unknown>>> => []);
const request = {
  id: 'request-1', videoId: 'video-1', sessionId: null, userId: null, workspaceId: null,
  instruction: 'show where she says goodbye while leaving the room', mode: 'auto', resolvedMode: null,
  status: 'pending', errorMessage: null, chunksTotal: 0, chunksCompleted: 0, chunksFailed: 0,
  chunkErrors: [], chunkDegradations: [], answeredFrom: null, retrievalPrimary: null, retrievalSystem: null,
  fallbackReason: null, primaryOutcome: null, conversationalAnswer: null, uncertainMatches: [],
  presentationTarget: null, requestedResultCount: null, availableCandidateCount: null, effectiveDeckTarget: null,
  createdAt: new Date('2026-09-13T00:00:00Z'),
};
const getClipRequest = vi.fn(async () => ({ ...request }));

vi.mock('../src/db/repositories/clipRequests.js', () => ({
  claimClipRequestAttempt: vi.fn(async () => 'attempt-1'),
  finishClipRequest,
  getClipRequest,
  getPreviousClipRequest: vi.fn(),
  insertMatches,
  listMatches,
  recordChunkCompleted: vi.fn(),
  recordChunkDegraded: vi.fn(),
  recordChunkFailure,
  recordConversationalAnswer: vi.fn(async () => true),
  recordDeckAvailability: vi.fn(async () => undefined),
  recordDeckPlan: vi.fn(async () => true),
  recordRetrievalOutcome,
  recordCorrection: vi.fn(),
  recordUncertainMatches: vi.fn(),
  releaseDeckAndComplete,
  startClipRequest: vi.fn(async () => undefined),
}));
const chunk = (index: number, start: number, end: number) => ({
  id: `chunk-${index}`, videoId: 'video-1', chunkIndex: index, globalStartSeconds: start, globalEndSeconds: end,
  durationSeconds: end - start, storageKey: `chunks/${index}.mp4`, createdAt: new Date(0),
});
const video = {
  id: 'video-1', status: 'ready', proxyStorageKey: 'proxies/video-1/proxy.mp4', playbackStorageKey: null,
  durationSeconds: 300, sizeBytes: 1000, transcriptStatus: 'ready', transcriptSegmentCount: 5, errorMessage: null,
  createdAt: new Date(0),
};
vi.mock('../src/db/repositories/videos.js', () => ({
  getVideo: vi.fn(async () => ({ ...video })),
  listChunks: vi.fn(async () => [chunk(0, 0, 120), chunk(1, 120, 240), chunk(2, 240, 300)]),
}));
vi.mock('../src/db/repositories/simplememIndex.js', () => ({
  getSimpleMemIndex: vi.fn(async () => null),
  setSimpleMemIndexStatus: vi.fn(),
}));
vi.mock('../src/db/repositories/usage.js', () => ({ recordModelUsage: vi.fn() }));
vi.mock('../src/db/repositories/verticalMedia.js', () => ({ clearUnkeptMatchesForRequest: vi.fn(async () => []) }));
vi.mock('../src/services/storage/s3.js', () => ({
  getStorage: () => ({
    head: vi.fn(async () => ({ key: 'proxies/video-1/proxy.mp4', sizeBytes: 1000 })),
    createDownloadUrl: vi.fn(async () => 'https://signed/proxy.mp4'),
    downloadToFile: vi.fn(), uploadFile: vi.fn(), remove: vi.fn(),
  }),
}));
vi.mock('../src/services/search/openrouterVideo.js', () => ({
  searchVideoChunk,
  isContentFilterRejection: () => false,
  resetVideoCallPeak: vi.fn(),
  videoCallStats: () => ({ limit: 1, inFlight: 0, peak: 0 }),
}));
vi.mock('../src/services/search/modelCapabilities.js', () => ({ assertVideoInputSupported }));
vi.mock('../src/services/search/conversationalAnswer.js', () => ({
  writeConversationalAnswer: vi.fn(async () => ({
    text: 'No verified moments were found.', citationIds: [], provider: 'openrouter', model: 'm', promptVersion: 'v',
  })),
}));
vi.mock('../src/services/media/thumbnails.js', () => ({ attachThumbnails: vi.fn() }));
vi.mock('../src/queues/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/queues/index.js')>();
  return { ...actual, enqueueClipSearch: vi.fn(), enqueueClipGeneration: vi.fn() };
});

const { env } = await import('../src/config/env.js');
const { classifyInstruction, resolveSearchMode } = await import('../src/services/search/instructionMode.js');
const { analyzeUploadedVideo } = await import('../src/services/retrieval/uploadedVideo.js');
const { rerankSimpleMemCandidates } = await import('../src/services/retrieval/simplemem/rerank.js');
const { decideFallback } = await import('../src/services/retrieval/simplemem/candidates.js');
const { MISSING_TRANSCRIPT_REASON, passesEvidenceGate } = await import('../src/services/retrieval/mixedEvidence.js');
const { handleClipSearch } = await import('../src/worker/handlers/clipSearch.js');

const MIN = env.MIN_MATCH_CONFIDENCE;
const vector = (id: string, values: number[]) => ({ id, embedding: new Float32Array(values) });
const segment = (start: number, end: number, text: string) => ({
  id: `seg-${start}`, videoId: 'video-1', segmentIndex: 0, startSeconds: start, endSeconds: end, text, source: 'whisper',
});

/** Speech exists only around 30–35 s ("goodbye"); the 10–14 s stretch is silent. */
function transcriptOnlyAtGoodbye() {
  listTranscriptSegmentsInRange.mockImplementation(async (_videoId: string, start: number, end: number) =>
    end > 29 && start < 36 ? [segment(30.2, 33.8, 'okay, goodbye everyone')] : [],
  );
}

function wholeVideoPipeline() {
  watchWithVideoChat3.mockResolvedValue({
    model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', durationSeconds: 300, metrics: {},
    events: [
      { startSeconds: 10, endSeconds: 14, description: 'she walks out of the room' },
      { startSeconds: 30, endSeconds: 35, description: 'she waves and leaves' },
    ],
  });
  embedQuery.mockResolvedValue({ model: 'e', revision: 'r', embedded: [vector('query', [1, 0])], failed: [], metrics: {} });
  embedVideoIntervals.mockResolvedValue({
    model: 'e', revision: 'r', failed: [], metrics: {},
    embedded: [vector('watch-0', [0.8, 0.2]), vector('watch-1', [0.9, 0.1])],
  });
  rerankVideoIntervals.mockResolvedValue({
    model: 'rr', revision: 'r', failed: [], metrics: {},
    ranked: [{ id: 'watch-1', score: 0.95 }, { id: 'watch-0', score: 0.9 }],
  });
  // First (visual) verification: both stretches show her leaving.
  verifyWithVideoChat3.mockResolvedValueOnce({
    model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', failed: [], metrics: {},
    results: [
      { id: 'watch-1', startSeconds: 30, endSeconds: 35, match: true, confidence: 0.94, description: 'leaves, waving' },
      { id: 'watch-0', startSeconds: 10, endSeconds: 14, match: true, confidence: 0.8, description: 'walks out' },
    ],
  });
}

const upload = (mode: 'visual' | 'both', query = 'show where she says goodbye while leaving the room') =>
  analyzeUploadedVideo({
    query, videoId: 'video-1', videoUrl: 'https://signed/proxy.mp4', videoKey: 'proxies/video-1/proxy.mp4',
    expectedBytes: 1000, durationSeconds: 300, mode,
  });

beforeEach(() => {
  vi.clearAllMocks();
  listTranscriptSegmentsInRange.mockResolvedValue([]);
});

describe('1. an automatic mixed request needs footage and speech together', () => {
  it('resolves to both, and visual evidence alone cannot survive', async () => {
    const resolved = resolveSearchMode({
      instruction: 'show where she says goodbye while leaving the room', requested: 'auto', transcriptAvailable: true,
    });
    expect(resolved.mode).toBe('both');

    wholeVideoPipeline();
    transcriptOnlyAtGoodbye();
    // Second (mixed) verification: the verifier is handed the clip AND its transcript.
    verifyWithVideoChat3.mockResolvedValueOnce({
      model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', failed: [], metrics: {},
      results: [{ id: 'mixed-0', startSeconds: 30, endSeconds: 35, match: true, confidence: 0.9, description: 'says goodbye while leaving' }],
    });

    const analysis = await upload(resolved.mode as 'both');

    expect(verifyWithVideoChat3).toHaveBeenCalledTimes(2);
    const mixedCall = verifyWithVideoChat3.mock.calls[1]?.[0];
    expect(mixedCall.candidates).toEqual([
      { id: 'mixed-0', start: 30, end: 35, transcript: '[30.2-33.8] okay, goodbye everyone' },
    ]);
    // The silent 10–14 s stretch, though visually verified, is not evidence.
    expect(analysis.verified).toEqual([{ startSeconds: 30, endSeconds: 35, confidence: 0.9, description: 'says goodbye while leaving' }]);
    expect(analysis.failures).toContainEqual({ id: 'mixed-1', reason: MISSING_TRANSCRIPT_REASON, startSeconds: 10, endSeconds: 14 });
  });
});

describe('2. an explicit both stays both, however visual the wording', () => {
  it('the request-level resolver keeps both; nothing downstream reclassifies it', async () => {
    expect(classifyInstruction('show her leaving the room').mode).toBe('visual');
    const resolved = resolveSearchMode({ instruction: 'show her leaving the room', requested: 'both', transcriptAvailable: true });
    expect(resolved.mode).toBe('both');

    wholeVideoPipeline();
    // No speech anywhere: every visually verified moment is rejected for want of a transcript.
    const analysis = await upload('both', 'show her leaving the room');
    expect(verifyWithVideoChat3).toHaveBeenCalledTimes(1);
    expect(analysis.verified).toEqual([]);
    expect(analysis.failures.filter((failure) => failure.reason === MISSING_TRANSCRIPT_REASON)).toHaveLength(2);
    expect(listTranscriptSegmentsInRange).toHaveBeenCalled();
  });

  it('no downstream layer imports the classifier', async () => {
    for (const path of [
      'src/services/retrieval/uploadedVideo.ts',
      'src/services/retrieval/mixedEvidence.ts',
      'src/services/retrieval/simplemem/rerank.ts',
      'src/services/retrieval/internetVideo.ts',
    ]) {
      expect(await read(path), path).not.toContain('classifyInstruction');
    }
    // Only the request-level resolver may classify, and only for `auto`.
    const handler = await read('src/worker/handlers/clipSearch.ts');
    expect(handler).not.toContain('classifyInstruction');
    expect(handler).toContain('resolveSearchMode({');
  });

  it('a request the resolver downgraded to visual gets no transcript work', async () => {
    const resolved = resolveSearchMode({ instruction: 'show where she says goodbye', requested: 'both', transcriptAvailable: false });
    expect(resolved.mode).toBe('visual');
    wholeVideoPipeline();
    const analysis = await upload(resolved.mode as 'visual');
    expect(verifyWithVideoChat3).toHaveBeenCalledTimes(1);
    expect(listTranscriptSegmentsInRange).not.toHaveBeenCalled();
    expect(analysis.verified).toHaveLength(2);
  });
});

const memoryCandidates = [
  { startSeconds: 30, endSeconds: 36, score: 0.9, description: 'she waves at the door', mauIds: ['a'], frames: 1 },
  { startSeconds: 10, endSeconds: 15, score: 0.8, description: 'she walks out', mauIds: ['b'], frames: 1 },
];

function memoryPipeline() {
  embedQuery.mockResolvedValue({ model: 'e', revision: 'r', embedded: [vector('query', [1, 0])], failed: [], metrics: {} });
  embedVideoIntervals.mockResolvedValue({
    model: 'e', revision: 'r', failed: [], metrics: {},
    embedded: [vector('candidate-0', [0.9, 0.1]), vector('candidate-1', [0.8, 0.2])],
  });
  rerankVideoIntervals.mockResolvedValue({
    model: 'rr', revision: 'r', failed: [], metrics: {},
    ranked: [{ id: 'candidate-0', score: 0.97 }, { id: 'candidate-1', score: 0.9 }],
  });
}

const memory = (mode: 'visual' | 'both') => rerankSimpleMemCandidates({
  query: 'show where she says goodbye while leaving the room', candidates: memoryCandidates, videoId: 'video-1',
  videoUrl: 'https://signed/proxy.mp4', videoKey: 'proxies/video-1/proxy.mp4', expectedBytes: 1000, mode,
});

describe('3. a memory candidate in both mode is verified with its own transcript', () => {
  it('still embeds and reranks, hands the aligned transcript to the verifier, and rejects a silent candidate', async () => {
    memoryPipeline();
    transcriptOnlyAtGoodbye();
    verifyWithVideoChat3.mockResolvedValue({
      model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', failed: [], metrics: {},
      results: [{ id: 'candidate-0', startSeconds: 30, endSeconds: 36, match: true, confidence: 0.92, description: 'goodbye at the door' }],
    });

    const result = await memory('both');

    expect(embedVideoIntervals).toHaveBeenCalledOnce();
    expect(rerankVideoIntervals).toHaveBeenCalledOnce();
    expect(verifyWithVideoChat3).toHaveBeenCalledOnce();
    expect(verifyWithVideoChat3.mock.calls[0]?.[0].candidates).toEqual([
      { id: 'candidate-0', start: 30, end: 36, transcript: '[30.2-33.8] okay, goodbye everyone' },
    ]);
    expect(result.candidates.map((candidate) => [candidate.startSeconds, candidate.score])).toEqual([[30, 0.92]]);
    expect(result.failed).toContainEqual({ ...memoryCandidates[1], reason: MISSING_TRANSCRIPT_REASON });
  });

  it('never asks the verifier when no candidate has transcript evidence', async () => {
    memoryPipeline();
    const result = await memory('both');
    expect(verifyWithVideoChat3).not.toHaveBeenCalled();
    expect(result.candidates).toEqual([]);
    expect(result.failed.filter((failure) => failure.reason === MISSING_TRANSCRIPT_REASON)).toHaveLength(2);
  });
});

describe('4. a memory candidate in visual mode is verified as before', () => {
  it('adds no transcript requirement', async () => {
    memoryPipeline();
    verifyWithVideoChat3.mockResolvedValue({
      model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', failed: [], metrics: {},
      results: [
        { id: 'candidate-0', startSeconds: 30, endSeconds: 36, match: true, confidence: 0.92, description: 'at the door' },
        { id: 'candidate-1', startSeconds: 10, endSeconds: 15, match: true, confidence: 0.85, description: 'walks out' },
      ],
    });
    const result = await memory('visual');
    expect(listTranscriptSegmentsInRange).not.toHaveBeenCalled();
    expect(verifyWithVideoChat3.mock.calls[0]?.[0].candidates.every((candidate: { transcript?: string }) => candidate.transcript === undefined)).toBe(true);
    expect(result.candidates).toHaveLength(2);
    expect(result.failed).toEqual([]);
  });
});

describe('5 and 6. the one confidence gate applies to mixed verdicts', () => {
  it('rejects match=true just under MIN_MATCH_CONFIDENCE on the whole-video path', async () => {
    wholeVideoPipeline();
    transcriptOnlyAtGoodbye();
    verifyWithVideoChat3.mockResolvedValueOnce({
      model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', failed: [], metrics: {},
      results: [{ id: 'mixed-0', startSeconds: 30, endSeconds: 35, match: true, confidence: MIN - 0.001, description: 'weak' }],
    });
    const analysis = await upload('both');
    expect(analysis.verified).toEqual([]);
    expect((analysis.metrics.mixedVerification as Record<string, unknown>).rejected).toBe(1);
  });

  it('rejects match=true just under MIN_MATCH_CONFIDENCE on the memory path', async () => {
    memoryPipeline();
    transcriptOnlyAtGoodbye();
    verifyWithVideoChat3.mockResolvedValue({
      model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', failed: [], metrics: {},
      results: [{ id: 'candidate-0', startSeconds: 30, endSeconds: 36, match: true, confidence: MIN - 0.001, description: 'weak' }],
    });
    const result = await memory('both');
    expect(result.candidates).toEqual([]);
  });

  it('keeps a verdict at the floor when footage and transcript are both satisfied, and never one that says no match', async () => {
    expect(passesEvidenceGate({ match: true, confidence: MIN })).toBe(true);
    expect(passesEvidenceGate({ match: true, confidence: MIN - 0.001 })).toBe(false);
    expect(passesEvidenceGate({ match: false, confidence: 1 })).toBe(false);

    wholeVideoPipeline();
    transcriptOnlyAtGoodbye();
    verifyWithVideoChat3.mockResolvedValueOnce({
      model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', failed: [], metrics: {},
      results: [{ id: 'mixed-0', startSeconds: 30, endSeconds: 35, match: true, confidence: MIN, description: 'says goodbye while leaving' }],
    });
    const analysis = await upload('both');
    expect(analysis.verified).toEqual([{ startSeconds: 30, endSeconds: 35, confidence: MIN, description: 'says goodbye while leaving' }]);
  });
});

describe('7. one silent candidate does not take the others down, and is not quietly downgraded', () => {
  it('rejects the silent stretch with its reason and keeps the spoken one', async () => {
    wholeVideoPipeline();
    transcriptOnlyAtGoodbye();
    verifyWithVideoChat3.mockResolvedValueOnce({
      model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', failed: [], metrics: {},
      results: [{ id: 'mixed-0', startSeconds: 30, endSeconds: 35, match: true, confidence: 0.88, description: 'goodbye' }],
    });
    const analysis = await upload('both');
    expect(analysis.verified.map((moment) => moment.startSeconds)).toEqual([30]);
    const silent = analysis.failures.find((failure) => failure.startSeconds === 10);
    expect(silent).toEqual({ id: 'mixed-1', reason: MISSING_TRANSCRIPT_REASON, startSeconds: 10, endSeconds: 14 });
    expect((analysis.metrics.mixedVerification as Record<string, unknown>).withoutTranscript).toBe(1);
  });
});

describe('8. speech-only questions keep their path', () => {
  it('resolves to transcript, is refused by memory and by the watcher, and reaches the speech search', async () => {
    expect(resolveSearchMode({ instruction: 'find where he explains the pricing model', requested: 'auto', transcriptAvailable: true }).mode).toBe('transcript');
    expect(decideFallback({ indexState: 'ready', mode: 'transcript', correcting: false })).toMatchObject({ use: 'fallback', reason: 'unsupported_mode' });
    const handler = await read('src/worker/handlers/clipSearch.ts');
    const watcher = handler.slice(handler.indexOf('async function answerFromVideoChat3'), handler.indexOf('async function searchSingleChunk'));
    expect(watcher).toContain("if (input.mode === 'transcript') {");
    expect(watcher).toContain("fallback: 'unsupported_mode'");
    // The invariant guard lets exactly the transcript mode through to the per-chunk search.
    expect(handler).toContain("if (env.RETRIEVAL_PRIMARY === 'videochat3' && resolved.mode !== 'transcript') {");
    expect(handler.indexOf("resolved.mode !== 'transcript') {")).toBeLessThan(handler.indexOf('mapWithConcurrency(chunks, env.OPENROUTER_VIDEO_CONCURRENCY'));
  });
});

describe('9. the SimpleMem v2 contract holds', () => {
  it('a pre-v2 memory cannot be ready, a v2 one can, and a partial-caption one cannot', async () => {
    const migration = await read('src/db/migrations/056_simplemem_embedding_v2.sql');
    expect(migration).toContain("OR config->>'embeddingVersion' = 'v2-transformers457'");
    expect(migration).toContain("WHERE status IN ('ready', 'queued', 'running')");
    const indexing = await read('src/worker/handlers/simplememIndexing.ts');
    expect(indexing).toContain("const EXPECTED_EMBEDDING_VERSION = 'v2-transformers457';");
    expect(indexing).toContain('if (health.embeddingVersion !== EXPECTED_EMBEDDING_VERSION) {');
    expect(indexing).toContain("if (!health.transformersVersion.startsWith('4.57.')) {");
    expect(indexing).toContain('if (reply.captions.failed > 0) {');
    const requirements = await read('tools/simplemem/requirements.txt');
    expect(requirements).toContain('transformers>=4.57.0,<4.58');
    // Invalidated memories are rebuilt, not forgotten.
    expect(await read('src/worker/main.ts')).toContain('listSimpleMemReindexVideoIds(100)');
  });

  it('the sidecar fails closed on any embedding version but the expected one', async () => {
    const sidecar = await read('tools/simplemem/sidecar.py');
    expect(sidecar).toContain('EXPECTED_EMBEDDING_VERSION = "v2-transformers457"');
    expect(sidecar).toContain('if EMBEDDING_VERSION != EXPECTED_EMBEDDING_VERSION:\n    raise RuntimeError(');
    expect(sidecar).not.toContain('"v1").strip() or "v1"');
    expect(await read('Dockerfile.simplemem')).toContain('SIMPLEMEM_EMBEDDING_VERSION=v2-transformers457');
  });

  it('memory silence is never an absence, and every memory candidate is verified against footage', async () => {
    expect(decideFallback({ indexState: 'ready', mode: 'visual', correcting: false, mapping: { candidates: [], ignored: { belowScore: 0, notAFrame: 0, noTimestamp: 0 } } as never }))
      .toMatchObject({ use: 'fallback', reason: 'no_candidates' });
    const rerank = await read('src/services/retrieval/simplemem/rerank.ts');
    expect(rerank).toContain('await verifyWithVideoChat3({');
    expect(rerank).toContain('if (!passesEvidenceGate(verdict)) {');
  });
});

describe('10. a failed watch never falls back to the retired per-chunk watcher', () => {
  const job = { data: { clipRequestId: 'request-1' }, processedOn: Date.now(), timestamp: Date.now(), attemptsMade: 0, updateProgress: vi.fn() };

  it.each(['both', 'visual'] as const)('%s: the request completes with the whole video on record as unexamined', async (kind) => {
    getClipRequest.mockResolvedValue({
      ...request,
      instruction: kind === 'both' ? 'show where she says goodbye while leaving the room' : 'show her leaving the room',
    });
    watchWithVideoChat3.mockRejectedValue(new Error('Modal: videochat3 watch exceeded its function timeout'));

    await handleClipSearch(job as never);

    expect(watchWithVideoChat3).toHaveBeenCalledOnce();
    expect(searchVideoChunk).not.toHaveBeenCalled();
    expect(assertVideoInputSupported).not.toHaveBeenCalled();
    expect(embedVideoIntervals).not.toHaveBeenCalled();
    expect(finishClipRequest).not.toHaveBeenCalledWith(expect.anything(), 'failed', expect.anything(), expect.anything(), expect.anything());
    expect(releaseDeckAndComplete).toHaveBeenCalledWith('request-1', 'attempt-1', 'footage', 'videochat3');
    expect(recordChunkFailure).toHaveBeenCalledTimes(1);
    expect(recordChunkFailure.mock.calls[0]?.[1]).toMatchObject({
      code: 'not_read_yet', globalStartSeconds: 0, globalEndSeconds: 300,
      message: expect.stringContaining('VideoChat3 could not read the video, so nothing in it was examined'),
    });
    expect(recordRetrievalOutcome).toHaveBeenCalledWith('request-1', expect.objectContaining({ primary: 'videochat3', system: 'videochat3' }));
    expect(insertMatches).not.toHaveBeenCalled();
  });

  it('the hand-off that once existed is gone from the handler', async () => {
    const handler = await read('src/worker/handlers/clipSearch.ts');
    const watcher = handler.slice(handler.indexOf('async function answerFromVideoChat3'), handler.indexOf('async function searchSingleChunk'));
    expect(watcher).not.toContain("fallback: 'primary_failed'");
    expect(watcher).not.toContain('using the direct footage search');
    expect(handler).toContain('invariant violated: a ${resolved.mode} question reached the per-chunk footage search');
  });
});

describe('the Modal contract carries the transcript exactly as the client sends it', () => {
  it('TypeScript sends candidates with an optional transcript string; Python reads the same key and caps it the same way', async () => {
    const client = await read('src/services/videochat3/client.ts');
    expect(client).toContain('transcript?: string;');
    expect(client).toContain('candidates: input.candidates,');
    expect(client).toContain('candidate.transcript.length > 12_000');
    const modal = await read('modal/videochat3.py');
    expect(modal).toContain('transcript = candidate.get("transcript")');
    expect(modal).toContain('verdict = self._verify_clip(clip, query, transcript)');
    expect(modal).toContain('transcript_text = (transcript or "").strip()[:12000]');
    expect(modal).toContain('def verify_intervals(\n        self,\n        video_url: str,\n        query: str,\n        candidates: list[dict[str, Any]],\n        expected_bytes: int | None = None,');
  });
});

describe('a moment says which evidence established it', () => {
  const job = { data: { clipRequestId: 'request-1' }, processedOn: Date.now(), timestamp: Date.now(), attemptsMade: 0, updateProgress: vi.fn() };

  it('both: footage judged with its transcript is stored as multimodal', async () => {
    getClipRequest.mockResolvedValue({ ...request });
    wholeVideoPipeline();
    transcriptOnlyAtGoodbye();
    verifyWithVideoChat3.mockResolvedValueOnce({
      model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', failed: [], metrics: {},
      results: [{ id: 'mixed-0', startSeconds: 30, endSeconds: 35, match: true, confidence: 0.9, description: 'says goodbye while leaving' }],
    });

    await handleClipSearch(job as never);

    expect(insertMatches).toHaveBeenCalledOnce();
    const rows = insertMatches.mock.calls[0]?.[1] as Array<Record<string, unknown>>;
    expect(rows.map((row) => [row.globalStartSeconds, row.source])).toEqual([[30, 'multimodal']]);
    expect(searchVideoChunk).not.toHaveBeenCalled();
  });

  it('visual: footage alone is stored as visual', async () => {
    getClipRequest.mockResolvedValue({ ...request, instruction: 'show her leaving the room' });
    wholeVideoPipeline();

    await handleClipSearch(job as never);

    const rows = insertMatches.mock.calls[0]?.[1] as Array<Record<string, unknown>>;
    expect(rows.every((row) => row.source === 'visual')).toBe(true);
    expect(rows).toHaveLength(2);
    expect(listTranscriptSegmentsInRange).not.toHaveBeenCalled();
  });

  it('the memory path labels its moments the same way', async () => {
    const handler = await read('src/worker/handlers/clipSearch.ts');
    const memory = handler.slice(handler.indexOf('async function answerFromSimpleMem'), handler.indexOf('async function answerFromVideoChat3'));
    expect(memory).toContain('source: MATCH_SOURCE[input.mode],');
    const watcher = handler.slice(handler.indexOf('async function answerFromVideoChat3'), handler.indexOf('async function searchSingleChunk'));
    expect(watcher).toContain('source: MATCH_SOURCE[input.mode]');
  });
});
