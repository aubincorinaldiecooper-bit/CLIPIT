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
const finishClipRequest = vi.fn(async () => true);
const releaseDeckAndComplete = vi.fn(async () => true);
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
  releaseDeckAndComplete,
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
    // Released and completed in ONE fenced statement. As two writes there was
    // an instant where the deck was on the creator's screen and the request
    // still said 'searching' — which a stale delivery could claim into and
    // rebuild underneath them.
    expect(releaseDeckAndComplete).toHaveBeenCalledWith('request-1', 'attempt-1', 'notes');
    expect(finishClipRequest).not.toHaveBeenCalled();
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
      null,
      'attempt-1',
    );
    expect(releaseDeckAndComplete).not.toHaveBeenCalled();
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
      null,
      'attempt-1',
    );
    expect(releaseDeckAndComplete).not.toHaveBeenCalled();
  });
});

/**
 * The owner's rule (2026-09-02): a moment is cut the moment it is found,
 * whatever framing was asked for. A plain question used to complete through
 * the status write with nothing cut behind it; now it owes a deck like any
 * platform question, and only what the deck delivers differs.
 */
describe('an original-framing request is cut on find too', () => {
  const plain = resolvePlatformIntent('find the funny moments', 90);
  const counted = resolvePlatformIntent('give me 2 funny moments', 90);
  const fourMatches = [0.9, 0.8, 0.7, 0.6].map((confidence, index) => ({
    id: `match-${index + 1}`,
    confidence,
    globalStartSeconds: index * 20,
    globalEndSeconds: index * 20 + 15,
  }));

  it('builds an original-framing deck and releases it through the gate', async () => {
    const result = await completeRequestWithDeck({
      clipRequestId: 'request-1',
      request: request as any,
      video: video as any,
      intent: plain,
      workDir: '/tmp',
      log,
      tally,
      answeredFrom: 'footage',
      deckAttemptId: 'attempt-1',
      deckStartedAtMs: 0,
    });

    expect(result.completed).toBe(true);
    expect(orchestrateVerticalDeck).toHaveBeenCalledWith(expect.objectContaining({ presentation: 'original' }));
    // Same door as a vertical deck: released and completed in one statement,
    // never the plain status write that used to answer these questions.
    expect(releaseDeckAndComplete).toHaveBeenCalledWith('request-1', 'attempt-1', 'footage');
    expect(finishClipRequest).not.toHaveBeenCalled();
  });

  it('owes no derivative for its candidates', async () => {
    await completeRequestWithDeck({
      clipRequestId: 'request-1', request: request as any, video: video as any, intent: plain,
      workDir: '/tmp', log, tally, answeredFrom: 'notes', deckAttemptId: 'attempt-1', deckStartedAtMs: 0,
    });
    const input = orchestrateVerticalDeck.mock.calls[0]![0] as { candidates: Array<{ derivativeStatus: unknown }> };
    expect(input.candidates.map((c) => c.derivativeStatus)).toEqual([null]);
  });

  it('cuts every moment it found when the question named no number', async () => {
    listMatches.mockResolvedValue(fourMatches as never);
    await completeRequestWithDeck({
      clipRequestId: 'request-1', request: request as any, video: video as any, intent: plain,
      workDir: '/tmp', log, tally, answeredFrom: 'footage', deckAttemptId: 'attempt-1', deckStartedAtMs: 0,
    });
    // "Find the funny moments" used to show all four; cutting all four is
    // what keeps that answer whole.
    expect(recordDeckAvailability).toHaveBeenCalledWith(
      'request-1',
      { availableCandidateCount: 4, effectiveDeckTarget: 4 },
      'attempt-1',
    );
    expect(orchestrateVerticalDeck).toHaveBeenCalledWith(expect.objectContaining({ effectiveDeckTarget: 4 }));
  });

  it('cuts the number asked for when the question named one', async () => {
    listMatches.mockResolvedValue(fourMatches as never);
    await completeRequestWithDeck({
      clipRequestId: 'request-1', request: request as any, video: video as any, intent: counted,
      workDir: '/tmp', log, tally, answeredFrom: 'footage', deckAttemptId: 'attempt-1', deckStartedAtMs: 0,
    });
    expect(recordDeckAvailability).toHaveBeenCalledWith(
      'request-1',
      { availableCandidateCount: 4, effectiveDeckTarget: 2 },
      'attempt-1',
    );
  });

  it('keeps a platform question at its default of three when no number was named', async () => {
    listMatches.mockResolvedValue(fourMatches as never);
    await completeRequestWithDeck({
      clipRequestId: 'request-1', request: request as any, video: video as any,
      intent: resolvePlatformIntent('find me moments to post on TikTok', 90),
      workDir: '/tmp', log, tally, answeredFrom: 'footage', deckAttemptId: 'attempt-1', deckStartedAtMs: 0,
    });
    expect(recordDeckAvailability).toHaveBeenCalledWith(
      'request-1',
      { availableCandidateCount: 4, effectiveDeckTarget: 3 },
      'attempt-1',
    );
  });

  it('tells the creator when the footage is gone, exactly as a vertical deck does', async () => {
    const result = await completeRequestWithDeck({
      clipRequestId: 'request-1', request: request as any,
      video: { ...video, originalStorageKey: null } as any, intent: plain,
      workDir: '/tmp', log, tally, answeredFrom: 'footage', deckAttemptId: 'attempt-1', deckStartedAtMs: 0,
    });
    expect(result.completed).toBe(false);
    expect(finishClipRequest).toHaveBeenCalledWith(
      'request-1', 'failed', expect.stringContaining('no longer available'), null, 'attempt-1',
    );
    expect(releaseDeckAndComplete).not.toHaveBeenCalled();
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
    releaseDeckAndComplete.mockResolvedValueOnce(false as never);
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
