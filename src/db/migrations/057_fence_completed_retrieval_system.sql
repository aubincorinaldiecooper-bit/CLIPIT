-- A superseded worker can finish its expensive model call after a newer
-- delivery has already released the answer. recordRetrievalOutcome historically
-- updates by request id only, so that stale write could relabel the winning
-- answer. Once a request is completed, the system that produced its released
-- evidence is immutable. releaseDeckAndComplete already writes that value in
-- the same fenced statement that opens the deck.
CREATE OR REPLACE FUNCTION preserve_completed_retrieval_system()
RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'completed'
     AND OLD.retrieval_system IS NOT NULL
     AND NEW.retrieval_system IS DISTINCT FROM OLD.retrieval_system THEN
    NEW.retrieval_system := OLD.retrieval_system;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clip_requests_preserve_completed_retrieval_system ON clip_requests;
CREATE TRIGGER clip_requests_preserve_completed_retrieval_system
BEFORE UPDATE ON clip_requests
FOR EACH ROW
EXECUTE FUNCTION preserve_completed_retrieval_system();
