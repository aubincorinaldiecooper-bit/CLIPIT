-- A human verdict on each matched moment.
--
-- The model reports its own confidence, and that number currently drives the
-- "High" / "Likely" label a user reads. Nothing has ever checked it against
-- what a person thinks of the same clip, so there is no way to tell a
-- well-calibrated score from a confident one. This column is where that
-- evidence starts accumulating.
--
-- Rejected matches are kept, not deleted. Removing the row would take the clip
-- off the user's screen and destroy the only record of a moment the model was
-- wrong about — which is precisely the data worth having.
ALTER TABLE clip_matches
    ADD COLUMN IF NOT EXISTS feedback TEXT
        CHECK (feedback IS NULL OR feedback IN ('approved', 'rejected')),
    ADD COLUMN IF NOT EXISTS feedback_at TIMESTAMPTZ;
