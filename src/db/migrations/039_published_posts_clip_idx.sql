-- The Publish control asks a clip's posts every couple of seconds until
-- the platforms have answered (GET /api/clips/:clipId/posts). The table's
-- indexes begin with user_id or workspace_id; this read begins with
-- clip_id and wants the newest rows first, so it gets an index of its own,
-- and LIMIT 20 stops after the newest matching rows instead of the whole
-- table being read and sorted (Devin's and Codex's finding on #85).
--
-- Numbered past 038 (the settle counter, #84) so the two land in either
-- order; the runner applies whatever is not yet applied, by name.
CREATE INDEX IF NOT EXISTS published_posts_clip_created_idx
  ON published_posts (clip_id, created_at DESC)
  WHERE clip_id IS NOT NULL;
