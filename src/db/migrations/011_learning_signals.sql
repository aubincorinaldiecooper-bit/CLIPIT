-- The two facts that turn a session into a lesson.
--
-- Footage is deleted when a session ends, so what is left has to carry the
-- learning on its own. Two things were missing from it:
--
-- 1. Whether the notes were consulted at all. Without this, a question
--    answered from the footage could mean the notes were silent, or that the
--    video had no notes yet — opposite conclusions about whether reading at
--    upload is working.
--
-- 2. Which question a correction refers to. "Are you sure?" is stored as the
--    user typed it, which is right, but nothing recorded that it was a
--    correction of anything, so the strongest signal we have — a person
--    telling us our answer was wrong — was invisible after the fact.
--
-- See docs/learning-loop.md.
ALTER TABLE clip_requests
    ADD COLUMN IF NOT EXISTS notes_consulted BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS corrected_request_id UUID REFERENCES clip_requests (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS clip_requests_learning_idx
    ON clip_requests (created_at DESC)
    WHERE status = 'completed';
