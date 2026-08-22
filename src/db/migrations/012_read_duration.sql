-- How long reading a video actually took.
--
-- Recorded rather than derived. It can be approximated by the span between
-- the first and last model call, but that understates it by roughly one call
-- and quietly changes meaning if the pipeline ever changes shape. A number
-- used to check whether a change helped has to be exact, because the whole
-- reason it exists is that a plausible-looking number was wrong once.
ALTER TABLE videos
    ADD COLUMN IF NOT EXISTS index_ms INTEGER;
