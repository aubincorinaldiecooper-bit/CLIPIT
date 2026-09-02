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
-- Only digests are stored — of the token, and of the address the link was
-- sent to, which is the one sign-in the claim will answer: a link forwarded
-- to somebody else signs them in as themselves and carries nothing. A
-- hand-over is redeemed at most once, inside the same transaction that
-- moves the work, by the server-to-server exchange that already guards
-- adoption. Rows go with their session.
CREATE TABLE IF NOT EXISTS session_handoffs (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    token_hash  TEXT        NOT NULL UNIQUE,
    email_hash  TEXT        NOT NULL,
    session_id  UUID        NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL,
    redeemed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS session_handoffs_expires_idx ON session_handoffs (expires_at);
CREATE INDEX IF NOT EXISTS session_handoffs_session_idx ON session_handoffs (session_id);
