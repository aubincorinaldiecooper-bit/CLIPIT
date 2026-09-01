import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Covers the shared completion helper's three outcomes: opening the gate,
 * source footage unavailable, and a deck that could not finish. The wiring
 * from answerFromNotes into this helper is NOT covered here.
 */
const listMatches = vi.fn(async () => [{
  id: 'match-1',
  confidence: 0.9,
  globalStartSeconds: 10,
  globalEndSeconds: 30,
}]);
const finishClipRequest = vi.fn(async () => undefined);
const markDeckComplete = vi.fn(async () => true);
const recordDeckAvailability = vi.fn(async () => undefined);
const downloadToFile = vi.fn(async () => undefined);

vi.mock('../src/db/repositories/clipRequests.js', () => ({
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
  markDeckComplete,
  startClipRequest: vi.fn(),
}));

vi.mock('../src/services/storage/s3.js', () => ({
  getStorage: () => ({ downloadToFile }),
}));

const orchestrateVerticalDeck = vi.fn();
vi.mock('../src/services/media/verticalOrchestrator.js', () => ({
  orchestrateVerticalDeck,
}));

const { completeRequestWithDeck } =
  await import('../src/worker/handlers/clipSearch.js');
const { resolvePlatformIntent } =
  await import('../src/services/search/platformIntent.js');

const intent = resolvePlatformIntent('find me 3 moments I can post on TikTok', 90);
const request = {
  id: 'request-1',
  videoId: 'video-1',
  sessionId: null,
  userId: null,
  workspaceId: null,
  instruction: 'find me 3 moments I can post on TikTok',
};
const video = {
  id: 'video-1',
  originalStorageKey: 'originals/video-1/source.mp4',
  hasAudio: true,
  durationSeconds: 90,
};
const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;
const tally = { add: vi.fn(), summary: vi.fn(() => ({})) } as any;

beforeEach(() => {
  vi.clearAllMocks();
  listMatches.mockResolvedValue([{
    id: 'match-1',
    confidence: 0.9,
    globalStartSeconds: 10,
    globalEndSeconds: 30,
  }]);
  orchestrateVerticalDeck.mockResolvedValue({
    outcome: {
      complete: true,
      deck: [{
        matchId: 'match-1',
        derivativeStatus: 'ready',
        derivativeStorageKey: 'clips/video-1/clip-1-vertical.mp4',
        posterStorageKey: 'posters/video-1/clip-1.jpg',
      }],
      failed: [],
    },
    metrics: {
      failedCandidateCount: 0,
      renderedButSkippedCount: 0,
      timeToCompleteDeckMs: 1,
    },
  });
});

describe('the deck gate every finished request passes through', () => {
  it('orchestrates the deck and completes the request when notes found matches', async () => {
    const result = await completeRequestWithDeck({
      clipRequestId: 'request-1',
      request: request as any,
      video: video as any,
      intent,
      workDir: '/tmp',
      log,
      tally,
      answeredFrom: 'notes',
      deckAttemptId: 'attempt-1',
      deckStartedAtMs: 0,
    });

    expect(result.completed).toBe(true);
    expect(orchestrateVerticalDeck).toHaveBeenCalled();
    // Fenced: the gate opens only for the attempt that planned this deck.
    expect(markDeckComplete).toHaveBeenCalledWith('request-1', 'attempt-1');
    expect(finishClipRequest).toHaveBeenCalledWith('request-1', 'completed', null, 'notes');
  });

  it('fails without opening the gate when the original source is missing', async () => {
    const result = await completeRequestWithDeck({
      clipRequestId: 'request-1',
      request: request as any,
      video: { ...video, originalStorageKey: null } as any,
      intent,
      workDir: '/tmp',
      log,
      tally,
      answeredFrom: 'notes',
      deckAttemptId: 'attempt-1',
      deckStartedAtMs: 0,
    });

    expect(result.completed).toBe(false);
    expect(finishClipRequest).toHaveBeenCalledWith(
      'request-1',
      'failed',
      'The original video is no longer available, so these moments could not be made ready to post.',
    );
    expect(markDeckComplete).not.toHaveBeenCalled();
    expect(orchestrateVerticalDeck).not.toHaveBeenCalled();
  });

  it('fails without opening the gate when a non-empty deck cannot finish', async () => {
    orchestrateVerticalDeck.mockResolvedValueOnce({
      outcome: { complete: false, deck: [], failed: [{ matchId: 'match-1' }] },
      metrics: {
        failedCandidateCount: 1,
        renderedButSkippedCount: 0,
        timeToCompleteDeckMs: null,
      },
    });

    const result = await completeRequestWithDeck({
      clipRequestId: 'request-1',
      request: request as any,
      video: video as any,
      intent,
      workDir: '/tmp',
      log,
      tally,
      answeredFrom: 'notes',
      deckAttemptId: 'attempt-1',
      deckStartedAtMs: 0,
    });

    expect(result.completed).toBe(false);
    expect(finishClipRequest).toHaveBeenCalledWith(
      'request-1',
      'failed',
      'We found the moments but could not finish making them ready to post. Please try again.',
    );
    expect(markDeckComplete).not.toHaveBeenCalled();
  });
});

describe('a superseded attempt stands down', () => {
  /**
   * A stalled job redelivered mid-assembly means two runs exist. The second
   * re-plans and takes a new token; the first, still executing, reaches the
   * gate holding a token that is no longer current.
   *
   * It must open nothing AND complete nothing — finishing the request here
   * would mark it done over the other run's half-built deck, which is the
   * same partial reveal by a different route.
   */
  it('neither opens the gate nor completes the request', async () => {
    markDeckComplete.mockResolvedValueOnce(false as never);
    finishClipRequest.mockClear();

    const result = await completeRequestWithDeck({
      clipRequestId: 'request-1',
      request: request as any,
      video: video as any,
      intent,
      workDir: '/tmp',
      log,
      tally,
      answeredFrom: 'footage',
      deckAttemptId: 'stale-attempt',
      deckStartedAtMs: 0,
    });

    expect(result.completed).toBe(false);
    expect(finishClipRequest).not.toHaveBeenCalled();
  });
});
