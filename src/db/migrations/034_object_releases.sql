-- Objects a render stopped naming, whose release could not be queued.
--
-- The retention queue is how such objects are normally removed (after the
-- signed-URL lifetime, with the rows asked first which keys they still
-- name). It runs on Redis; when Redis cannot be reached at the moment a
-- render learns its outcome is unknown, the queued release is never made —
-- and on a job's last attempt there is no retry to make it later. This
-- table is the record that does not depend on the queue: the render writes
-- the keys here instead, and the footage sweep hands every row to the
-- queue when it next runs.
CREATE TABLE IF NOT EXISTS object_releases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keys TEXT[] NOT NULL,
  video_id UUID,
  clip_id UUID,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS object_releases_created_idx ON object_releases (created_at);
