import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A search finishes when its moments have their pictures — and nothing else.
 *
 * The session that decided this: four moments found in fifteen seconds and
 * shown after four and a half minutes, because every one of them was cut,
 * framed and encoded first, one after another, and three of the four were
 * then thrown away. These tests pin the boundary that replaced it: the
 * request completes on find, releases every moment it found, and renders
 * nothing. Production is Keep's job (see keepApproval.test).
 */

const listMatches = vi.fn(async (): Promise<Array<Record<string, unknown>>> => []);
const finishClipRequest = vi.fn(async () => true);
const releaseDeckAndComplete = vi.fn(async () => true);
const recordDeckAvailability = vi.fn(async () => undefined);
const recordConversationalAnswer = vi.fn(async () => true);
const getClipRequest = vi.fn(async () => ({
  id: 'request-1', videoId: 'video-1', instruction: 'find it', chunksFailed: 0,
}));

vi.mock('../src/db/repositories/clipRequests.js', () => ({
  claimClipRequestAttempt: vi.fn(),
  finishClipRequest,
  getClipRequest,
  getPreviousClipRequest: vi.fn(),
  insertMatches: vi.fn(),
  listMatches,
  recordChunkCompleted: vi.fn(),
  recordChunkDegraded: vi.fn(),
  recordChunkFailure: vi.fn(),
  recordConversationalAnswer,
  recordDeckAvailability,
  recordDeckPlan: vi.fn(),
  recordRetrievalOutcome: vi.fn(async () => undefined),
  recordSearchApproach: vi.fn(),
  recordUncertainMatches: vi.fn(),
  releaseDeckAndComplete,
  startClipRequest: vi.fn(),
}));

const writeConversationalAnswer = vi.fn(async () => ({
  text: 'It happens at 00:00.', citationIds: [], provider: 'openrouter' as const,
  model: 'qwen/qwen3.6-flash', promptVersion: 'prompt-v1',
}));
vi.mock('../src/services/search/conversationalAnswer.js', () => ({ writeConversationalAnswer }));

const downloadToFile = vi.fn(async () => undefined);
const uploadFile = vi.fn(async () => undefined);
vi.mock('../src/services/storage/s3.js', () => ({
  getStorage: () => ({ downloadToFile, uploadFile }),
}));

// The render queue must not even be reachable from a search's completion.
const enqueueClipGeneration = vi.fn();
vi.mock('../src/queues/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/queues/index.js')>();
  return { ...actual, enqueueClipGeneration };
});
// Nor the framing call: no moment is framed until somebody keeps it.
const askModelForFraming = vi.fn();
vi.mock('../src/services/media/framing.js', () => ({ askModelForFraming }));

const { completeRequest } = await import('../src/worker/handlers/clipSearch.js');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

const moments = (count: number, durationSeconds = 20) =>
  Array.from({ length: count }, (_, index) => ({
    id: `match-${index + 1}`,
    confidence: 0.9 - index * 0.1,
    globalStartSeconds: index * 30,
    globalEndSeconds: index * 30 + durationSeconds,
  }));

const complete = (over: Partial<Parameters<typeof completeRequest>[0]> = {}) =>
  completeRequest({ clipRequestId: 'request-1', answeredFrom: 'notes', deckAttemptId: 'attempt-1', requestedResultCount: null, log, ...over });

beforeEach(() => {
  vi.clearAllMocks();
  releaseDeckAndComplete.mockResolvedValue(true);
  recordConversationalAnswer.mockResolvedValue(true);
  writeConversationalAnswer.mockResolvedValue({
    text: 'It happens at 00:00.', citationIds: [], provider: 'openrouter' as const,
    model: 'qwen/qwen3.6-flash', promptVersion: 'prompt-v1',
  });
});

