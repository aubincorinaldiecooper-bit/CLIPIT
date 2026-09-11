-- Retire storage that belonged only to the removed notes and Media Index systems.
-- Historical migration files remain frozen; this forward migration removes their live schema.

DROP TABLE IF EXISTS video_scenes;
DROP TABLE IF EXISTS media_index_status;
DROP TABLE IF EXISTS media_index;

ALTER TABLE videos
  DROP COLUMN IF EXISTS index_status,
  DROP COLUMN IF EXISTS index_error,
  DROP COLUMN IF EXISTS scene_count,
  DROP COLUMN IF EXISTS index_ms,
  DROP COLUMN IF EXISTS analysis_config;

ALTER TABLE clip_requests DROP COLUMN IF EXISTS notes_consulted;

-- Old attribution is not rewritten as a current system; it becomes historical/unknown.
UPDATE clip_requests SET answered_from = NULL WHERE answered_from IN ('notes', 'media_index');
UPDATE clip_requests SET retrieval_primary = NULL WHERE retrieval_primary = 'media_index';
UPDATE clip_requests SET retrieval_system = NULL WHERE retrieval_system = 'media_index';

ALTER TABLE clip_requests DROP CONSTRAINT IF EXISTS clip_requests_answered_from_check;
ALTER TABLE clip_requests
  ADD CONSTRAINT clip_requests_answered_from_check
  CHECK (answered_from IS NULL OR answered_from IN ('footage', 'simplemem'));

ALTER TABLE clip_requests DROP CONSTRAINT IF EXISTS clip_requests_retrieval_primary_check;
ALTER TABLE clip_requests DROP CONSTRAINT IF EXISTS clip_requests_retrieval_system_check;
ALTER TABLE clip_requests
  ADD CONSTRAINT clip_requests_retrieval_primary_check
  CHECK (retrieval_primary IS NULL OR retrieval_primary IN ('clipit', 'simplemem'));
ALTER TABLE clip_requests
  ADD CONSTRAINT clip_requests_retrieval_system_check
  CHECK (retrieval_system IS NULL OR retrieval_system IN ('clipit', 'simplemem'));
