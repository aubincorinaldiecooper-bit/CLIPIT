-- How a question was answered.
--
-- A question answered from the notes and a question answered by re-reading
-- the footage are not the same act, and the difference matters to the person
-- reading the result: notes are a summary written at upload, and their silence
-- is not evidence of absence. Recording which one happened is what lets the
-- product say "I do not remember seeing that" rather than "that is not in your
-- video" — and lets a correction escalate from one to the other.
--
-- Null for every request that predates this column, and for any request that
-- has not finished yet.
ALTER TABLE clip_requests
    ADD COLUMN IF NOT EXISTS answered_from TEXT
        CHECK (answered_from IS NULL OR answered_from IN ('notes', 'footage'));

-- A correction ("are you sure?") has to find the question it refers to: the
-- previous request from the same person about the same video.
CREATE INDEX IF NOT EXISTS clip_requests_recent_idx
    ON clip_requests (video_id, session_id, created_at DESC);
