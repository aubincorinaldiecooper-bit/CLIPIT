-- The file the row named BEFORE an unknown render's attempt.
--
-- Settling an unknown render (see settleUnknownRender) proves "the write
-- landed" by the row naming the render's file — which proves it only when
-- that file is NEW to the row. A first render retried at the plain key a
-- failed earlier attempt already left on the row proves nothing by its key;
-- there the row's status is the evidence. 035 shipped without this column,
-- so it arrives on its own.
ALTER TABLE unknown_renders ADD COLUMN IF NOT EXISTS previous_storage_key TEXT;
