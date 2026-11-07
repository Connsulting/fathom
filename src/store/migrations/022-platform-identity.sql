-- REBUILDS_TABLE
-- Platform identity (MT-01). Accounts, credentials and sessions live in platform.sqlite; this store
-- keeps store_identity, naming the platform household it serves. The offline platform migration
-- (scripts/migrate-platform.mjs) copies the account rows out, verifies and publishes
-- platform.sqlite, writes the store_identity row with the same DDL as below, and only then applies
-- this migration. The guard aborts it (and the rollback keeps every row) unless store_identity has
-- a row or the store never held an account, credential, link or session.
CREATE TABLE IF NOT EXISTS store_identity (id INTEGER PRIMARY KEY CHECK (id = 1), household_id TEXT NOT NULL, platform_operation TEXT);

CREATE TEMP TABLE platform_identity_guard (extracted INTEGER NOT NULL CHECK (extracted = 1));
INSERT INTO platform_identity_guard (extracted) SELECT CASE
  WHEN EXISTS (SELECT 1 FROM store_identity) THEN 1
  WHEN EXISTS (SELECT 1 FROM users) OR EXISTS (SELECT 1 FROM passkeys)
    OR EXISTS (SELECT 1 FROM auth_tokens) OR EXISTS (SELECT 1 FROM auth_sessions) THEN 0
  ELSE 1 END;
DROP TABLE platform_identity_guard;

-- api_keys loses its users foreign key (creator cascade is explicit in the auth store); every
-- column, row and the api_keys_user index stay.
CREATE TABLE api_keys_new (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  user_id TEXT
);
INSERT INTO api_keys_new (id, name, key_hash, scopes, created_at, last_used_at, revoked_at, user_id)
  SELECT id, name, key_hash, scopes, created_at, last_used_at, revoked_at, user_id FROM api_keys;
DROP TABLE api_keys;
ALTER TABLE api_keys_new RENAME TO api_keys;
CREATE INDEX api_keys_user ON api_keys(user_id);

DROP TABLE auth_challenges;
DROP TABLE auth_sessions;
DROP TABLE auth_tokens;
DROP TABLE passkeys;
DROP TABLE auth_rate_limits;
DROP TABLE users;
DROP TABLE households;
