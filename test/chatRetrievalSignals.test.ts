import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryOne = vi.fn();
vi.mock('../src/db/pool.js', () => ({ queryOne }));

const { recordChatRetrievalSignal } = await import('../src/db/repositories/chatRetrievalSignals.js');

beforeEach(() => vi.clearAllMocks());

describe('chat retrieval signals', () => {
  it('persists timestamp interactions with an idempotency key', async () => {
    const createdAt = new Date('2026-09-09T00:00:00Z');
    queryOne.mockResolvedValue({
      id: 'signal-1',
      clip_request_id: 'request-1',
      event_type: 'timestamp_clicked',
      timestamp_seconds: '42.125',
      related_clip_request_id: null,
      detail: null,
      metadata: { source: 'answer-1' },
      created_at: createdAt,
    });

    const result = await recordChatRetrievalSignal({
      clipRequestId: 'request-1',
      eventType: 'timestamp_clicked',
      timestampSeconds: 42.125,
      metadata: { source: 'answer-1' },
      clientEventId: 'event-1',
    });

    expect(result).toEqual({
      id: 'signal-1',
      clipRequestId: 'request-1',
      eventType: 'timestamp_clicked',
      timestampSeconds: 42.125,
      relatedClipRequestId: null,
      detail: null,
      metadata: { source: 'answer-1' },
      createdAt,
    });
    expect(queryOne).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (clip_request_id, client_event_id)'),
      ['request-1', 'timestamp_clicked', 42.125, null, null, '{"source":"answer-1"}', 'event-1'],
    );
  });

  it('records a follow-up relationship for later retrieval evaluation', async () => {
    queryOne.mockResolvedValue({
      id: 'signal-2',
      clip_request_id: 'request-1',
      event_type: 'follow_up',
      timestamp_seconds: null,
      related_clip_request_id: 'request-2',
      detail: 'What happened after that?',
      metadata: {},
      created_at: new Date('2026-09-09T00:00:00Z'),
    });

    const result = await recordChatRetrievalSignal({
      clipRequestId: 'request-1',
      eventType: 'follow_up',
      relatedClipRequestId: 'request-2',
      detail: 'What happened after that?',
    });

    expect(result.relatedClipRequestId).toBe('request-2');
    expect(result.eventType).toBe('follow_up');
  });
});

describe('chat signal API contract', () => {
  it('requires the destination timestamp for a click', async () => {
    const { chatSignalSchema } = await import('../src/api/routes/clipRequests.js');
    expect(chatSignalSchema.safeParse({ event: 'timestamp_clicked' }).success).toBe(false);
    expect(chatSignalSchema.safeParse({ event: 'timestamp_clicked', timestampSeconds: 12.5 }).success).toBe(true);
  });

  it('accepts the explicit quality and conversational signals', async () => {
    const { chatSignalSchema } = await import('../src/api/routes/clipRequests.js');
    for (const event of ['answer_helpful', 'answer_incorrect', 'follow_up', 'where_exactly', 'missing_section']) {
      expect(chatSignalSchema.safeParse({ event }).success, event).toBe(true);
    }
  });
});
