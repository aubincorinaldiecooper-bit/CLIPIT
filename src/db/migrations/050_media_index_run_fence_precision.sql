-- A run needs an identity. A timestamp was never one.
--
-- Every write a run makes is fenced on proving it is still the current run:
-- storing windows, writing a status, and the liveness heartbeat all re-present
-- the value beginIndexRun handed them and require an exact match, so a
-- superseded worker cannot overwrite a newer run's work. Since 047 that value
-- has been `started_at` — the moment the run opened. Two things were wrong
-- with that, and only the first was obvious.
--
-- IT COULD NEVER MATCH
--
-- PostgreSQL keeps timestamptz to the microsecond. A JavaScript Date keeps
-- milliseconds, and node-postgres hands one back, so the microseconds were
-- gone before the value reached the application. `started_at = $2` compared
-- 20:49:08.441 against 20:49:08.441526. Measured against a real PostgreSQL 16:
-- 0 matches in 20 runs.
--
-- With the Media Index switched on that means every window rejected by its own
-- fence, every status write refused, every heartbeat lost — a video embedded
-- at full GPU price, storing nothing, sitting at `running` for ever. The exact
-- failure the fence and the heartbeat exist to prevent, caused by the
-- machinery meant to prevent it.
--
-- AND ROUNDING IT WOULD ONLY HAVE HIDDEN THE REST
--
-- Declaring the column TIMESTAMPTZ(3) makes the round trip lossless, and was
-- the first fix here: measured at 25 of 25. But it buys that by making the
-- identity coarser, and now() is transaction_timestamp — taken when the
-- transaction BEGINS, not when it commits. Two deliveries of the same video
-- that begin inside one millisecond would then be handed the same identity,
-- and the older one would pass every fence belonging to the newer: silently
-- overwriting its windows and its coverage. Unlikely is not the same as
-- impossible, and this fence exists precisely for the case where two runs
-- overlap.
--
-- So the identity stops being a time. run_id is a UUID minted per run,
-- compared as itself, with nothing to round and nothing to collide. A time is
-- for saying when something happened; it was never a name.
--
-- started_at stays, and stays at millisecond precision: it is still read into
-- a JavaScript Date for reporting, and a stored value that cannot survive that
-- trip is a trap whether or not anything currently steps in it.
ALTER TABLE media_index_status
    ALTER COLUMN started_at TYPE TIMESTAMPTZ(3);

ALTER TABLE media_index
    ALTER COLUMN run_started_at TYPE TIMESTAMPTZ(3);

-- Nullable, and deliberately so: rows written before this migration have no
-- run id, and inventing one would claim they belonged to a run that never
-- existed. A NULL simply loses to every fence, which is the safe direction —
-- an old row cannot masquerade as the current run. Existing windows are not
-- necessarily cleared by the next run: matching provenance is deliberately
-- retained. Reads must therefore reject rows whose run provenance is unknown.
ALTER TABLE media_index_status
    ADD COLUMN IF NOT EXISTS run_id UUID;

ALTER TABLE media_index
    ADD COLUMN IF NOT EXISTS run_id UUID;
