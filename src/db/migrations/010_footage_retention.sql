-- Footage lives as long as the session that uploaded it.
--
-- A guest session ends when the browser closes: the token lives in the tab and
-- goes with it, so nobody — including the person who uploaded — can reach that
-- video again. Keeping the footage after that serves no one. It costs storage
-- forever and leaves someone's video on our disks with no way for them to take
-- it back.
--
-- What is kept is what teaches us something without being the person's video:
-- the question they asked, the moments we found, and their thumbs up or down.
-- What goes is the footage and everything derived from it — the proxy, the
-- segments, the clips, the stills, the scene notes and the transcript. Those
-- describe someone's video rather than our reading of it, and without the
-- footage they cannot be checked against anything anyway.
--
-- When accounts arrive this changes shape: a logged-in person's video should
-- outlive their browser, because there is then something to come back to.
ALTER TABLE videos
    ADD COLUMN IF NOT EXISTS footage_expired_at TIMESTAMPTZ;

-- The sweep looks for videos whose session has gone quiet.
CREATE INDEX IF NOT EXISTS videos_footage_live_idx
    ON videos (session_id)
    WHERE footage_expired_at IS NULL;
