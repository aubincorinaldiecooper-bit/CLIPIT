import { describe, expect, it } from 'vitest';
import { searchCoverage } from '../src/api/serializers.js';
import type { ChunkError, ClipRequest } from '../src/domain/types.js';

/**
 * A search that could not examine part of the video still returns
 * `status: completed` with whatever the other chunks found. That is the right
 * behaviour — nine chunks of results beat none — but it means the response has
 * to say which seconds went unlooked-at, or "nothing matches" is
 * indistinguishable from the moment genuinely being absent.
 */
function request(overrides: Partial<ClipRequest> = {}): ClipRequest {
  return {
    id: 'req',
    videoId: 'vid',
    sessionId: null,
    userId: null,
    instruction: 'find the black car',
    mode: 'auto',
    resolvedMode: 'both',
    status: 'completed',
    errorMessage: null,
    chunksTotal: 10,
    chunksCompleted: 10,
    chunksFailed: 0,
    chunkErrors: [],
    chunkDegradations: [],
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  } as ClipRequest;
}

const filtered: ChunkError = {
  chunkIndex: 7,
  chunkId: 'chunk-7',
  message: 'Video request failed with status 400: data_inspection_failed',
  code: 'provider_content_filter',
  globalStartSeconds: 841,
  globalEndSeconds: 961,
};

describe('search coverage', () => {
  it('reports a fully searched video as complete', () => {
    const coverage = searchCoverage(request());

    expect(coverage.complete).toBe(true);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.unsearchedSeconds).toBe(0);
  });

  /** The production case: Alibaba refused one chunk's transcript text. */
  it('locates the seconds a provider refused to examine', () => {
    const coverage = searchCoverage(
      request({ chunksCompleted: 9, chunksFailed: 1, chunkErrors: [filtered] }),
    );

    expect(coverage.complete).toBe(false);
    expect(coverage.unsearchedSeconds).toBe(120);
    expect(coverage.gaps).toHaveLength(1);
    expect(coverage.gaps[0]).toMatchObject({
      startSeconds: 841,
      endSeconds: 961,
      reason: 'provider_content_filter',
    });
    // Timecodes, because "841" is not something a user can find in a player.
    expect(coverage.gaps[0]?.startTimecode).toBe('00:14:01');
    expect(coverage.gaps[0]?.endTimecode).toBe('00:16:01');
  });

  /**
   * A chunk recovered by dropping its transcript is not a gap — its matches
   * are real — but it is not clean coverage either. Reporting it as complete
   * would hide that a spoken condition could not be checked in that window,
   * which is the same silent loss this whole block exists to prevent.
   */
  it('counts a transcript-omitted recovery against completeness', () => {
    const coverage = searchCoverage(
      request({
        chunkDegradations: [
          { chunkIndex: 7, globalStartSeconds: 841, globalEndSeconds: 961, reason: 'transcript_omitted' },
        ],
      }),
    );

    expect(coverage.complete).toBe(false);
    // Not a gap: the window WAS searched, so nothing is unsearched.
    expect(coverage.unsearchedSeconds).toBe(0);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.degraded).toHaveLength(1);
    expect(coverage.degraded[0]).toMatchObject({
      startTimecode: '00:14:01',
      endTimecode: '00:16:01',
      reason: 'transcript_omitted',
    });
  });

  it('orders gaps by position in the video, not by when they failed', () => {
    const coverage = searchCoverage(
      request({
        chunksCompleted: 8,
        chunksFailed: 2,
        chunkErrors: [
          filtered,
          { ...filtered, chunkIndex: 2, chunkId: 'chunk-2', globalStartSeconds: 241, globalEndSeconds: 361 },
        ],
      }),
    );

    expect(coverage.gaps.map((gap) => gap.startSeconds)).toEqual([241, 841]);
    expect(coverage.unsearchedSeconds).toBe(240);
  });

  /**
   * `chunk_errors` is JSONB and rows written before failures carried a source
   * window are still in the table. They must not crash the serializer or
   * invent a gap at 0-0.
   */
  it('tolerates failure rows recorded before they carried a window', () => {
    const legacy = { chunkIndex: 3, chunkId: 'chunk-3', message: 'boom' } as unknown as ChunkError;
    const coverage = searchCoverage(
      request({ chunksCompleted: 9, chunksFailed: 1, chunkErrors: [legacy] }),
    );

    // Still known to be incomplete — it just cannot say where. `locatable`
    // is what stops a caller reading unsearchedSeconds: 0 as "nothing missed"
    // and telling the user 00:00:00 of their video was skipped.
    expect(coverage.complete).toBe(false);
    expect(coverage.locatable).toBe(false);
    expect(coverage.gaps).toEqual([]);
    expect(coverage.unsearchedSeconds).toBe(0);
  });

  it('is locatable when every failure carries its window', () => {
    const coverage = searchCoverage(
      request({ chunksCompleted: 9, chunksFailed: 1, chunkErrors: [filtered] }),
    );

    expect(coverage.locatable).toBe(true);
  });
});
