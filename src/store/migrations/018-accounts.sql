CREATE TABLE households (
  id INTEGER PRIMARY KEY CHECK (id = 1)
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  household_id INTEGER NOT NULL REFERENCES households(id),
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND email = trim(email)),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  user_handle TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  enrolled_at INTEGER
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL,
  counter INTEGER NOT NULL,
  transports TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE auth_tokens (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('invite', 'recovery')),
  expires_at INTEGER NOT NULL,
  UNIQUE (user_id, purpose)
);

CREATE TABLE auth_sessions (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signed_in_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE auth_challenges (
  hash TEXT PRIMARY KEY,
  ceremony TEXT NOT NULL CHECK (ceremony IN ('register', 'signin')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT REFERENCES auth_tokens(hash) ON DELETE CASCADE,
  session_hash TEXT REFERENCES auth_sessions(hash) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE auth_rate_limits (
  key_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
CREATE INDEX auth_tokens_expiry ON auth_tokens(expires_at);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at);
CREATE INDEX auth_rate_limits_expiry ON auth_rate_limits(expires_at);

ALTER TABLE api_keys ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX api_keys_user ON api_keys(user_id);
