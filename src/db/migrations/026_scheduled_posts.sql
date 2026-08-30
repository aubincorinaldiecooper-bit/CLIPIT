-- Scheduled publishing and clip renaming.
--
-- A scheduled post is a promise: "this clip goes out at 6:00 PM". The promise
-- lives here, not only in the queue — Redis is a delivery mechanism, and the
-- database is the record of what was promised, whether it was kept, and why
-- not when it wasn't. Nothing external happens at scheduling time; the
-- submission runs at the chosen minute through the same path an immediate
-- publish uses.
CREATE TABLE scheduled_posts (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      TEXT NOT NULL,
    workspace_id TEXT NOT NULL,
    -- CASCADE, not SET NULL: a scheduled post for a clip that no longer
    -- exists could only ever fire into a failure, and keeping it would make
    -- "delete the clip" quietly not mean what it says.
    clip_id      UUID NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    caption      TEXT NOT NULL DEFAULT '',
    -- The account ids chosen at scheduling time. Re-validated at fire time:
    -- an account disconnected in between fails the fire with a reason, it
    -- does not post to a stranger's reconnected slot.
    account_ids  JSONB NOT NULL DEFAULT '[]',
    scheduled_at TIMESTAMPTZ NOT NULL,
    -- waiting -> firing -> fired | failed; waiting -> canceled.
    status       TEXT NOT NULL DEFAULT 'waiting',
    error        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- When the fire was claimed; lets a claim stuck in 'firing' (process
    -- death mid-fire) be reclaimed after a quarantine instead of never.
    claimed_at   TIMESTAMPTZ,
    fired_at     TIMESTAMPTZ
);

CREATE INDEX scheduled_posts_user_idx ON scheduled_posts (user_id, scheduled_at);
CREATE INDEX scheduled_posts_due_idx ON scheduled_posts (status, scheduled_at);

-- A name of the person's own choosing. Nullable on purpose: absent, a clip
-- keeps being named by its moment's description, exactly as today.
ALTER TABLE clips ADD COLUMN IF NOT EXISTS title TEXT;
