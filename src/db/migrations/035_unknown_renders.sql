-- Renders whose outcome could not be learned on their job's last attempt.
--
-- A render's write can land while its reply is lost; if the row cannot be
-- read afterwards either, the outcome is unknown (see
-- RenderOutcomeUnknownError). A retry settles it by asking the row. The
-- job's LAST attempt has no retry, so it writes the render down here, and
-- the footage sweep settles it once the database answers: a row that names
-- the render's file was written by it and is left as it is; a row still
-- 'generating' was not, and is rolled back exactly as a failed render would
-- have been — nothing stays "generating" forever.
CREATE TABLE IF NOT EXISTS unknown_renders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_id UUID NOT NULL,
  -- The file this render wrote. The row naming it is the proof the write landed.
  storage_key TEXT NOT NULL,
  -- The job as it ran, so the rollback can put back what a failure would have.
  job JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS unknown_renders_created_idx ON unknown_renders (created_at);
