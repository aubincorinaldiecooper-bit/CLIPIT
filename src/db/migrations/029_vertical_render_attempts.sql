-- What happened while making a moment post-ready — including, especially,
-- the attempts nobody will ever see.
--
-- The product rule (owner, 2026-08-31) is that creators only ever see
-- FINISHED vertical moments: a candidate whose media pipeline failed is
-- simply absent from the deck, with no error card, no retry button and no
-- landscape substitute. That is right for the creator and dangerous for us —
-- a pipeline that quietly drops a third of its candidates would look, from
-- the outside, exactly like a video that only had two good moments in it.
--
-- So every attempt is recorded here whether or not it succeeded, and rows are
-- NEVER deleted merely because a creator cannot see them. This table is the
-- only thing standing between "we hid it" and "it wasn't there".
CREATE TABLE vertical_render_attempts (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- What was being made. clip_id is null when the failure happened before a
    -- clip row existed; match_id is the durable candidate identity.
    video_id          UUID REFERENCES videos (id)        ON DELETE CASCADE,
    clip_request_id   UUID REFERENCES clip_requests (id) ON DELETE CASCADE,
    match_id          UUID REFERENCES clip_matches (id)  ON DELETE CASCADE,
    clip_id           UUID REFERENCES clips (id)         ON DELETE SET NULL,

    -- Ownership, following the same rule the rest of the telemetry uses:
    -- the workspace/session that asked, never anything more personal.
    workspace_id      UUID,
    session_id        TEXT,

    -- What was asked for and what was aimed at.
    requested_platform TEXT,
    presentation_target TEXT NOT NULL DEFAULT 'vertical',
    source_width       INTEGER,
    source_height      INTEGER,
    source_aspect      TEXT,
    target_aspect      TEXT,
    target_width       INTEGER,
    target_height      INTEGER,
    composition_mode   TEXT,

    -- Who judged the framing. Null when the failure happened before the call.
    provider           TEXT,
    model              TEXT,

    -- The outcome. 'succeeded' rows matter as much as failures: a success
    -- rate needs both halves, and first-attempt-success needs attempt_number.
    outcome            TEXT NOT NULL
                       CHECK (outcome IN ('succeeded', 'failed')),
    -- Which step gave way. Structured, never a free-form message, because
    -- "where does this break most" has to be answerable by grouping.
    failure_stage      TEXT
                       CHECK (failure_stage IS NULL OR failure_stage IN (
                         -- Cutting the canonical excerpt is inside this pipeline's
                         -- responsibility: if that fails the candidate silently
                         -- leaves the deck, and an unrecorded disappearance is the
                         -- exact thing this table exists to prevent.
                         'canonical_generation',
                         'composition_decision',
                         'composition_validation',
                         'smart_crop_render',
                         'blurred_background_render',
                         'poster_generation',
                         'storage_upload',
                         'media_probe',
                         'serialization'
                       )),
    failure_code       TEXT,
    -- Sanitised at the call site. Never a signed URL, token or credential.
    failure_message    TEXT,

    -- Retry accounting. attempt_number is 1-based; recovered_at is set on the
    -- EARLIER failed row when a later attempt succeeds, so "retry recovery
    -- rate" is a query rather than a guess.
    attempt_number     INTEGER NOT NULL DEFAULT 1,
    total_attempts     INTEGER,
    recovered_at       TIMESTAMPTZ,

    -- Where the time went.
    composition_decision_ms  INTEGER,
    derivative_render_ms     INTEGER,
    poster_generation_ms     INTEGER,

    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The breakdowns the admin metrics need: by outcome and stage over time, by
-- platform, by composition mode, and per candidate for the suppression count.
CREATE INDEX vertical_render_attempts_outcome_idx
    ON vertical_render_attempts (outcome, failure_stage, created_at DESC);
CREATE INDEX vertical_render_attempts_platform_idx
    ON vertical_render_attempts (requested_platform, composition_mode, created_at DESC);
CREATE INDEX vertical_render_attempts_match_idx
    ON vertical_render_attempts (match_id, attempt_number);
CREATE INDEX vertical_render_attempts_request_idx
    ON vertical_render_attempts (clip_request_id);
