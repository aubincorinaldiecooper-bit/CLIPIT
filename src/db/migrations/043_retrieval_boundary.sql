-- Which system answered a question, and why the other one did not.
--
-- Omni-SimpleMem is being tried as the primary way of finding moments, with
-- the existing notes-then-footage search kept as the fallback. The two must
-- never be blended: an answer is one system's or the other's, and the row
-- says which, so "how often did the primary fall back, why, and did the
-- fallback do better" can be read from the database instead of guessed.
--
--   retrieval_primary  what was configured when the question was asked
--   retrieval_system   which system the moments actually came from
--   fallback_reason    set when the primary was tried (or skipped by rule)
--                      and the answer came from the fallback instead
--   primary_outcome    what the primary returned, counted: items, candidates,
--                      what was ignored and why, its top score, its elapsed
--                      time, its coverage. Kept even when the fallback won,
--                      because that is the comparison this exists to make.
--
-- Null on every request from before this column, and on any request that
-- has not reached the point of deciding.
ALTER TABLE clip_requests
    ADD COLUMN IF NOT EXISTS retrieval_primary TEXT
        CHECK (retrieval_primary IS NULL OR retrieval_primary IN ('clipit', 'simplemem')),
    ADD COLUMN IF NOT EXISTS retrieval_system TEXT
        CHECK (retrieval_system IS NULL OR retrieval_system IN ('clipit', 'simplemem')),
    ADD COLUMN IF NOT EXISTS fallback_reason TEXT,
    ADD COLUMN IF NOT EXISTS primary_outcome JSONB;

CREATE INDEX IF NOT EXISTS clip_requests_retrieval_idx
    ON clip_requests (retrieval_system, created_at DESC)
    WHERE retrieval_system IS NOT NULL;

-- What Omni-SimpleMem holds for a video, as Clipit last heard it.
--
-- SimpleMem keeps its own memory (frames, captions, vectors) on its own disk.
-- This row is Clipit's record of that read: whether it happened, how far into
-- the video it looked, and under which models — so a question can be told
-- "the memory is not ready yet" apart from "the memory has nothing", and so
-- a later comparison can say which weights produced a given answer.
--
-- covered_through_seconds is the honesty channel: SimpleMem reads at most
-- max_frames frames, so a long video is read only up to here. A moment past
-- it is a moment the memory never looked at, and the search names that
-- stretch rather than reporting it as empty.
CREATE TABLE IF NOT EXISTS simplemem_index (
    video_id                UUID PRIMARY KEY REFERENCES videos (id) ON DELETE CASCADE,
    status                  TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'ready', 'failed', 'unavailable')),
    video_mau_id            TEXT,
    fps                     NUMERIC(8, 3),
    frames_extracted        INTEGER,
    frames_processed        INTEGER,
    frames_skipped          INTEGER,
    covered_through_seconds NUMERIC(12, 3),
    audio_transcribed       BOOLEAN,
    index_ms                INTEGER,
    error                   TEXT,
    -- The models the sidecar reported, frozen with the read.
    config                  JSONB,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
