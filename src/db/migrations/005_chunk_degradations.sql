-- Chunks searched with less evidence than intended.
--
-- A chunk a provider refuses on content-policy grounds can often be recovered
-- by retrying it without the transcript text the provider objected to. That
-- rescues the window, but it is not the search that was asked for: a spoken
-- condition cannot be checked against evidence that was not sent.
--
-- Kept separate from chunk_errors because these chunks did NOT fail — they
-- completed, they count toward chunks_completed, and folding them into the
-- failure list would inflate chunks_failed and report a recovered window as a
-- lost one. Separate from a boolean for the same reason the errors are a list:
-- the response has to name WHICH seconds were searched with less, or the
-- caveat is unactionable.
ALTER TABLE clip_requests
    ADD COLUMN IF NOT EXISTS chunk_degradations JSONB NOT NULL DEFAULT '[]'::jsonb;
