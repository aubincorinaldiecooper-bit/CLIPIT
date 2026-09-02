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
