-- A proxy a person can watch.
--
-- The only proxy so far is the analysis one: 360p, two frames a second, no
-- audio — built for a model, not for a person. Candidate thumbnails were cut
-- from it at 320px wide, and the review cards played the ORIGINAL (a 4K file,
-- in the browser) or nothing. This key points at a second, watchable proxy:
-- 720 lines, real frame rate, with sound. Thumbnails come from it; review
-- playback comes from it; the original is downloaded for a cut and nothing
-- else.
ALTER TABLE videos
    ADD COLUMN IF NOT EXISTS playback_storage_key TEXT;