describe('a search completes on find', () => {
  it('releases every moment it found, and renders nothing', async () => {
    listMatches.mockResolvedValue(moments(4));

    const released = await complete();

    expect(released).toBe(true);
    // Which system answered goes in with the release, in one fenced
    // statement: written before it, a superseded attempt would name a system
    // for an answer nobody saw; written after, a worker that stops in between
    // loses it for good, because a completed request cannot be re-claimed.
    expect(releaseDeckAndComplete).toHaveBeenCalledWith('request-1', 'attempt-1', 'notes', 'clipit');
    expect(writeConversationalAnswer).toHaveBeenCalledOnce();
    expect(recordConversationalAnswer).toHaveBeenCalledWith(
      'request-1',
      'attempt-1',
      expect.objectContaining({ model: 'qwen/qwen3.6-flash' }),
    );
    // What was found is what is shown: four, not a deck target of three.
    expect(recordDeckAvailability).toHaveBeenCalledWith(
      'request-1',
      { availableCandidateCount: 4, effectiveDeckTarget: 4 },
      'attempt-1',
    );
    // Not a single byte of the source, not a single frame judged, not a
    // single render.
    expect(downloadToFile).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(askModelForFraming).not.toHaveBeenCalled();
    expect(enqueueClipGeneration).not.toHaveBeenCalled();
    expect(finishClipRequest).not.toHaveBeenCalled();
  });

  it('shows everything when the question wrote no number — a singular "the moment" included', async () => {
    // "the moment where the cigar is smoked" found two; both are the answer.
    listMatches.mockResolvedValue(moments(2));

    await complete({ requestedResultCount: null });

    expect(recordDeckAvailability).toHaveBeenCalledWith(
      'request-1',
      { availableCandidateCount: 2, effectiveDeckTarget: 2 },
      'attempt-1',
    );
  });

  it('respects a number the person wrote: "give me 3" of five found shows three, and records both facts', async () => {
    listMatches.mockResolvedValue(moments(5));

    await complete({ requestedResultCount: 3 });

    expect(recordDeckAvailability).toHaveBeenCalledWith(
      'request-1',
      { availableCandidateCount: 5, effectiveDeckTarget: 3 },
      'attempt-1',
    );
  });

  it('gives the answer model the same highest-confidence moments the screen shows', async () => {
    listMatches.mockResolvedValue([
      ...moments(1).map((item) => ({ ...item, id: 'early', confidence: 0.2 })),
      ...moments(1).map((item) => ({ ...item, id: 'strong', confidence: 0.95, globalStartSeconds: 60 })),
    ]);

    await complete({ requestedResultCount: 1 });

    expect(writeConversationalAnswer).toHaveBeenCalledWith(expect.objectContaining({
      evidence: [expect.objectContaining({ id: 'strong' })],
    }));
  });

  it('asks the effective prior question when the stored request is a correction', async () => {
    listMatches.mockResolvedValue(moments(1));

    await complete({ question: 'Where does the price appear?' });

    expect(writeConversationalAnswer).toHaveBeenCalledWith(expect.objectContaining({
      question: 'Where does the price appear?',
    }));
  });

  it('passes retrieval-specific partial coverage to the answer model', async () => {
    listMatches.mockResolvedValue(moments(1));

    await complete({ coverageNote: 'Only the first 100 of 900 seconds were remembered.' });

    expect(writeConversationalAnswer).toHaveBeenCalledWith(expect.objectContaining({
      coverageNote: 'Only the first 100 of 900 seconds were remembered.',
    }));
  });

  it('combines retrieval and reranker coverage limitations', async () => {
    listMatches.mockResolvedValue(moments(1));
    getClipRequest.mockResolvedValueOnce({
      id: 'request-1', videoId: 'video-1', instruction: 'find it', chunksFailed: 2,
    });

    await complete({ coverageNote: 'Omni-SimpleMem only examined the first 100 of 900 seconds.' });

    expect(writeConversationalAnswer).toHaveBeenCalledWith(expect.objectContaining({
      coverageNote: 'Omni-SimpleMem only examined the first 100 of 900 seconds. 2 section(s) of the video could not be examined.',
    }));
  });

  it('releases found moments with a grounded fallback when answer prose fails', async () => {
    listMatches.mockResolvedValue(moments(2));
    writeConversationalAnswer.mockRejectedValueOnce(new Error('answer provider unavailable'));

    const released = await complete();

    expect(released).toBe(true);
    expect(recordConversationalAnswer).toHaveBeenCalledWith('request-1', 'attempt-1', {
      text: 'Found 2 verified moments.',
      citationIds: ['match-1', 'match-2'],
      provider: 'clipit',
      model: 'deterministic-fallback',
      promptVersion: 'answer-fallback-v1',
    });
    expect(releaseDeckAndComplete).toHaveBeenCalledOnce();
  });

  it('never pads a written number: three asked for and two found is two', async () => {
    listMatches.mockResolvedValue(moments(2));

    await complete({ requestedResultCount: 3 });

    expect(recordDeckAvailability).toHaveBeenCalledWith(
      'request-1',
      { availableCandidateCount: 2, effectiveDeckTarget: 2 },
      'attempt-1',
    );
  });

  it('keeps a moment longer than any platform would take — whether it exists is a different question from whether it suits TikTok', async () => {
    listMatches.mockResolvedValue(moments(1, 200));

    await complete({ answeredFrom: 'footage' });

    expect(recordDeckAvailability).toHaveBeenCalledWith(
      'request-1',
      { availableCandidateCount: 1, effectiveDeckTarget: 1 },
      'attempt-1',
    );
  });

  it('completes truthfully with zero moments, and never fails the request for it', async () => {
    listMatches.mockResolvedValue([]);

    const released = await complete({ answeredFrom: 'footage' });

    expect(released).toBe(true);
    expect(releaseDeckAndComplete).toHaveBeenCalledWith('request-1', 'attempt-1', 'footage', 'clipit');
    expect(recordDeckAvailability).toHaveBeenCalledWith(
      'request-1',
      { availableCandidateCount: 0, effectiveDeckTarget: 0 },
      'attempt-1',
    );
    expect(finishClipRequest).not.toHaveBeenCalled();
  });

  it('needs no source footage to complete — the moments are coordinates, not files', async () => {
    listMatches.mockResolvedValue(moments(1));

    const released = await complete();

    expect(released).toBe(true);
    expect(downloadToFile).not.toHaveBeenCalled();
  });
});

describe('a superseded attempt stands down', () => {
  it('releases nothing and completes nothing when its token has been replaced', async () => {
    listMatches.mockResolvedValue(moments(3));
    releaseDeckAndComplete.mockResolvedValue(false);

    const released = await complete({ deckAttemptId: 'stale' });

    expect(released).toBe(false);
    expect(finishClipRequest).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'answer was superseded before it could be released',
      expect.objectContaining({ clipRequestId: 'request-1' }),
    );
  });

  it('holds no claim, releases nothing', async () => {
    listMatches.mockResolvedValue(moments(3));

    const released = await complete({ deckAttemptId: null });

    expect(released).toBe(false);
    expect(releaseDeckAndComplete).not.toHaveBeenCalled();
  });
});
