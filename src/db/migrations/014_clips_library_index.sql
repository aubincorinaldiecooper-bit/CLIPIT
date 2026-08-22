-- The library query, served by an index instead of a table scan.
--
-- Signed-in libraries filter clips by owner and walk them newest-first; the
-- partial predicates mirror the query exactly (ready, file still present), so
-- the index stays small — it holds only what the library can actually show.
CREATE INDEX IF NOT EXISTS clips_library_user_idx
    ON clips (user_id, created_at DESC)
    WHERE user_id IS NOT NULL AND status = 'ready' AND storage_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS clips_library_session_idx
    ON clips (session_id, created_at DESC)
    WHERE session_id IS NOT NULL AND status = 'ready' AND storage_key IS NOT NULL;
