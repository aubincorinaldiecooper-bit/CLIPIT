-- Re-clip: the automated answer to "the timing is off".
--
-- The product promise is that the system finds the moment and, when the cut
-- is not right, the system tries again — the person is never sent to repair
-- timestamps by hand. That takes two pieces of state:
--
-- 1. A version history per moment, because a re-evaluation must never
--    overwrite the original prediction. Version 1 is the first-pass answer;
--    each Re-clip appends the next version. Boundary SHIFT between versions
--    (how far the model moved its own answer when asked to reconsider) is a
--    correction signal — deliberately not called accuracy anywhere, because
--    the model reconsidering itself is not ground truth.
--
-- 2. A visible lifecycle on the moment itself, because a re-evaluation can
--    take minutes on a cold GPU and can fail. The person who tapped Re-clip
--    and reloaded the page still deserves to see "thinking" or "didn't
--    work", not silence.

CREATE TABLE IF NOT EXISTS moment_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    match_id        UUID NOT NULL REFERENCES clip_matches(id) ON DELETE CASCADE,
    version         INTEGER NOT NULL,
    -- What produced this version. 'initial' rows copy the match's own
    -- first-pass prediction the first time a Re-clip is asked for; 'reclip'
    -- rows are re-evaluations. The original match row is never updated.
    trigger         TEXT NOT NULL CHECK (trigger IN ('initial', 'reclip')),
    start_seconds   NUMERIC(12, 3) NOT NULL,
    end_seconds     NUMERIC(12, 3) NOT NULL,
    -- Attribution, same discipline as clip_matches: a boundary shift is only
    -- evidence about a model if the row names the model and the prompt that
    -- asked. Null only on 'initial' rows copied from matches that predate
    -- attribution.
    provider        TEXT,
    model           TEXT,
    prompt_version  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (match_id, version)
);

CREATE INDEX IF NOT EXISTS idx_moment_versions_match ON moment_versions (match_id, version);

-- The Re-clip lifecycle on the moment. NULL = never asked or finished
-- cleanly; 'pending' = a re-evaluation is queued or running; 'failed' = the
-- last attempt did not produce a version, and reclip_error says why in
-- words safe to show. Success clears the status — the new version row IS
-- the record of success.
ALTER TABLE clip_matches
    ADD COLUMN IF NOT EXISTS reclip_status TEXT
        CHECK (reclip_status IS NULL OR reclip_status IN ('pending', 'failed')),
    ADD COLUMN IF NOT EXISTS reclip_error  TEXT,
    -- Paid ATTEMPTS, not successes. The lifetime ceiling has to bound GPU
    -- spend, and a call that returned unusable boundaries cost the same as
    -- one that worked — counting only successful versions would let failures
    -- be retried without limit.
    ADD COLUMN IF NOT EXISTS reclip_attempts INTEGER NOT NULL DEFAULT 0;
