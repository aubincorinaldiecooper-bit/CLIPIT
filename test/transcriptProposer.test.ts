import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Speech proposes too. Under a `both` question where either source may
 * establish a moment, the transcript names its own candidates — a quoted
 * phrase looked up directly, or the retained transcript-only per-chunk
 * search — and VideoChat3 re-opens each with its footage and its aligned
 * transcript. Nothing here is evidence until that verdict passes the gate.
 */

const listTranscriptSegments = vi.fn();
const listTranscriptSegmentsInRange = vi.fn();
const verifyWithVideoChat3 = vi.fn();
vi.mock('../src/db/repositories/transcripts.js', () => ({ listTranscriptSegments, listTranscriptSegmentsInRange }));
vi.mock('../src/services/videochat3/client.js', () => ({ verifyWithVideoChat3 }));

const { env } = await import('../src/config/env.js');
const {
  MAX_SPOKEN_PROPOSALS, describeSpokenFailure, findPhraseWindows, proposalsFromTextSearch, proposeSpokenMoments, quotedPhrases, rankProposals,
  speechTokens, speechUnsearched,
} = await import('../src/services/retrieval/transcriptProposer.js');
const { MISSING_TRANSCRIPT_REASON } = await import('../src/services/retrieval/mixedEvidence.js');

const segment = (index: number, start: number, end: number, text: string) => ({
  id: `seg-${index}`, videoId: 'video-1', segmentIndex: index, startSeconds: start, endSeconds: end, text, source: 'openrouter_stt' as const,
});
const transcript = [
  segment(0, 0, 4, 'Okay everyone, welcome back.'),
  segment(1, 4, 9, 'Today we have some news: we are'),
  segment(2, 9, 12, 'shutting it down, for good.'),
  segment(3, 200, 204, 'And yes — WE ARE SHUTTING IT DOWN.'),
];
const chunk = (index: number, start: number, end: number) => ({
  id: `chunk-${index}`, videoId: 'video-1', chunkIndex: index, globalStartSeconds: start, globalEndSeconds: end,
  durationSeconds: end - start, storageKey: `chunks/${index}.mp4`, createdAt: new Date(0),
}) as any;
const chunks = [chunk(0, 0, 120), chunk(1, 120, 240), chunk(2, 240, 300)];

describe('what a question quotes', () => {
  it('reads double, curly and single quotes, and leaves apostrophes alone', () => {
    expect(quotedPhrases('Find "we are shutting it down"')).toEqual(['we are shutting it down']);
    expect(quotedPhrases('the part where she says “goodbye everyone” on the banner')).toEqual(['goodbye everyone']);
    expect(quotedPhrases("find 'no way' and \"really\"")).toEqual(['really', 'no way']);
    expect(quotedPhrases("the bit where he's done and isn't happy")).toEqual([]);
    expect(quotedPhrases('the good bit')).toEqual([]);
  });

  it('hears words, not punctuation or case', () => {
    expect(speechTokens('And yes — WE ARE SHUTTING IT DOWN.')).toEqual(['and', 'yes', 'we', 'are', 'shutting', 'it', 'down']);
    expect(speechTokens("It's ‘fine’, isn't it?")).toEqual(["it's", 'fine', "isn't", 'it']);
  });
});

describe('where the transcript says the phrase', () => {
  it('finds every occurrence, across a segment boundary too, with room either side', () => {
    const windows = findPhraseWindows(transcript, 'we are shutting it down', 300);
    expect(windows).toEqual([
      { startSeconds: 2.5, endSeconds: 13.5, text: 'Today we have some news: we are shutting it down, for good.' },
      { startSeconds: 198.5, endSeconds: 205.5, text: 'And yes — WE ARE SHUTTING IT DOWN.' },
    ]);
  });

  it('widens a very short line to a watchable clip and never runs past the video', () => {
    const [window] = findPhraseWindows([segment(0, 299.2, 299.8, 'bye')], 'bye', 300);
    expect(window).toEqual({ startSeconds: 297, endSeconds: 300, text: 'bye' });
    expect(findPhraseWindows([segment(0, 0.1, 0.4, 'hi')], 'hi', 300)).toEqual([{ startSeconds: 0, endSeconds: 3, text: 'hi' }]);
  });

  it('finds nothing when the words are not there in that order', () => {
    expect(findPhraseWindows(transcript, 'down shutting we', 300)).toEqual([]);
    expect(findPhraseWindows(transcript, '', 300)).toEqual([]);
  });
});

