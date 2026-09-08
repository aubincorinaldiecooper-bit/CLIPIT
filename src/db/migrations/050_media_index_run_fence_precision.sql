-- The run fence compared two timestamps that could never be equal.
--
-- A run's identity is the moment it opened: beginIndexRun writes now() and
-- returns it, and every later write is fenced on matching it exactly, so a
-- superseded worker cannot overwrite a newer run's work. Three places do that
-- comparison — storing windows, writing a status, and the liveness heartbeat.
--
-- PostgreSQL stores timestamptz to the MICROSECOND. JavaScript's Date holds
-- MILLISECONDS, and node-postgres hands one back, so the microseconds are
-- gone before the value ever reaches the application. Passing that Date into
-- `started_at = $2` compares 20:49:08.441 against 20:49:08.441526, which is
-- false — not sometimes, essentially always. Measured against a real
-- PostgreSQL 16 before this migration was written: 0 matches in 20 runs.
--
-- What that meant with the Media Index switched on: every window rejected by
-- its own fence, every status write refused, every heartbeat lost. A video
-- would be embedded at full GPU price, store nothing, and sit at `running`
-- for ever — the exact failure the fence and the heartbeat exist to prevent,
-- caused by the machinery meant to prevent it. It has been latent since 047
-- and harmless only because the feature was switched off.
--
-- WHY THE COLUMN TYPE, AND NOT A ROUNDED WRITE
--
-- date_trunc('milliseconds', now()) at the one call site also matches 20 of
-- 20, and would leave a landmine: any later code writing a plain now() here
-- silently breaks the fence again, with no test able to see it because the
-- damage is invisible until something is superseded. Declaring the precision
-- on the COLUMN makes it structural — PostgreSQL rounds every write, from any
-- caller, for ever. Same reasoning as 044's octet_length check: make the bad
-- value impossible to store rather than something discovered later.
--
-- Rows already stored are rounded to the nearest millisecond in place, which
-- keeps any existing fence intact rather than shifting rows out from under it.
-- Verified against PostgreSQL 16: after the ALTER, an existing row's value
-- round-trips through a JavaScript Date and matches itself.
--
-- Millisecond resolution is ample for the job: this identifies which RUN
-- opened a row, and two runs for one video are serialised by the queue, not
-- microseconds apart.
ALTER TABLE media_index_status
    ALTER COLUMN started_at TYPE TIMESTAMPTZ(3);

-- Carried on each window so a row can say which run paid for it. Kept at the
-- same precision as the column it is copied from, so the two stay comparable.
ALTER TABLE media_index
    ALTER COLUMN run_started_at TYPE TIMESTAMPTZ(3);
