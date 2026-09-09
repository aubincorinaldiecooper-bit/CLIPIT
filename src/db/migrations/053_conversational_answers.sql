-- The grounded response shown in chat. Retrieval evidence remains in
-- clip_matches; this stores exactly how Qwen Flash explained that evidence.
ALTER TABLE clip_requests
    ADD COLUMN IF NOT EXISTS answer_text TEXT,
    ADD COLUMN IF NOT EXISTS answer_citations JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS answer_provider TEXT,
    ADD COLUMN IF NOT EXISTS answer_model TEXT,
    ADD COLUMN IF NOT EXISTS answer_prompt_version TEXT;

ALTER TABLE clip_requests DROP CONSTRAINT IF EXISTS clip_requests_answer_citations_array_check;
ALTER TABLE clip_requests
    ADD CONSTRAINT clip_requests_answer_citations_array_check
    CHECK (jsonb_typeof(answer_citations) = 'array');

ALTER TABLE model_usage DROP CONSTRAINT IF EXISTS model_usage_stage_check;
ALTER TABLE model_usage
    ADD CONSTRAINT model_usage_stage_check
    CHECK (stage IN ('transcription', 'indexing', 'search', 'verification', 'reclip',
                     'composition', 'embedding', 'rerank', 'answer'));
