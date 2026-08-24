-- Workspaces stop being a mode and become a place.
--
-- 018 made a workspace something you were *in*: one room active at a time,
-- switching changed every screen underneath you. The owner's read was that
-- this is more machinery than the idea needs — a workspace should work like
-- any other shared project: somewhere you navigate to, look at what is in it,
-- and send things into.
--
-- So the model is now:
--
--   Your library is yours. What you upload and what you cut stays in one
--   place that nothing else can move.
--
--   A workspace is a shared collection with people in it. You open one, see
--   the clips that have been sent there, and send more.
--
-- That removes the invisible "which room am I in" state entirely, which is
-- what made 018 hard to reason about: nothing changes under you, you just
-- navigate.

-- 1. A person's own room, marked -------------------------------------------
-- Until now a person owned exactly one workspace, enforced by a unique index
-- on owner_user_id. They can now own several — their personal library plus
-- any shared rooms they create — so the uniqueness moves to the personal one
-- alone. Every existing workspace is somebody's personal room, which is what
-- makes the backfill below correct.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS is_personal BOOLEAN NOT NULL DEFAULT false;

UPDATE workspaces SET is_personal = true WHERE is_personal = false;

-- A personal workspace has exactly one person in it: its owner. Any other
-- membership here is a leftover from the shared-everything era (017/018) on
-- a database that ran those commits — and left in place it would quietly
-- grant that person the owner's ENTIRE library, with no screen even showing
-- the owner they are there. Membership rows are the access; they go now.
-- (The clips such members had genuinely shared are preserved below as
-- explicit workspace_clips shares — access to what was shared, never to the
-- whole room.)
DELETE FROM workspace_members m
 USING workspaces w
 WHERE w.id = m.workspace_id
   AND w.is_personal
   AND m.user_id <> w.owner_user_id;

-- The same for invitations still open against a now-personal workspace: an
-- accept after this point would recreate exactly the stale membership the
-- delete above removes.
UPDATE workspace_invites i
   SET revoked_at = now()
  FROM workspaces w
 WHERE w.id = i.workspace_id
   AND w.is_personal
   AND i.accepted_at IS NULL
   AND i.revoked_at IS NULL;

DROP INDEX IF EXISTS workspaces_owner_idx;
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_personal_owner_idx
    ON workspaces (owner_user_id) WHERE is_personal;

-- 2. The share itself -------------------------------------------------------
-- A clip in a workspace is a share, not a move: the clip stays in the
-- library of whoever cut it and ALSO appears in the room. Sending is not
-- supposed to cost you the thing you sent.
CREATE TABLE IF NOT EXISTS workspace_clips (
    workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    clip_id      UUID NOT NULL REFERENCES clips (id) ON DELETE CASCADE,
    shared_by    TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, clip_id)
);

CREATE INDEX IF NOT EXISTS workspace_clips_recent_idx
    ON workspace_clips (workspace_id, created_at DESC);

-- 3. Every clip made before this belongs to the library that made it --------
-- 018 stamped clips with the room they were made in. With rooms no longer a
-- mode, a clip's workspace_id is simply where its maker's library lives, and
-- anything that was shared with a team is re-expressed as an explicit share
-- so nothing a team could already see disappears from under them.
INSERT INTO workspace_clips (workspace_id, clip_id, shared_by)
SELECT c.workspace_id, c.id, COALESCE(c.user_id, w.owner_user_id)
  FROM clips c
  JOIN workspaces w ON w.id = c.workspace_id
 WHERE c.workspace_id IS NOT NULL
   AND w.owner_user_id IS DISTINCT FROM c.user_id
ON CONFLICT DO NOTHING;

-- The same for videos a teammate could already see: their maker's library is
-- about to become the only place they live, so anything a team was relying on
-- is preserved as an explicit share of its clips above. Videos themselves are
-- not shared — a room holds clips, which is what the owner asked for.

-- 4. The personal scope is a person's own room ------------------------------
-- No active-workspace pointer any more: "mine" is the workspace I own, which
-- is created for me on first sign-in and never changes. The table goes so
-- that no code can read a stale answer out of it.
DROP TABLE IF EXISTS workspace_active;

-- Videos, clips and questions keep their workspace_id: it now means "the
-- library this belongs to", which for every row is its maker's own room.
UPDATE videos v
   SET workspace_id = w.id
  FROM workspaces w
 WHERE w.owner_user_id = v.user_id AND v.user_id IS NOT NULL AND v.workspace_id IS DISTINCT FROM w.id;

UPDATE clips c
   SET workspace_id = w.id
  FROM workspaces w
 WHERE w.owner_user_id = c.user_id AND c.user_id IS NOT NULL AND c.workspace_id IS DISTINCT FROM w.id;

UPDATE clip_requests r
   SET workspace_id = w.id
  FROM workspaces w
 WHERE w.owner_user_id = r.user_id AND r.user_id IS NOT NULL AND r.workspace_id IS DISTINCT FROM w.id;
