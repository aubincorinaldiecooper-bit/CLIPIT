-- Publishing gets its plumbing: Zernio-backed social accounts.
--
-- The design is borrowed from populr's battle-tested integration, with one
-- CLIPIT-specific decision baked into the schema: every row here belongs to
-- a signed-in USER (Better Auth id, opaque TEXT), never to a guest session.
-- A social account bound to a throwaway tab would be stranded the moment the
-- tab closed — the exact opposite of what connecting an account is for.

-- One Zernio workspace ("profile") per user, created on first use. Zernio
-- owns the id; TEXT is the honest type for an identifier another system owns.
CREATE TABLE social_profiles (
    user_id           TEXT PRIMARY KEY,
    zernio_profile_id TEXT NOT NULL UNIQUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Connected social accounts, mirrored from Zernio after each sync. The
-- primary key IS Zernio's account id — there is no CLIPIT-side identity for
-- an account beyond the row that mirrors it.
CREATE TABLE social_accounts (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    platform     TEXT NOT NULL,
    display_name TEXT,
    -- connected | disconnected | reconnect_required
    status       TEXT NOT NULL DEFAULT 'connected',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX social_accounts_user_idx ON social_accounts (user_id, platform);

-- Single-use state for the OAuth round trip. The callback arrives as a raw
-- browser redirect with no CLIPIT session on it, so the authenticated
-- connect route stores who/what/where here and threads ONLY an opaque token
-- through Zernio. Only the token's hash is ever persisted.
CREATE TABLE social_connection_states (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash  TEXT NOT NULL UNIQUE,
    user_id     TEXT NOT NULL,
    platform    TEXT NOT NULL,
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- What was actually sent to Zernio for publishing, and what came back.
-- clip_id survives clip deletion as NULL: the fact that something was
-- published is history, not something deleting a clip should erase.
CREATE TABLE published_posts (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id        TEXT NOT NULL,
    clip_id        UUID REFERENCES clips(id) ON DELETE SET NULL,
    zernio_post_id TEXT,
    caption        TEXT NOT NULL DEFAULT '',
    -- [{ platform, accountId, status, error }]
    targets        JSONB NOT NULL DEFAULT '[]',
    status         TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX published_posts_user_idx ON published_posts (user_id, created_at DESC);
