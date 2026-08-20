-- A still from each matched moment.
--
-- The alternatives list showed a timecode and a sentence, which asks the
-- reader to imagine the frame and then select it to find out. A still answers
-- the question the description was standing in for.
--
-- Nullable because a thumbnail is a convenience, never a correctness
-- requirement: a match whose frame could not be extracted is still a real
-- match with real timestamps, and must not be lost over a missing image.
ALTER TABLE clip_matches
    ADD COLUMN IF NOT EXISTS thumbnail_key TEXT;
