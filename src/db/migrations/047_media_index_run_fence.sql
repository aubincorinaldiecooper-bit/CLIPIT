-- Which attempt wrote this window.
--
-- Two indexing runs for one video can overlap — a job that stalls and is
-- redelivered while the original is still working, most obviously. Both write
-- the same window keys, and without a way to tell them apart the older one
-- can overwrite rows the newer one already stored. The read filter then hides
-- those rows, because they carry the older run's identity, while the newer
-- run goes on reporting complete coverage. A video that reads as fully
-- indexed, and is not.
--
-- The run's start time is its identity. It is already stamped on the status
-- row when a run opens, so a write can ask whether the run it belongs to is
-- still the current one and store nothing if it is not.
ALTER TABLE media_index
    ADD COLUMN IF NOT EXISTS run_started_at TIMESTAMPTZ;
