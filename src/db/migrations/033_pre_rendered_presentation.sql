-- Every found moment is now cut before anyone reviews it, whatever framing
-- the question asked for. A clip row therefore has to say WHICH deliverable
-- it was made for: the canonical cut itself ('original') or a 9:16 derivative
-- of it ('vertical').
--
-- Until now only vertical moments were pre-rendered, so pre_rendered alone
-- said which pipeline made a row. A pre-rendered original clip has no
-- derivative on purpose, and without this column it would read as a vertical
-- moment whose derivative went missing — unkeepable, and hidden from the
-- creator who was just shown it.
ALTER TABLE clips
    ADD COLUMN IF NOT EXISTS presentation TEXT
        CHECK (presentation IS NULL OR presentation IN ('original', 'vertical'));

-- Every pre-rendered row before this migration was made by the vertical
-- pipeline, so the backfill states a fact rather than guessing one. Rows cut
-- on demand (pre_rendered = FALSE) are left null: their deliverable was
-- always the canonical file and nothing reads the column for them.
UPDATE clips SET presentation = 'vertical' WHERE pre_rendered = TRUE AND presentation IS NULL;
