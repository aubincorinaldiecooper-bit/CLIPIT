-- Captions on clips: text laid over the footage, styled, and burned in.
--
-- The editor writes a caption SPEC (what to draw: text, font, size, colour,
-- position) and the worker renders it by re-cutting the clip from the
-- pristine original with the text drawn on. Because every render starts from
-- the source, editing again never stacks text on text, and "replace" is
-- repeatable for as long as the source footage exists.
--
-- Two outcomes, the owner's words: "save new clip" and "replace existing
-- one". A replace re-renders in place. A save-as-new creates a DERIVED clip —
-- same moment, same match, its own file — which breaks the old rule that a
-- match has exactly one clip. That rule existed to keep generation
-- idempotent, so it narrows rather than disappears: still exactly one
-- ORIGINAL clip per match, any number of derived ones.

ALTER TABLE clips ADD COLUMN IF NOT EXISTS captions JSONB;
ALTER TABLE clips ADD COLUMN IF NOT EXISTS derived_from_clip_id UUID REFERENCES clips (id) ON DELETE SET NULL;

-- The uniqueness moves from the column to the originals alone.
ALTER TABLE clips DROP CONSTRAINT IF EXISTS clips_clip_match_id_key;
DROP INDEX IF EXISTS clips_clip_match_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS clips_original_per_match_idx
    ON clips (clip_match_id)
    WHERE derived_from_clip_id IS NULL;
