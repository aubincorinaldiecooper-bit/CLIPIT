-- Post-ready media: a poster, and a vertical derivative that is a real file.
--
-- The canonical clip stays authoritative — original framing, original source
-- seconds. Everything here hangs off it as presentation, so nothing below can
-- change what the moment IS.

-- FIRST, A BUG FIX.
--
-- Migration 003 wrote CHECK (stage IN ('transcription','indexing','search',
-- 'verification')), and the Re-clip work later added 'reclip' to the
-- TypeScript UsageStage without widening this constraint. recordModelUsage
-- catches its own errors and logs a warning, so every re-clip usage row since
-- has been rejected by the database and silently dropped — which means the
-- evaluation page's re-clip cost share has been computed from no rows at all.
-- An absence nobody verified, reported as a number.
--
-- 'verification' is kept: it predates this and dropping a value is not this
-- migration's business. 'composition' is added for the targeted MiniCPM call
-- that decides vertical framing.
ALTER TABLE model_usage DROP CONSTRAINT IF EXISTS model_usage_stage_check;
ALTER TABLE model_usage
    ADD CONSTRAINT model_usage_stage_check
    CHECK (stage IN ('transcription', 'indexing', 'search', 'verification', 'reclip', 'composition'));

-- The poster: a real frame chosen from inside the clip, not the browser's
-- guess at frame zero. Null when extraction failed — the clip is still
-- perfectly usable, and the reader falls back to the moment's thumbnail.
ALTER TABLE clips
    ADD COLUMN IF NOT EXISTS poster_storage_key        TEXT,
    ADD COLUMN IF NOT EXISTS poster_timestamp_seconds  NUMERIC(12, 3);

-- The vertical derivative. A SEPARATE file: the canonical clip keeps original
-- framing and its own key, and this never overwrites it.
--
-- composition_mode records what was actually done, and must stay truthful —
-- 'blurred_background' when the model refused a crop, when it answered
-- nonsense, and when it could not be reached at all. A row claiming
-- 'smart_crop' means a crop really was judged safe.
ALTER TABLE clips
    ADD COLUMN IF NOT EXISTS derivative_storage_key TEXT,
    ADD COLUMN IF NOT EXISTS derivative_status      TEXT
        CHECK (derivative_status IS NULL OR derivative_status IN ('pending', 'ready', 'failed')),
    ADD COLUMN IF NOT EXISTS derivative_error       TEXT,
    ADD COLUMN IF NOT EXISTS composition_mode       TEXT
        CHECK (composition_mode IS NULL OR composition_mode IN ('smart_crop', 'blurred_background', 'padded', 'original')),
    -- Normalized 0..1 against the SOURCE frame, exactly as the model returns
    -- them. Null under blurred_background, where no focal point was used.
    ADD COLUMN IF NOT EXISTS focal_x                REAL,
    ADD COLUMN IF NOT EXISTS focal_y                REAL,
    -- Measured, so the aspect the reader is told is the file's real shape and
    -- not a guess from a filename.
    ADD COLUMN IF NOT EXISTS source_width           INTEGER,
    ADD COLUMN IF NOT EXISTS source_height          INTEGER,
    ADD COLUMN IF NOT EXISTS output_width           INTEGER,
    ADD COLUMN IF NOT EXISTS output_height          INTEGER,
    -- Where the time went, per stage, so a slow post-ready pipeline can be
    -- read rather than guessed at.
    ADD COLUMN IF NOT EXISTS canonical_generation_ms   INTEGER,
    ADD COLUMN IF NOT EXISTS poster_generation_ms      INTEGER,
    ADD COLUMN IF NOT EXISTS composition_decision_ms   INTEGER,
    ADD COLUMN IF NOT EXISTS derivative_generation_ms  INTEGER;
