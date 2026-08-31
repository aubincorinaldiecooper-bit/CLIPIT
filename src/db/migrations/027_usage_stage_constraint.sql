-- Re-clip cost rows have been silently discarded since the Re-clip feature
-- shipped.
--
-- Migration 003 wrote CHECK (stage IN ('transcription','indexing','search',
-- 'verification')). The Re-clip work added 'reclip' to the TypeScript
-- UsageStage union and never widened this constraint. recordModelUsage
-- catches its own errors and logs a warning, so every insert has been
-- rejected by Postgres and dropped without anyone noticing.
--
-- The visible consequence: the evaluation page's re-clip cost share has been
-- computed from zero rows. It reported an absence that was never measured,
-- which is the failure this codebase names first.
--
-- 'verification' is retained — it predates this and removing a value is not
-- this fix's business. 'composition' is added ahead of the post-ready media
-- work so that branch does not need its own constraint migration.
ALTER TABLE model_usage DROP CONSTRAINT IF EXISTS model_usage_stage_check;
ALTER TABLE model_usage
    ADD CONSTRAINT model_usage_stage_check
    CHECK (stage IN ('transcription', 'indexing', 'search', 'verification', 'reclip', 'composition'));
