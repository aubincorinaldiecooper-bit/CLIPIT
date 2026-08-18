-- Per-call model usage, append-only.
--
-- One row per model request, attributed to the work that caused it. Append-only
-- rather than counters on videos/clip_requests: concurrent indexing and
-- verification calls would otherwise race on the same row, and per-call history
-- is what makes cost-per-video and cost-per-search answerable with a SUM.
--
-- Cost columns are deliberately absent: the chat API returns reliable token
-- counts but not per-call pricing. They can be added later without touching
-- what is recorded here.

CREATE TABLE IF NOT EXISTS model_usage (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Both nullable: indexing and transcription belong to a video, search and
    -- verification to a clip request. Cascades keep usage tied to the lifetime
    -- of the work it describes.
    video_id          UUID REFERENCES videos (id) ON DELETE CASCADE,
    clip_request_id   UUID REFERENCES clip_requests (id) ON DELETE CASCADE,
    provider          TEXT        NOT NULL,
    model             TEXT        NOT NULL,
    stage             TEXT        NOT NULL
                      CHECK (stage IN ('transcription', 'indexing', 'search', 'verification')),
    prompt_tokens     INTEGER     NOT NULL DEFAULT 0,
    completion_tokens INTEGER     NOT NULL DEFAULT 0,
    total_tokens      INTEGER     NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS model_usage_video_idx ON model_usage (video_id, stage);
CREATE INDEX IF NOT EXISTS model_usage_request_idx ON model_usage (clip_request_id, stage);
