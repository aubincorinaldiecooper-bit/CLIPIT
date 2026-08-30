-- A poster frame for the video itself.
--
-- Stills existed only for clip matches — a picture of a moment somebody
-- searched for. The video library had no picture of the VIDEO, so a list of
-- uploads was a list of filenames. One frame is pulled at preprocess time,
-- from the analysis proxy that is being made anyway, so this costs one extra
-- seek rather than a second download.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS poster_storage_key TEXT;
