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

-- A rolling deploy can briefly leave the previous worker alive after this
-- migration runs. It must not be able to publish one final transformers-5-era
-- memory as ready after we invalidated the old rows. The database is the final
-- guard: every ready memory must name the current embedding contract.
ALTER TABLE simplemem_index
  DROP CONSTRAINT IF EXISTS simplemem_index_ready_embedding_contract_check;
ALTER TABLE simplemem_index
  ADD CONSTRAINT simplemem_index_ready_embedding_contract_check
  CHECK (
    status <> 'ready'
    OR config->>'embeddingVersion' = 'v2-transformers457'
  );
