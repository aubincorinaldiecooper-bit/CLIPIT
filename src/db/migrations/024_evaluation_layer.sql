-- The evaluation layer: who produced each moment, what the person did with
-- it, and what the work cost.
--
-- Three questions this schema exists to answer with rows rather than claims:
-- whether the moments we surface are useful (feedback), how far our clip
-- boundaries sit from the boundaries the creator actually wants (predicted
-- vs final), and what analysing an hour of source video costs (usage).
--
-- Nothing here is backfilled with guesses. History that never recorded a
-- fact stays NULL and is reported as unsegmented, not invented.

-- Which call produced this moment. Feedback on a match is only evidence
-- about a model if the row says which model — until now it didn't, so a
-- thumbs-down could never be pinned on MiniCPM or Qwen specifically.
-- prompt_version is a content hash of the prompt that asked: a wording
-- change and a model change must be tellable apart after the fact.
ALTER TABLE clip_matches
    ADD COLUMN IF NOT EXISTS provider TEXT,
    ADD COLUMN IF NOT EXISTS model TEXT,
    ADD COLUMN IF NOT EXISTS prompt_version TEXT;

-- Why a moment was waved away, when the person cared to say. Optional on
-- purpose: the interaction stays two buttons, and a reason arrives only
-- after a rejection. 'missed_moment' is the one that matters most — it is
-- the closest thing a live product has to a recall signal.
ALTER TABLE clip_matches
    ADD COLUMN IF NOT EXISTS feedback_reason TEXT
        CHECK (feedback_reason IS NULL OR feedback_reason IN
            ('wrong_moment', 'missed_moment', 'bad_start', 'bad_end',
             'bad_boundaries', 'not_relevant', 'duplicate', 'low_quality', 'other'));

-- The prediction, frozen at generation time. clips.start/end become the
-- FINAL boundaries the moment editing exists, so the original prediction
-- needs its own columns that nothing ever updates. Boundary error is
-- final minus predicted, and its sign is the finding: "starts 2.4s too
-- late" is actionable in a way a confidence score never was.
ALTER TABLE clips
    ADD COLUMN IF NOT EXISTS predicted_start_seconds NUMERIC(12, 3),
    ADD COLUMN IF NOT EXISTS predicted_end_seconds   NUMERIC(12, 3),
    ADD COLUMN IF NOT EXISTS boundaries_edited_at    TIMESTAMPTZ;

-- Historical clips: the true prediction lives on the match row, which has
-- always been immutable, so copying it here fabricates nothing. Clip bounds
-- may have included padding in old configurations; the match bounds are what
-- the model actually said.
UPDATE clips c
   SET predicted_start_seconds = m.global_start_seconds,
       predicted_end_seconds   = m.global_end_seconds
  FROM clip_matches m
 WHERE m.id = c.clip_match_id
   AND c.predicted_start_seconds IS NULL;

-- What the provider measured about its own work, verbatim. Modal's analyze
-- returns download_ms / inference_ms / total_ms; kept as JSONB because the
-- deployment owns that shape and adding a GPU-seconds field there must not
-- need a migration here. started_at gives the worker its own wall clock —
-- created_at records completion. prompt_version mirrors clip_matches so
-- cost can be segmented the same way quality is.
ALTER TABLE model_usage
    ADD COLUMN IF NOT EXISTS metrics        JSONB,
    ADD COLUMN IF NOT EXISTS started_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS prompt_version TEXT;

-- The configuration a video was read under: chunk seconds, proxy fps and
-- height, provider, model, prompt version. Settings change; what a number
-- meant is only recoverable if the row says what was set when it was
-- written. One JSONB snapshot at read time, never updated afterwards.
ALTER TABLE videos
    ADD COLUMN IF NOT EXISTS analysis_config JSONB;
