-- REBUILDS_TABLE
-- Add-a-device links are a third auth token purpose, 'add-passkey'. The auth_tokens CHECK lists the
-- purposes, so the table is rebuilt with the wider list and otherwise unchanged: hash primary key,
-- user_id cascading from users, UNIQUE (user_id, purpose) for one pending link per purpose, and the
-- expiry index. auth_challenges.token_hash references auth_tokens(hash) by name and keeps doing so
-- after the rename; foreign_key_check must pass before the migration commits (see REBUILDS_TABLE in
-- db.mjs).

CREATE TABLE auth_tokens_new (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('invite', 'recovery', 'add-passkey')),
  expires_at INTEGER NOT NULL,
  UNIQUE (user_id, purpose)
);
INSERT INTO auth_tokens_new (hash, user_id, purpose, expires_at)
  SELECT hash, user_id, purpose, expires_at FROM auth_tokens;
DROP TABLE auth_tokens;
ALTER TABLE auth_tokens_new RENAME TO auth_tokens;
CREATE INDEX auth_tokens_expiry ON auth_tokens(expires_at);
