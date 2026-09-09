-- Omni-SimpleMem can now finish a request directly. Keep the evidence source
-- distinct from Clipit's upload-time notes and native Media Index so retrieval
-- experiments describe the path that actually produced the moments.
ALTER TABLE clip_requests DROP CONSTRAINT IF EXISTS clip_requests_answered_from_check;
ALTER TABLE clip_requests
    ADD CONSTRAINT clip_requests_answered_from_check
    CHECK (answered_from IS NULL OR answered_from IN ('notes', 'footage', 'media_index', 'simplemem'));
