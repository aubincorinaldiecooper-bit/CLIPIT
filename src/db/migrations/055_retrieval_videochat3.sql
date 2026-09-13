-- VideoChat3 becomes a retrieval system in its own right for uploaded videos:
-- VideoChat3 watches the analysis proxy, Qwen embeds and reranks what it
-- flagged, and VideoChat3 re-opens each candidate before it is evidence. The
-- request row records it as the primary that was configured and as the
-- system that answered, alongside 'clipit' (direct per-chunk footage search)
-- and 'simplemem' (memory). answered_from is unchanged: a VideoChat3 answer
-- comes from the footage, and is recorded as such.

ALTER TABLE clip_requests DROP CONSTRAINT IF EXISTS clip_requests_retrieval_primary_check;
ALTER TABLE clip_requests DROP CONSTRAINT IF EXISTS clip_requests_retrieval_system_check;
ALTER TABLE clip_requests
  ADD CONSTRAINT clip_requests_retrieval_primary_check
  CHECK (retrieval_primary IS NULL OR retrieval_primary IN ('clipit', 'simplemem', 'videochat3'));
ALTER TABLE clip_requests
  ADD CONSTRAINT clip_requests_retrieval_system_check
  CHECK (retrieval_system IS NULL OR retrieval_system IN ('clipit', 'simplemem', 'videochat3'));
