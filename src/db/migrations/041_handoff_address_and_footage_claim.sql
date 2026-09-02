-- The hand-over answers one address. (040 is the hand-over itself.)
--
-- 040 shipped a claim any sign-in could spend: whoever redeemed it took the
-- guest's work (Devin, #87). A digest of the address the link was sent to
-- now travels with the claim, and redemption checks it. Rows from before
-- this column carry '' and so match no address; none were ever issued into
-- a link — the frontend half had not shipped — and they expire within the
-- hour regardless.
ALTER TABLE session_handoffs ADD COLUMN IF NOT EXISTS email_hash TEXT NOT NULL DEFAULT '';

-- The per-session sweep on every request walks this.
CREATE INDEX IF NOT EXISTS session_handoffs_session_idx ON session_handoffs (session_id);

-- A footage removal in progress is its own state.
--
-- Removal now begins by claiming the video, so that a sign-in landing while
-- the sweep is deleting cannot adopt a video whose footage is going. One
-- timestamp cannot mean both "being removed" and "removed" (Devin, #88): a
-- claim that a killed process never gave back looked exactly like a finished
-- removal, and was hidden from every later sweep with its objects still
-- stored. So the claim lives here, the completion stays in footage_expired_at,
-- and a claim older than an hour with no completion is abandoned and taken
-- over by the next removal.
ALTER TABLE videos ADD COLUMN IF NOT EXISTS footage_claimed_at TIMESTAMPTZ;

-- The sweep looks for abandoned claims; live ones are few and brief.
CREATE INDEX IF NOT EXISTS videos_footage_claimed_idx
    ON videos (footage_claimed_at)
    WHERE footage_claimed_at IS NOT NULL;
