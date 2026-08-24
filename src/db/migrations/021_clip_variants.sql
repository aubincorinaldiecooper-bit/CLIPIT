-- Platform shapes: the same moment, cut to the frame each platform wants.
--
-- A clip is stored as it was shot. That is the wrong shape for most places
-- it will be posted: a 16:9 concert clip letterboxes on Reels, TikTok and
-- Shorts, and posting it anyway means bars or someone else's automatic
-- centre crop deciding what matters.
--
-- So a clip gains two things.
--
-- 1. WHERE TO LOOK (clips.focus_pct). The subject is rarely dead centre, and
--    a crop that assumes it is will cut the interview subject out of frame.
--    One number, remembered per clip, used by every shape: the % position
--    along the axis being cut. 50 until someone moves it.
--
-- 2. THE SHAPES THEMSELVES (clip_variants). Each is a real rendered file,
--    cut from the pristine original with the crop applied and the clip's
--    captions drawn on the CROPPED frame. They are made on demand, when a
--    publish needs one, and kept — because most clips never go to most
--    platforms, and pre-rendering every shape would spend render time and
--    storage on files nobody asks for.
--
-- The variant is identified by (clip, aspect, focus): move the framing and
-- the old variant no longer matches, so the next publish renders a fresh one
-- rather than posting a crop the user has already rejected.

ALTER TABLE clips ADD COLUMN IF NOT EXISTS focus_pct REAL NOT NULL DEFAULT 50;

CREATE TABLE IF NOT EXISTS clip_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clip_id UUID NOT NULL REFERENCES clips (id) ON DELETE CASCADE,
  -- '9:16', '1:1', '4:5', '16:9'. Never 'source': that is the clip itself.
  aspect TEXT NOT NULL,
  -- The framing this file was cut with. Kept on the row so a variant can be
  -- matched exactly, and so a stale one is visibly stale.
  focus_pct REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT,
  storage_key TEXT,
  width INTEGER,
  height INTEGER,
  size_bytes BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One file per shape per framing. The partial index lets a superseded
-- framing's row linger harmlessly while the current one is unique.
CREATE UNIQUE INDEX IF NOT EXISTS clip_variants_shape_idx
  ON clip_variants (clip_id, aspect, focus_pct);

CREATE INDEX IF NOT EXISTS clip_variants_clip_idx ON clip_variants (clip_id);
