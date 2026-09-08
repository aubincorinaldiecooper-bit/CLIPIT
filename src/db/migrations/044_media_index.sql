-- The Media Index: what a video looks like, stored once, searchable forever.
--
-- Until now a question about a video was answered from the notes taken at
-- upload, and by re-reading the footage when the notes fell short. This table
-- is the third answer: overlapping stretches of the source timeline, each
-- carrying a vector of what the pictures in it look like, so a typed question
-- can be compared against the footage itself without watching it again.
--
-- WHY BYTEA AND NOT A VECTOR COLUMN
--
-- pgvector is not installed and cannot be assumed. Railway's own PostgreSQL
-- documentation says extensions are deliberately not added to the template
-- image both of this project's databases run, and offers pgvector only as a
-- separate template. A migration issuing CREATE EXTENSION would fail on boot
-- and take the deployment with it.
--
-- So a vector is stored as its raw little-endian float32 bytes and compared in
-- the application. Searching is always scoped to one video, so the comparison
-- is over that video's windows alone — hundreds, not millions — which is
-- arithmetic a process does in milliseconds.
--
-- The upgrade path stays open: adding pgvector later means one migration that
-- adds a vector column and fills it from these bytes. Nothing here has to be
-- re-embedded to make that move, which is the point of storing the raw bytes
-- rather than a lossy or model-specific encoding.
CREATE TABLE IF NOT EXISTS media_index (
    video_id      UUID           NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    -- The window's identity is the seconds it covers, never its position in an
    -- array and never a row id. Both of those have already cost this codebase
    -- real bugs, and chunk rows are regenerated wholesale on re-processing.
    window_key    TEXT           NOT NULL,
    start_seconds NUMERIC(12, 3) NOT NULL,
    end_seconds   NUMERIC(12, 3) NOT NULL,
    embedding     BYTEA          NOT NULL,
    dims          INTEGER        NOT NULL,
    -- Which model made this vector, and which weights. A vector from an
    -- unexpected model is not a slightly worse vector, it is a meaningless
    -- one, and it would look exactly like a working index. Recorded per row so
    -- a model change can be detected rather than silently mixed in.
    model         TEXT           NOT NULL,
    revision      TEXT           NOT NULL DEFAULT '',
    index_version TEXT           NOT NULL,
    created_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (video_id, window_key),
    CHECK (end_seconds > start_seconds),
    CHECK (dims > 0),
    -- A float32 is four bytes. This makes a truncated or mis-sized vector
    -- impossible to store rather than something discovered at search time,
    -- when it would look like a bad answer instead of a bad row.
    CHECK (octet_length(embedding) = dims * 4)
);

CREATE INDEX IF NOT EXISTS media_index_video_start_idx
    ON media_index (video_id, start_seconds);

-- How much of each video has actually been read, and how much has not.
--
-- This exists because of the rule this codebase names first: never report an
-- absence you did not verify. If indexing stopped at eleven minutes, a search
-- of minute fourteen has NOT looked and must not answer as though it did.
-- covered_through_seconds is what makes the difference between "nothing
-- matches there" and "nothing has read there" expressible at all.
CREATE TABLE IF NOT EXISTS media_index_status (
    video_id                UUID PRIMARY KEY REFERENCES videos (id) ON DELETE CASCADE,
    state                   TEXT           NOT NULL,
    -- The second up to which every planned window is stored. Not the furthest
    -- window that happened to succeed: a gap in the middle pulls this back to
    -- the gap, because coverage past a hole is not coverage.
    covered_through_seconds NUMERIC(12, 3) NOT NULL DEFAULT 0,
    windows_planned         INTEGER        NOT NULL DEFAULT 0,
    windows_stored          INTEGER        NOT NULL DEFAULT 0,
    -- Windows a provider refused or returned unusable. Counted, never rounded
    -- away: a refused window reported as clean coverage is the exact failure
    -- this table is built to prevent.
    windows_failed          INTEGER        NOT NULL DEFAULT 0,
    model                   TEXT           NOT NULL DEFAULT '',
    revision                TEXT           NOT NULL DEFAULT '',
    dims                    INTEGER,
    index_version           TEXT           NOT NULL DEFAULT '',
    error                   TEXT,
    started_at              TIMESTAMPTZ,
    finished_at             TIMESTAMPTZ,
    updated_at              TIMESTAMPTZ    NOT NULL DEFAULT now(),
    CHECK (state IN ('queued', 'running', 'ready', 'partial', 'failed', 'unavailable')),
    CHECK (covered_through_seconds >= 0),
    CHECK (windows_planned >= 0 AND windows_stored >= 0 AND windows_failed >= 0)
);

CREATE INDEX IF NOT EXISTS media_index_status_state_idx
    ON media_index_status (state);

-- Embedding and reranking are their own stages, and their cost is their own
-- line. Rolling them into 'indexing' would hide which half of the Media Index
-- the money goes to, and migration 027 is the reminder of what a stage the
-- constraint does not know about actually does: every insert rejected, every
-- warning swallowed, and a cost report computed from zero rows.
ALTER TABLE model_usage DROP CONSTRAINT IF EXISTS model_usage_stage_check;
ALTER TABLE model_usage
    ADD CONSTRAINT model_usage_stage_check
    CHECK (stage IN ('transcription', 'indexing', 'search', 'verification', 'reclip',
                     'composition', 'embedding', 'rerank'));
