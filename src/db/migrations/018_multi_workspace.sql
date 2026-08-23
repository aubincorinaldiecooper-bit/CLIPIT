-- Workspaces become what an invitation to a project usually means: you can
-- be in several, and you switch between them.
--
-- Migration 017 allowed exactly one workspace per person, and paid for it
-- with a rule nobody expects — someone already on a team had to be removed
-- from it before they could accept another invitation. That was the owner's
-- call to overturn, and they did.
--
-- Belonging to several rooms forces the change 017 avoided. While each person
-- had one workspace, "whose is this row" and "which workspace is this row in"
-- were the same question, so user_id alone could answer both. They are not
-- the same question any more: a person in two workspaces would otherwise drag
-- every video they own into both libraries. Work is therefore stamped with
-- the workspace it was made in.
--
-- The backfill is unambiguous precisely because it happens now: every
-- existing person is still in exactly one workspace, so there is exactly one
-- right answer for every existing row.

-- 1. Many memberships per person -------------------------------------------
DROP INDEX IF EXISTS workspace_members_user_idx;
CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members (user_id);

-- 2. The room a person is currently working in ------------------------------
-- Which workspace a person is looking at right now. One row per person; the
-- switcher moves it. Everything they create lands in this workspace, and
-- their library shows this workspace.
CREATE TABLE IF NOT EXISTS workspace_active (
    user_id      TEXT PRIMARY KEY,
    workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO workspace_active (user_id, workspace_id)
SELECT user_id, workspace_id FROM workspace_members
ON CONFLICT (user_id) DO NOTHING;

-- 3. Stamp work with the workspace it was made in ---------------------------
ALTER TABLE videos          ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces (id) ON DELETE SET NULL;
ALTER TABLE clips           ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces (id) ON DELETE SET NULL;
ALTER TABLE clip_requests   ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces (id) ON DELETE SET NULL;
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces (id) ON DELETE SET NULL;
ALTER TABLE published_posts ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces (id) ON DELETE SET NULL;

-- Guest rows keep a NULL workspace and stay owned by their session, exactly
-- as before: a workspace belongs to signed-in people.
UPDATE videos v
   SET workspace_id = m.workspace_id
  FROM workspace_members m
 WHERE v.user_id = m.user_id AND v.workspace_id IS NULL;

UPDATE clips c
   SET workspace_id = m.workspace_id
  FROM workspace_members m
 WHERE c.user_id = m.user_id AND c.workspace_id IS NULL;

UPDATE clip_requests r
   SET workspace_id = m.workspace_id
  FROM workspace_members m
 WHERE r.user_id = m.user_id AND r.workspace_id IS NULL;

UPDATE social_accounts a
   SET workspace_id = m.workspace_id
  FROM workspace_members m
 WHERE a.user_id = m.user_id AND a.workspace_id IS NULL;

UPDATE published_posts p
   SET workspace_id = m.workspace_id
  FROM workspace_members m
 WHERE p.user_id = m.user_id AND p.workspace_id IS NULL;

-- An OAuth round-trip must land the account in the room it was started from,
-- not wherever the person happens to be by the time they come back. The
-- workspace is recorded when the state token is minted, alongside the user.
ALTER TABLE social_connection_states
    ADD COLUMN IF NOT EXISTS workspace_id UUID REFERENCES workspaces (id) ON DELETE CASCADE;

UPDATE social_connection_states s
   SET workspace_id = m.workspace_id
  FROM workspace_members m
 WHERE s.user_id = m.user_id AND s.workspace_id IS NULL;

-- The library, the home counts and the accounts list all read by workspace.
CREATE INDEX IF NOT EXISTS videos_workspace_idx ON videos (workspace_id, created_at DESC)
    WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS clips_workspace_idx ON clips (workspace_id, created_at DESC)
    WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS clip_requests_workspace_idx ON clip_requests (workspace_id)
    WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS social_accounts_workspace_idx ON social_accounts (workspace_id)
    WHERE workspace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS published_posts_workspace_idx ON published_posts (workspace_id, created_at DESC)
    WHERE workspace_id IS NOT NULL;
