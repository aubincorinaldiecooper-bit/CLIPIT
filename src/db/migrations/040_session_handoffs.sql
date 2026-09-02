-- A hand-over: a guest's claim on its own work, packed into the sign-in link.
--
-- The guest token lives in the browser tab that did the work, and nowhere
-- else by design (it dies with the tab). The magic link, though, opens
-- wherever the email is read — a new tab, a phone — where that token is not.
-- So before the link is sent, the guest asks for a hand-over: a single-use,
-- short-lived token that names its session and travels in the link's return
-- address. Whichever tab redeems it, the account signing in takes over the
-- guest's work there, exactly as the same-tab path does with the token.
--
-- Only the digest is stored, like a session token: a database leak hands out
-- nothing usable. A hand-over is redeemed at most once, and only by the
-- server-to-server exchange that already guards adoption.
CREATE TABLE IF NOT EXISTS session_handoffs (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash  TEXT        NOT NULL UNIQUE,
    session_id  UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    redeemed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS session_handoffs_expires_idx ON session_handoffs (expires_at);
