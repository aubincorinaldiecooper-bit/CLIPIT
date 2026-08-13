-- Core schema for the clipping pipeline.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Anonymous sessions. `user_id` is intentionally present but unused: when real
-- user auth lands it becomes the owning principal and sessions hang off it,
-- without changing how resources record ownership.
CREATE TABLE IF NOT EXISTS sessions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash   TEXT        NOT NULL UNIQUE,
    user_id      UUID,
    label        TEXT,
    created_ip   TEXT,
    user_agent   TEXT,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS videos (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id          UUID REFERENCES sessions (id) ON DELETE SET NULL,
    user_id             UUID,
    source_type         TEXT        NOT NULL CHECK (source_type IN ('upload', 'youtube')),
    source_url          TEXT,
    original_filename   TEXT,
    title               TEXT,
    status              TEXT        NOT NULL DEFAULT 'pending_upload'
                        CHECK (status IN ('pending_upload', 'queued', 'ingesting', 'preprocessing', 'ready', 'failed')),
    error_message       TEXT,
    duration_seconds    NUMERIC(12, 3),
    size_bytes          BIGINT,
    width               INTEGER,
    height              INTEGER,
    fps                 NUMERIC(10, 4),
    video_codec         TEXT,
    audio_codec         TEXT,
    has_audio           BOOLEAN,
    metadata            JSONB       NOT NULL DEFAULT '{}'::jsonb,
    original_storage_key TEXT,
    proxy_storage_key   TEXT,
    captions_storage_key TEXT,
    chunk_seconds       INTEGER,
    chunk_count         INTEGER     NOT NULL DEFAULT 0,
    transcript_status   TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (transcript_status IN ('pending', 'queued', 'running', 'ready', 'failed', 'unavailable')),
    transcript_source   TEXT CHECK (transcript_source IN ('youtube_captions', 'openrouter_stt')),
    transcript_error    TEXT,
    transcript_segment_count INTEGER NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS videos_status_idx ON videos (status);
CREATE INDEX IF NOT EXISTS videos_session_idx ON videos (session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS video_chunks (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id              UUID        NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    chunk_index           INTEGER     NOT NULL,
    global_start_seconds  NUMERIC(12, 3) NOT NULL,
    global_end_seconds    NUMERIC(12, 3) NOT NULL,
    duration_seconds      NUMERIC(12, 3) NOT NULL,
    storage_key           TEXT        NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (video_id, chunk_index),
    CHECK (global_end_seconds > global_start_seconds)
);

CREATE INDEX IF NOT EXISTS video_chunks_video_idx ON video_chunks (video_id, chunk_index);

-- Timestamped speech, produced once per video from the full source (never
-- re-derived per analysis chunk). Timestamps are already global.
CREATE TABLE IF NOT EXISTS transcript_segments (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id       UUID        NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    segment_index  INTEGER     NOT NULL,
    start_seconds  NUMERIC(12, 3) NOT NULL,
    end_seconds    NUMERIC(12, 3) NOT NULL,
    text           TEXT        NOT NULL,
    source         TEXT        NOT NULL CHECK (source IN ('youtube_captions', 'openrouter_stt')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (video_id, segment_index),
    CHECK (end_seconds >= start_seconds)
);

CREATE INDEX IF NOT EXISTS transcript_segments_video_time_idx
    ON transcript_segments (video_id, start_seconds);

CREATE TABLE IF NOT EXISTS clip_requests (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id         UUID        NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    session_id       UUID REFERENCES sessions (id) ON DELETE SET NULL,
    user_id          UUID,
    instruction      TEXT        NOT NULL,
    mode             TEXT        NOT NULL DEFAULT 'auto'
                     CHECK (mode IN ('auto', 'visual', 'transcript', 'both')),
    resolved_mode    TEXT CHECK (resolved_mode IN ('visual', 'transcript', 'both')),
    status           TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'searching', 'completed', 'failed')),
    error_message    TEXT,
    chunks_total     INTEGER     NOT NULL DEFAULT 0,
    chunks_completed INTEGER     NOT NULL DEFAULT 0,
    chunks_failed    INTEGER     NOT NULL DEFAULT 0,
    chunk_errors     JSONB       NOT NULL DEFAULT '[]'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS clip_requests_video_idx ON clip_requests (video_id, created_at DESC);
CREATE INDEX IF NOT EXISTS clip_requests_session_idx ON clip_requests (session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS clip_matches (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    clip_request_id       UUID        NOT NULL REFERENCES clip_requests (id) ON DELETE CASCADE,
    chunk_id              UUID        NOT NULL REFERENCES video_chunks (id) ON DELETE CASCADE,
    local_start_seconds   NUMERIC(12, 3) NOT NULL,
    local_end_seconds     NUMERIC(12, 3) NOT NULL,
    global_start_seconds  NUMERIC(12, 3) NOT NULL,
    global_end_seconds    NUMERIC(12, 3) NOT NULL,
    description           TEXT        NOT NULL DEFAULT '',
    confidence            NUMERIC(5, 4) NOT NULL DEFAULT 0,
    source                TEXT        NOT NULL DEFAULT 'visual'
                          CHECK (source IN ('visual', 'transcript', 'multimodal')),
    quote                 TEXT,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (local_end_seconds > local_start_seconds),
    CHECK (global_end_seconds > global_start_seconds),
    CHECK (confidence >= 0 AND confidence <= 1)
);

CREATE INDEX IF NOT EXISTS clip_matches_request_idx
    ON clip_matches (clip_request_id, global_start_seconds);

CREATE TABLE IF NOT EXISTS clips (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    video_id       UUID        NOT NULL REFERENCES videos (id) ON DELETE CASCADE,
    clip_match_id  UUID        NOT NULL REFERENCES clip_matches (id) ON DELETE CASCADE,
    session_id     UUID REFERENCES sessions (id) ON DELETE SET NULL,
    user_id        UUID,
    start_seconds  NUMERIC(12, 3) NOT NULL,
    end_seconds    NUMERIC(12, 3) NOT NULL,
    storage_key    TEXT,
    status         TEXT        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'generating', 'ready', 'failed')),
    error_message  TEXT,
    duration_seconds NUMERIC(12, 3),
    size_bytes     BIGINT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_seconds > start_seconds)
);

-- One clip per match keeps `generate` idempotent when called repeatedly.
CREATE UNIQUE INDEX IF NOT EXISTS clips_match_unique_idx ON clips (clip_match_id);
CREATE INDEX IF NOT EXISTS clips_video_idx ON clips (video_id, created_at DESC);
CREATE INDEX IF NOT EXISTS clips_session_idx ON clips (session_id, created_at DESC);
