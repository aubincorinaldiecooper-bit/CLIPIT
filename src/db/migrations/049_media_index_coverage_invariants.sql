-- The coverage rules, enforced by the database rather than remembered.
--
-- Migration 044 checked only that the counters are not negative. Everything
-- that makes them MEAN anything lived in TypeScript: that more windows cannot
-- be stored than were planned, that a run cannot report a finish time it does
-- not have, that a run still going cannot already be finished.
--
-- Those are the invariants a coverage figure rests on, and coverage is what
-- decides whether a search may claim to have looked. A bug that writes an
-- impossible row does not announce itself — it produces a video that reads as
-- fully indexed, which is the exact failure the table exists to prevent. The
-- rules belong where they cannot be forgotten by the next caller.
ALTER TABLE media_index_status
    DROP CONSTRAINT IF EXISTS media_index_status_counts_sane,
    DROP CONSTRAINT IF EXISTS media_index_status_finish_sane;

ALTER TABLE media_index_status
    ADD CONSTRAINT media_index_status_counts_sane
    CHECK (windows_planned = 0 OR windows_stored <= windows_planned);

ALTER TABLE media_index_status
    ADD CONSTRAINT media_index_status_finish_sane
    -- A run that is still going has not finished. Emptying finished_at on a
    -- non-terminal state is already the rule in code; this makes a row that
    -- breaks it impossible to write at all.
    CHECK (state IN ('queued', 'running') = FALSE OR finished_at IS NULL);
