-- Signed-in activity counts, served by indexes instead of table scans.
--
-- Sessions have had owner indexes since the first migration; users got them
-- on videos (013) and on playable library clips (014), but the home-screen
-- counts also walk clip_requests and clips by bare user_id — and 014's
-- partial index cannot serve those, since its predicate demands a storage
-- key the counts do not filter on. Without these, every person's home
-- screen costs as much as everyone's total activity.
CREATE INDEX IF NOT EXISTS clip_requests_user_idx ON clip_requests (user_id)
    WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS clips_user_idx ON clips (user_id)
    WHERE user_id IS NOT NULL;
