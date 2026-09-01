-- Two things a retried search must not be able to do.

-- 1. A superseded attempt must not open the creator-facing gate.
--
-- A stalled job is redelivered while the first run is still assembling. The
-- second run re-plans, clears the first run's matches and renders its own
-- deck. The first run — still executing, unaware it was superseded — then
-- calls markDeckComplete and opens the gate over a half-built deck. That is
-- the progressive reveal the whole set-level rule exists to forbid, arriving
-- through the one door left unlocked.
--
-- Each planning writes a fresh token; only the run holding the current token
-- may open the gate. A superseded run's update matches no row and does
-- nothing, which is exactly what it should do.
ALTER TABLE clip_requests
    ADD COLUMN IF NOT EXISTS deck_attempt_id UUID;

-- 2. Clearing a previous attempt's matches must not erase the record of it.
--
-- vertical_render_attempts.match_id cascades from clip_matches, so wiping a
-- retried attempt's matches also destroyed every attempt row belonging to it
-- — including the failures. That table exists for exactly one purpose: to
-- tell "we hid it" apart from "it was never there". Deleting its rows on a
-- retry means a pipeline that dropped candidates looks, afterwards, like a
-- video that never had them.
--
-- SET NULL rather than NO ACTION: the row survives with its stage, its code
-- and its timings intact, and only the link to a match that no longer exists
-- goes. A retained row missing one foreign key is worth far more than no row.
ALTER TABLE vertical_render_attempts
    DROP CONSTRAINT IF EXISTS vertical_render_attempts_match_id_fkey;

ALTER TABLE vertical_render_attempts
    ADD CONSTRAINT vertical_render_attempts_match_id_fkey
    FOREIGN KEY (match_id) REFERENCES clip_matches (id) ON DELETE SET NULL;
