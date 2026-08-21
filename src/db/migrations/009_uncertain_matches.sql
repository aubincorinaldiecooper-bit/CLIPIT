-- Moments the model reported and we discarded for being under our confidence
-- threshold.
--
-- Until now these were logged for us and never mentioned to the user, so a
-- search that found something borderline reported the same "nothing matched"
-- as a search that found nothing at all. That is the one failure a person
-- cannot tell apart from their video genuinely not containing the moment —
-- and unlike an unsearched chunk, here we know the moment is there.
--
-- Kept on the request rather than in clip_matches on purpose: these are not
-- results. They are not generated into clips, not counted, not ranked. They
-- exist so the answer can say "I saw something at 04:12 I wasn't sure about"
-- instead of claiming an absence.
ALTER TABLE clip_requests
    ADD COLUMN IF NOT EXISTS uncertain_matches JSONB NOT NULL DEFAULT '[]'::jsonb;