describe('ranking proposals', () => {
  it('puts direct phrase hits ahead of the text search, strongest first, and caps the count', () => {
    const many = Array.from({ length: MAX_SPOKEN_PROPOSALS + 5 }, (_, index) => ({
      id: `spoken-text-${index}`, startSeconds: index * 10, endSeconds: index * 10 + 5, text: 't', confidence: index / 100, origin: 'text_search' as const,
    }));
    const ranked = rankProposals([...many, { id: 'spoken-phrase-0', startSeconds: 1, endSeconds: 4, text: 'p', confidence: null, origin: 'quoted_phrase' }]);
    expect(ranked).toHaveLength(MAX_SPOKEN_PROPOSALS);
    expect(ranked[0]?.origin).toBe('quoted_phrase');
    expect(ranked[1]?.confidence).toBe((MAX_SPOKEN_PROPOSALS + 4) / 100);
  });

  it('turns the text search\'s matches into proposals that keep the spoken words', () => {
    expect(proposalsFromTextSearch([
      { chunkId: 'c', localStartSeconds: 0, localEndSeconds: 5, globalStartSeconds: 120, globalEndSeconds: 125, description: 'd', confidence: 0.7, source: 'transcript', quote: 'we are shutting it down' },
      { chunkId: 'c', localStartSeconds: 9, localEndSeconds: 9, globalStartSeconds: 129, globalEndSeconds: 129, description: 'empty', confidence: 0.9, source: 'transcript' },
    ])).toEqual([
      { id: 'spoken-text-0', startSeconds: 120, endSeconds: 125, text: 'we are shutting it down', confidence: 0.7, origin: 'text_search' },
    ]);
  });
});

