-- A problem reported from inside the product, with the context a fix needs.
--
-- Testers' notes arrive as prose in a document, hours later, and the first
-- job is always to find their session in the logs by the clock. A report
-- made from the page carries its own: the page, the video and the question
-- on screen, and a snapshot of what the server knew about them at that
-- moment, so it can be acted on after the rows have moved on. Ids only —
-- never an address or a name.
CREATE TABLE IF NOT EXISTS platform_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id TEXT,
  user_id TEXT,
  workspace_id TEXT,
  page TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  video_id UUID,
  clip_request_id UUID,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  user_agent TEXT NOT NULL DEFAULT '',
  -- Where the report went to be fixed ("github:owner/repo#12"). Null while it is only here.
  handed_off_to TEXT,
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS platform_reports_created_idx ON platform_reports (created_at DESC);
