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

vi.mock('../src/db/repositories/clipRequests.js', () => ({
  claimClipRequestAttempt: vi.fn(),
  finishClipRequest,
  getClipRequest: vi.fn(),
  getPreviousClipRequest: vi.fn(),
  insertMatches: vi.fn(),
  listMatches,
  recordChunkCompleted: vi.fn(),
  recordChunkDegraded: vi.fn(),
  recordChunkFailure: vi.fn(),
  recordDeckAvailability,
  recordDeckPlan: vi.fn(),
  recordSearchApproach: vi.fn(),
  recordUncertainMatches: vi.fn(),
  releaseDeckAndComplete,
  startClipRequest: vi.fn(),
}));

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

const { completeRequest } = await import('../src/worker/handlers/clipSearch.js');

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;

const moments = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    id: `match-${index + 1}`,
    confidence: 0.9 - index * 0.1,
    globalStartSeconds: index * 30,
    globalEndSeconds: index * 30 + 20,
  }));

beforeEach(() => {
  vi.clearAllMocks();
  releaseDeckAndComplete.mockResolvedValue(true);
});

describe('a search completes on find', () => {
  it('releases every moment it found, and renders nothing', async () => {
    listMatches.mockResolvedValue(moments(4));

    const released = await completeRequest({ clipRequestId: 'request-1', answeredFrom: 'notes', deckAttemptId: 'attempt-1', log });

    expect(released).toBe(true);
    expect(releaseDeckAndComplete).toHaveBeenCalledWith('request-1', 'attempt-1', 'notes');
    // What was found is what is shown: four, not a deck target of three.
    expect(recordDeckAvailability).toHaveBeenCalledWith(
      'request-1',
      { availableCandidateCount: 4, effectiveDeckTarget: 4 },
      'attempt-1',
    );
    // Not a single byte of the source, and not a single render.
    expect(downloadToFile).not.toHaveBeenCalled();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(enqueueClipGeneration).not.toHaveBeenCalled();
    expect(finishClipRequest).not.toHaveBeenCalled();
  });

  it('does not cap what is shown to the number the question named', async () => {
    // "the moment where the cigar is smoked" found two; both are the answer.
    listMatches.mockResolvedValue(moments(2));

    await completeRequest({ clipRequestId: 'request-1', answeredFrom: 'notes', deckAttemptId: 'attempt-1', log });

    expect(recordDeckAvailability).toHaveBeenCalledWith(
      'request-1',
      expect.objectContaining({ effectiveDeckTarget: 2 }),
      'attempt-1',
    );
  });

  it('completes truthfully with zero moments, and never fails the request for it', async () => {
    listMatches.mockResolvedValue([]);

    const released = await completeRequest({ clipRequestId: 'request-1', answeredFrom: 'footage', deckAttemptId: 'attempt-1', log });

    expect(released).toBe(true);
    expect(releaseDeckAndComplete).toHaveBeenCalledWith('request-1', 'attempt-1', 'footage');
    expect(recordDeckAvailability).toHaveBeenCalledWith(
      'request-1',
      { availableCandidateCount: 0, effectiveDeckTarget: 0 },
      'attempt-1',
    );
    expect(finishClipRequest).not.toHaveBeenCalled();
  });

  it('needs no source footage to complete — the moments are coordinates, not files', async () => {
    listMatches.mockResolvedValue(moments(1));

    const released = await completeRequest({ clipRequestId: 'request-1', answeredFrom: 'notes', deckAttemptId: 'attempt-1', log });

    expect(released).toBe(true);
    expect(downloadToFile).not.toHaveBeenCalled();
  });
});

describe('a superseded attempt stands down', () => {
  it('releases nothing and completes nothing when its token has been replaced', async () => {
    listMatches.mockResolvedValue(moments(3));
    releaseDeckAndComplete.mockResolvedValue(false);

    const released = await completeRequest({ clipRequestId: 'request-1', answeredFrom: 'notes', deckAttemptId: 'stale', log });

    expect(released).toBe(false);
    expect(finishClipRequest).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith(
      'answer was superseded before it could be released',
      expect.objectContaining({ clipRequestId: 'request-1' }),
    );
  });

  it('holds no claim, releases nothing', async () => {
    listMatches.mockResolvedValue(moments(3));

    const released = await completeRequest({ clipRequestId: 'request-1', answeredFrom: 'notes', deckAttemptId: null, log });

    expect(released).toBe(false);
    expect(releaseDeckAndComplete).not.toHaveBeenCalled();
  });
});
