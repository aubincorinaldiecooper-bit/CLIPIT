-- The previous SimpleMem image-vector contract could silently create ready
-- memories with empty visual embeddings under transformers 5.x. Those rows
-- must never survive the dependency fix as trusted memory.
UPDATE simplemem_index
   SET status = 'failed',
       error = 'reindex required: SimpleMem embedding contract v2-transformers457',
       config = COALESCE(config, '{}'::jsonb) || jsonb_build_object(
         'reindexRequired', 'v2-transformers457',
         'previousEmbeddingVersion', COALESCE(config->>'embeddingVersion', 'unknown')
       ),
       updated_at = now()
 WHERE status IN ('ready', 'queued', 'running');
