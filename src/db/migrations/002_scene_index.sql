-- Ingest-time video understanding.
--
-- The model reads the video ONCE, at upload, into timestamped scene
-- descriptions — the way an LLM ingests a book before being asked about it.
-- Queries then run against this index as text, instead of re-sending frames
-- to the model on every search.

ALTER TABLE videos
    ADD COLUMN IF NOT EXISTS index_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (index_status IN ('pending', 'queued', 'running', 'ready', 'failed', 'unavailable')),
    ADD COLUMN IF NOT EXISTS index_error TEXT,
    ADD COLUMN IF NOT EXISTS scene_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS video_scenes (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id       UUID           NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    scene_index    INTEGER        NOT NULL,
    -- Global source time: scenes are stored on the video's own timeline so a
    -- search over the whole index needs no per-chunk rebasing.
    start_seconds  NUMERIC(12, 3) NOT NULL,
    end_seconds    NUMERIC(12, 3) NOT NULL,
    description    TEXT           NOT NULL,
    created_at     TIMESTAMPTZ    NOT NULL DEFAULT now(),
    CHECK (end_seconds > start_seconds)
);

CREATE INDEX IF NOT EXISTS video_scenes_video_idx ON video_scenes (video_id, start_seconds);
