-- Which video these vectors are actually of.
--
-- The resume key was model, weights revision, dimensions and index version.
-- All four can be identical across a video being REPLACED: the analysis proxy
-- lives at a deterministic key, re-processing overwrites the same object, and
-- the window keys are seconds on a timeline, so they collide too. An index run
-- against the new footage would keep every old window it did not reach and
-- serve it as though it described the new video. Nothing downstream could
-- notice — the vectors are well formed, correctly sized, attached to real
-- timestamps, and about footage that no longer exists.
--
-- So the source's content tag joins the key. It changes when the bytes change,
-- which is exactly the property needed, and it is the same identity the remote
-- container caches its download under.
--
-- Existing rows get '' and will therefore be cleared by the next run rather
-- than trusted. That is the safe direction: re-embedding costs money, and
-- serving somebody the wrong video costs more.
ALTER TABLE media_index
    ADD COLUMN IF NOT EXISTS source_identity TEXT NOT NULL DEFAULT '';

ALTER TABLE media_index_status
    ADD COLUMN IF NOT EXISTS source_identity TEXT NOT NULL DEFAULT '';
