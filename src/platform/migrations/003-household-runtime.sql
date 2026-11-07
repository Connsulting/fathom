-- Household runtimes (MT-03). Each served household has its own root under the data directory
-- (storage_root 'households/<id>', NULL until its storage exists) and a generation that bumps when
-- the household's runtime must be rebuilt. household_outbound holds the per-household outbound
-- pause flags (1 = enabled); a missing row means every kind is paused. api_keys moves here from
-- the financial store with an immutable household binding; key_hash is the same HMAC as before so
-- existing keys keep verifying. Times in household_outbound are epoch milliseconds; api_keys keeps
-- the ISO text times it had in the store.

ALTER TABLE households ADD COLUMN storage_root TEXT;
ALTER TABLE households ADD COLUMN generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1);

CREATE TABLE household_outbound (
  household_id TEXT PRIMARY KEY REFERENCES households(id),
  jobs INTEGER NOT NULL CHECK (jobs IN (0, 1)),
  email INTEGER NOT NULL CHECK (email IN (0, 1)),
  simplefin INTEGER NOT NULL CHECK (simplefin IN (0, 1)),
  engine INTEGER NOT NULL CHECK (engine IN (0, 1)),
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT,
  revoked_code TEXT
);
CREATE INDEX api_keys_household ON api_keys(household_id, user_id);
