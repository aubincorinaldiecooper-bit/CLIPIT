-- Teams arrive: a workspace is the room the work happens in.
--
-- Until now everything belonged to one person: videos, clips, and the
-- connected social accounts were reachable by exactly one user_id. A team
-- means those become shared, and the decision taken with the owner is the
-- simplest one — a workspace shares EVERYTHING. Members see the same library
-- and publish to the same connected accounts.
--
-- The shape deliberately leaves every existing user_id column alone. Rows
-- stay attributed to the person who made them (who cut this clip is worth
-- knowing), and access is granted by asking a second question: is that person
-- in my workspace? That keeps this migration cheap, reversible, and free of a
-- backfill that would rewrite every row in the database.
--
-- One workspace per user, enforced by a UNIQUE on member user_id. With
-- "everything shared", belonging to two rooms at once would make "my library"
-- ambiguous — and an ambiguous answer to "who can see this footage" is the
-- kind of thing that must be decided deliberately, not discovered later.

CREATE TABLE IF NOT EXISTS workspaces (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    owner_user_id TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The owner's own workspace is created on first sign-in; one per person.
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_owner_idx ON workspaces (owner_user_id);

CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    user_id      TEXT NOT NULL,
    -- 'owner' invites, removes, and cannot be removed; 'member' works.
    role         TEXT NOT NULL DEFAULT 'member',
    -- Kept here so the team list can name people without this service ever
    -- reading Better Auth's tables. It is what they were invited as, or what
    -- they signed in with.
    email        TEXT,
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id)
);

-- One workspace per person: see the header.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members (user_id);

CREATE TABLE IF NOT EXISTS workspace_invites (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id   UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
    email          TEXT NOT NULL,
    -- Only the hash is stored. The raw token exists in the invite email and
    -- nowhere else, so a database read cannot be replayed as an invitation.
    token_hash     TEXT NOT NULL UNIQUE,
    invited_by     TEXT NOT NULL,
    expires_at     TIMESTAMPTZ NOT NULL,
    accepted_at    TIMESTAMPTZ,
    accepted_by    TEXT,
    revoked_at     TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_invites_pending_idx
    ON workspace_invites (workspace_id, created_at DESC)
    WHERE accepted_at IS NULL AND revoked_at IS NULL;
