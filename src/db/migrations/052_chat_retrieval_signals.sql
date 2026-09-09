-- Product feedback for conversational video retrieval. These events are
-- append-only evidence for evaluation/EvolveMem, not mutable model labels.
CREATE TABLE IF NOT EXISTS chat_retrieval_signals (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clip_request_id         UUID NOT NULL REFERENCES clip_requests (id) ON DELETE CASCADE,
    event_type              TEXT NOT NULL CHECK (event_type IN (
                                'timestamp_clicked', 'answer_helpful', 'answer_incorrect',
                                'follow_up', 'where_exactly', 'missing_section'
                            )),
    timestamp_seconds       NUMERIC(12, 3),
    related_clip_request_id UUID REFERENCES clip_requests (id) ON DELETE SET NULL,
    detail                  TEXT,
    metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
    client_event_id         UUID,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (timestamp_seconds IS NULL OR timestamp_seconds >= 0),
    CHECK (event_type <> 'timestamp_clicked' OR timestamp_seconds IS NOT NULL),
    UNIQUE (clip_request_id, client_event_id)
);

CREATE INDEX IF NOT EXISTS chat_retrieval_signals_request_idx
    ON chat_retrieval_signals (clip_request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chat_retrieval_signals_evaluation_idx
    ON chat_retrieval_signals (event_type, created_at DESC);
