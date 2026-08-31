-- Post-ready media: a poster, and a vertical derivative that is a real file.
--
-- The canonical clip stays authoritative — original framing, original source
-- seconds. Everything here hangs off it as presentation, so nothing below can
-- change what the moment IS.

-- The model_usage stage constraint that this work needed is NOT here. It was
-- split into its own hotfix (027_usage_stage_constraint.sql, merged ahead of
-- this branch) because it fixes a live bug — every re-clip cost row was being
-- rejected by Postgres and dropped — and that had no reason to wait on a
-- media pipeline. 027 already allows 'composition', so this migration needs
-- no constraint change of its own.

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

-- Whether this clip was made BEFORE anyone chose it. That is the whole
-- premise of the post-ready deck: the file exists by the time the card is
-- seen, so Keep can no longer mean "generate this". A clip cut the old way,
-- on a Keep press, is not pre-rendered and its Keep must keep working
-- exactly as it does today.
--
-- retention_class defaults to 'owned' deliberately. Every clip that exists
-- today was cut because somebody asked for it, and a default of 'temporary'
-- would enrol the entire back catalogue in a sweep that deletes it.
ALTER TABLE clips
    ADD COLUMN IF NOT EXISTS pre_rendered    BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Set when Keep is pressed. Null means nobody has chosen this moment.
    ADD COLUMN IF NOT EXISTS approved_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS retention_class TEXT        NOT NULL DEFAULT 'owned'
        CHECK (retention_class IN ('temporary', 'owned'));

-- The retention sweep's only question: which pre-rendered files did nobody
-- keep, and how long have they been sitting there. Partial, because the rows
-- it must never touch are the overwhelming majority.
CREATE INDEX IF NOT EXISTS clips_unkept_prerendered_idx
    ON clips (created_at)
    WHERE retention_class = 'temporary' AND pre_rendered = TRUE;
