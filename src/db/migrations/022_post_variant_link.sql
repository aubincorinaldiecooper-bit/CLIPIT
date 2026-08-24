-- A post records WHICH render it is waiting on.
--
-- Without this link a publish that arrives while another is already
-- rendering the same shape is stranded: the queue keeps the first job (one
-- render per shape is the point), and that job carries only the id of the
-- post that happened to queue it. The second post then waits for a
-- submission that never comes — progress reported for work that will never
-- reach it, which is the failure mode this codebase keeps circling.
--
-- With the link the relationship inverts: the render does not remember who
-- asked for it, it asks who is waiting. One render, every waiting post
-- submitted — or, when the render fails, every waiting post failed, visibly.
--
-- Separate from 021 deliberately. 021 is already applied in production, and
-- the runner checksums each migration and refuses to start when an applied
-- one changes: editing it would take the service down at boot rather than
-- add a column.

ALTER TABLE published_posts ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES clip_variants (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS published_posts_variant_idx ON published_posts (variant_id) WHERE variant_id IS NOT NULL;
