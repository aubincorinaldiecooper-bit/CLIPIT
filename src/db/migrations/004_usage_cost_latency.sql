-- Cost and latency on model usage.
--
-- When model_usage was added, the chat API returned reliable token counts but
-- no pricing, so cost columns were deliberately left out. The OpenRouter video
-- path returns `usage.cost` in dollars per call, which makes cost-per-video and
-- cost-per-search answerable directly instead of by inference from tokens.
--
-- Both are nullable: a provider that reports neither still records its tokens.

ALTER TABLE model_usage
    ADD COLUMN IF NOT EXISTS cost_usd   NUMERIC(12, 6),
    ADD COLUMN IF NOT EXISTS latency_ms INTEGER;
