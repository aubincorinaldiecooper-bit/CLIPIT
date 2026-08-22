-- Real accounts arrive.
--
-- The `user_id` columns have waited empty since the first migration, typed
-- UUID on the assumption that users would live in this database. They will
-- not: identity is handled by Better Auth in the frontend service, whose ids
-- are opaque text. TEXT is the honest type for "an identifier some other
-- system owns".
--
-- Nothing references these columns and nothing has ever written to them, so
-- the change is safe on every existing row (they are all NULL).
ALTER TABLE sessions      ALTER COLUMN user_id TYPE TEXT USING user_id::text;
ALTER TABLE videos        ALTER COLUMN user_id TYPE TEXT USING user_id::text;
ALTER TABLE clip_requests ALTER COLUMN user_id TYPE TEXT USING user_id::text;
ALTER TABLE clips         ALTER COLUMN user_id TYPE TEXT USING user_id::text;

-- A signed-in person's library: "my videos" is now a real query, and the
-- retention sweep needs to skip owned footage cheaply.
CREATE INDEX IF NOT EXISTS videos_user_idx ON videos (user_id, created_at DESC)
    WHERE user_id IS NOT NULL;
