-- A third way a question can be answered.
--
-- Until now there were two: the notes taken at upload, and re-reading the
-- footage. The Media Index is a third kind of memory — vectors of what the
-- pictures look like — and it is not either of the other two. Recording it as
-- 'notes' would make it invisible in exactly the comparison it was built to
-- support: whether asking the vectors first finds moments the notes miss, and
-- how often it hands the question on instead.
--
-- Migration 008 wrote CHECK (answered_from IN ('notes', 'footage')). Inserting
-- a third value against that constraint does not degrade gracefully; it is
-- rejected. Migration 027 is the standing reminder of what that costs when it
-- is discovered late — every insert refused, every warning swallowed, and a
-- report computed from rows that were never written.
ALTER TABLE clip_requests DROP CONSTRAINT IF EXISTS clip_requests_answered_from_check;
ALTER TABLE clip_requests
    ADD CONSTRAINT clip_requests_answered_from_check
    CHECK (answered_from IS NULL OR answered_from IN ('notes', 'footage', 'media_index'));
