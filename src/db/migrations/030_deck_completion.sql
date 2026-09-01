-- Whether a request owes a post-ready deck, and whether that deck stands.
--
-- The product rule is SET-level, not card-level: a creator who asks for three
-- postable moments sees nothing at all until all three are finished, and then
-- sees them together. Never one, then two, then three as they poll.
--
-- Card-level filtering cannot deliver that. A client polling while the deck
-- assembles would watch finished clips appear one at a time, which is exactly
-- the building-in-public experience the rule forbids. The decision has to be
-- made for the whole request, and it has to survive a process restart, a
-- second API instance, and a worker that died mid-deck — so it lives here,
-- in the row, rather than in the memory of whichever process happened to
-- assemble it.
ALTER TABLE clip_requests
    -- What this request owes. Written by the worker once the instruction is
    -- resolved and BEFORE any candidate is rendered, so there is no window
    -- where a clip is ready and the reader does not yet know the request is a
    -- deck request. NULL means a request from before this existed, and is
    -- treated as 'original' — the legacy path, unchanged.
    ADD COLUMN IF NOT EXISTS presentation_target TEXT
        CHECK (presentation_target IS NULL OR presentation_target IN ('original', 'vertical')),

    -- What the creator asked for, exactly as they asked for it. Kept apart
    -- from the target below because the difference is the whole point: asking
    -- for three and being offered two is a fact about their video, and it
    -- must be legible as that rather than as a failure.
    ADD COLUMN IF NOT EXISTS requested_result_count INTEGER,

    -- How many eligible moments the search actually found for this platform.
    ADD COLUMN IF NOT EXISTS available_candidate_count INTEGER,

    -- The deck actually being assembled: min(requested, available). Atomicity
    -- applies to THIS number. Two moments released together is a complete
    -- answer when two is all there was.
    ADD COLUMN IF NOT EXISTS effective_deck_target INTEGER,

    -- The gate. Set only when the whole effective deck is finished and
    -- persisted; cleared whenever a deck is (re)planned, so a retry cannot
    -- serve a stale complete deck while it rebuilds. Null while assembling
    -- AND after a failure — a creator sees nothing in both cases, because in
    -- both cases there is no finished set to show.
    ADD COLUMN IF NOT EXISTS deck_completed_at TIMESTAMPTZ;
