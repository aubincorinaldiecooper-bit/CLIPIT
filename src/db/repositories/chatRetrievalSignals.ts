import { queryOne } from '../pool.js';

export const CHAT_RETRIEVAL_SIGNAL_TYPES = [
  'timestamp_clicked',
  'answer_helpful',
  'answer_incorrect',
  'follow_up',
  'where_exactly',
  'missing_section',
] as const;

export type ChatRetrievalSignalType = (typeof CHAT_RETRIEVAL_SIGNAL_TYPES)[number];

export interface ChatRetrievalSignal {
  id: string;
  clipRequestId: string;
  eventType: ChatRetrievalSignalType;
  timestampSeconds: number | null;
  relatedClipRequestId: string | null;
  detail: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

interface Row {
  id: string;
  clip_request_id: string;
  event_type: ChatRetrievalSignalType;
  timestamp_seconds: string | number | null;
  related_clip_request_id: string | null;
  detail: string | null;
  metadata: Record<string, unknown>;
  created_at: Date;
}

function map(row: Row): ChatRetrievalSignal {
  return {
    id: row.id,
    clipRequestId: row.clip_request_id,
    eventType: row.event_type,
    timestampSeconds: row.timestamp_seconds === null ? null : Number(row.timestamp_seconds),
    relatedClipRequestId: row.related_clip_request_id,
    detail: row.detail,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

/**
 * Records an observed chat interaction. A client event id makes retries safe:
 * the same browser event returns the original row rather than biasing metrics.
 */
export async function recordChatRetrievalSignal(input: {
  clipRequestId: string;
  eventType: ChatRetrievalSignalType;
  timestampSeconds?: number | null;
  relatedClipRequestId?: string | null;
  detail?: string | null;
  metadata?: Record<string, unknown>;
  clientEventId?: string | null;
}): Promise<ChatRetrievalSignal> {
  const row = await queryOne<Row>(
    `INSERT INTO chat_retrieval_signals (
       clip_request_id, event_type, timestamp_seconds, related_clip_request_id,
       detail, metadata, client_event_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (clip_request_id, client_event_id)
     DO UPDATE SET client_event_id = EXCLUDED.client_event_id
     RETURNING *`,
    [
      input.clipRequestId,
      input.eventType,
      input.timestampSeconds ?? null,
      input.relatedClipRequestId ?? null,
      input.detail ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.clientEventId ?? null,
    ],
  );
  if (!row) throw new Error('Chat retrieval signal was not persisted');
  return map(row);
}