describe('proposeSpokenMoments', () => {
  const textSearch = vi.fn();
  const propose = (instruction: string) => proposeSpokenMoments({
    videoId: 'video-1', instruction, chunks, durationSeconds: 300, videoUrl: 'https://signed/proxy.mp4', expectedBytes: 10,
    textSearch, concurrency: 2,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    listTranscriptSegments.mockResolvedValue(transcript);
    listTranscriptSegmentsInRange.mockImplementation(async (_id: string, start: number, end: number) =>
      transcript.filter((row) => row.endSeconds > start && row.startSeconds < end),
    );
    verifyWithVideoChat3.mockImplementation(async (input: { candidates: Array<{ id: string; start: number; end: number }> }) => ({
      model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', failed: [], metrics: { verify: true },
      results: input.candidates.map((candidate) => ({
        id: candidate.id, startSeconds: candidate.start, endSeconds: candidate.end, match: true, confidence: 0.88, description: 'he says it',
      })),
    }));
  });

  it('a quoted phrase is looked up directly, never sent to a model, and each hit is judged with its footage and transcript', async () => {
    const result = await propose('find "we are shutting it down"');
    expect(textSearch).not.toHaveBeenCalled();
    expect(listTranscriptSegments).toHaveBeenCalledWith('video-1');
    const sent = verifyWithVideoChat3.mock.calls[0]?.[0].candidates;
    expect(sent.map((candidate: { id: string; start: number; end: number }) => [candidate.start, candidate.end])).toEqual([[2.5, 13.5], [198.5, 205.5]]);
    expect(sent.every((candidate: { transcript?: string }) => typeof candidate.transcript === 'string' && candidate.transcript.length > 0)).toBe(true);
    expect(result.moments.map((moment) => [moment.startSeconds, moment.source, moment.quote])).toEqual([
      [2.5, 'multimodal', 'Today we have some news: we are shutting it down, for good.'],
      [198.5, 'multimodal', 'And yes — WE ARE SHUTTING IT DOWN.'],
    ]);
    expect(result.moments[0]).toMatchObject({ provider: 'modal', model: 'MCG-NJU/VideoChat3-4B', confidence: 0.88 });
    expect(result.failures).toEqual([]);
    expect(result.metrics).toMatchObject({ origin: 'quoted_phrase', proposals: 2, verified: 2, rejected: 0 });
  });

  it('an undetermined question runs the transcript-only search where someone speaks and takes what it names', async () => {
    textSearch.mockImplementation(async (chunk: { chunkIndex: number }) => chunk.chunkIndex === 1
      ? [{ chunkId: 'chunk-1', localStartSeconds: 78, localEndSeconds: 86, globalStartSeconds: 198, globalEndSeconds: 206, description: 'the announcement', confidence: 0.7, source: 'transcript', quote: 'we are shutting it down' }]
      : []);
    const result = await propose('the big moment');
    // Chunks 0 and 1 carry speech; nobody speaks in chunk 2, so no model is asked about it.
    expect(textSearch).toHaveBeenCalledTimes(2);
    expect(textSearch.mock.calls.map((call) => call[0].chunkIndex)).toEqual([0, 1]);
    expect(verifyWithVideoChat3.mock.calls[0]?.[0].candidates).toHaveLength(1);
    expect(result.moments.map((moment) => [moment.startSeconds, moment.quote])).toEqual([[198, 'we are shutting it down']]);
    expect(result.metrics).toMatchObject({ origin: 'text_search', chunks: 3, silentChunks: 1, proposals: 1, verified: 1 });
  });

  it('a verdict under the floor, or no match, is not a moment', async () => {
    verifyWithVideoChat3.mockResolvedValue({
      model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', failed: [], metrics: {},
      results: [
        { id: 'spoken-phrase-0', startSeconds: 2.5, endSeconds: 13.5, match: true, confidence: env.MIN_MATCH_CONFIDENCE - 0.001, description: 'weak' },
        { id: 'spoken-phrase-1', startSeconds: 198.5, endSeconds: 205.5, match: false, confidence: 0.9, description: 'no' },
      ],
    });
    const result = await propose('find "we are shutting it down"');
    expect(result.moments).toEqual([]);
    expect(result.metrics).toMatchObject({ verified: 0, rejected: 2 });
  });

  it('a chunk the text search could not read, or a proposal the verifier could not judge, is a named gap', async () => {
    textSearch.mockImplementation(async (chunk: { chunkIndex: number }) => {
      if (chunk.chunkIndex === 1) throw new Error('OpenRouter 503');
      return chunk.chunkIndex === 0
        ? [{ chunkId: 'chunk-0', localStartSeconds: 4, localEndSeconds: 12, globalStartSeconds: 4, globalEndSeconds: 12, description: 'news', confidence: 0.8, source: 'transcript', quote: 'we are shutting it down' }]
        : [];
    });
    verifyWithVideoChat3.mockResolvedValue({
      model: 'MCG-NJU/VideoChat3-4B', revision: 'vc3', metrics: {}, results: [],
      failed: [{ id: 'spoken-text-0', reason: 'ffmpeg exited 1' }],
    });
    const result = await propose('the big moment');
    expect(result.moments).toEqual([]);
    expect(result.failures).toEqual([
      { kind: 'unsearched', startSeconds: 120, endSeconds: 240, reason: 'transcript search failed: OpenRouter 503' },
      { kind: 'unverified', startSeconds: 4, endSeconds: 12, reason: 'VideoChat3 verification failed: ffmpeg exited 1' },
    ]);
  });

  it('a proposal whose window somehow has no transcript is rejected, never judged on the picture', async () => {
    listTranscriptSegmentsInRange.mockResolvedValue([]);
    textSearch.mockImplementation(async (chunk: { chunkIndex: number }) => chunk.chunkIndex === 0
      ? [{ chunkId: 'chunk-0', localStartSeconds: 50, localEndSeconds: 55, globalStartSeconds: 50, globalEndSeconds: 55, description: 'guess', confidence: 0.8, source: 'transcript', quote: 'x' }]
      : []);
    const result = await propose('the big moment');
    expect(verifyWithVideoChat3).not.toHaveBeenCalled();
    expect(result.failures).toEqual([{ kind: 'unverified', startSeconds: 50, endSeconds: 55, reason: MISSING_TRANSCRIPT_REASON }]);
  });

  it('says in the record whether speech searched a stretch or proposed it', () => {
    expect(describeSpokenFailure({ kind: 'unsearched', startSeconds: 0, endSeconds: 300, reason: 'transcript store unavailable' }))
      .toBe('Speech was not searched here: transcript store unavailable');
    expect(describeSpokenFailure({ kind: 'unverified', startSeconds: 4, endSeconds: 12, reason: 'ffmpeg exited 1' }))
      .toBe('Speech proposed this stretch, but it could not be verified against the footage: ffmpeg exited 1');
    expect(speechUnsearched(new Error('Modal 503'), 300)).toEqual({
      proposals: [], moments: [], metrics: { failed: true, reason: 'Modal 503' },
      failures: [{ kind: 'unsearched', startSeconds: 0, endSeconds: 300, reason: 'Modal 503' }],
    });
    expect(speechUnsearched('boom', 0).failures).toEqual([]);
  });

  it('with nothing quoted and nothing named, nothing is asked of the verifier', async () => {
    textSearch.mockResolvedValue([]);
    const result = await propose('the big moment');
    expect(verifyWithVideoChat3).not.toHaveBeenCalled();
    expect(result).toMatchObject({ proposals: [], moments: [], failures: [] });
  });
});
