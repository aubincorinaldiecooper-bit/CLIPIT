-- The Media Index joins the comparison.
--
-- Migration 043 recorded which of two systems answered a question and why the
-- other did not, so "how often did the primary hand the question on, why, and
-- did the fallback do better" could be read from rows instead of guessed. It
-- allowed two systems, because there were two.
--
-- There are now three, and the third is the one actually being adopted. Its
-- refusals were being written to the log and nowhere else — so the comparison
-- the columns exist for could not be made about the very system they now
-- matter most for. A reason that lives only in a log line is not a record.
--
-- The fallback_reason column is deliberately unconstrained text and needs no
-- change: the reasons differ per system and enumerating them here would mean
-- a migration every time one is added.
ALTER TABLE clip_requests DROP CONSTRAINT IF EXISTS clip_requests_retrieval_primary_check;
ALTER TABLE clip_requests DROP CONSTRAINT IF EXISTS clip_requests_retrieval_system_check;
ALTER TABLE clip_requests
    ADD CONSTRAINT clip_requests_retrieval_primary_check
    CHECK (retrieval_primary IS NULL OR retrieval_primary IN ('clipit', 'simplemem', 'media_index'));
ALTER TABLE clip_requests
    ADD CONSTRAINT clip_requests_retrieval_system_check
    CHECK (retrieval_system IS NULL OR retrieval_system IN ('clipit', 'simplemem', 'media_index'));
