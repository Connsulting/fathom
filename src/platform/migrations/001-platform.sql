-- Platform database (platform.sqlite): households, global accounts, memberships, operator grants,
-- credentials, sessions, invitations and platform policy. Times are epoch milliseconds.
-- The financial store (fathom.sqlite) keeps no account table; its store_identity row names the
-- household it serves.

CREATE TABLE households (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'active', 'suspended', 'deleted')),
  mode TEXT NOT NULL CHECK (mode IN ('real', 'demo')),
  display_name TEXT,
  serves_store INTEGER NOT NULL DEFAULT 0 CHECK (serves_store IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- At most one household is served by the singleton fathom.sqlite.
CREATE UNIQUE INDEX households_served ON households(serves_store) WHERE serves_store = 1;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email) AND email = trim(email)),
  user_handle TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  enrolled_at INTEGER
);

CREATE TABLE household_memberships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  household_id TEXT NOT NULL REFERENCES households(id),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (user_id, household_id)
);
CREATE INDEX household_memberships_household ON household_memberships(household_id, status);

CREATE TABLE instance_operators (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  granted_at INTEGER NOT NULL,
  granted_by TEXT REFERENCES users(id) ON DELETE SET NULL
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

-- Recovery and add-a-device links. Invitations are household_invitations.
CREATE TABLE auth_tokens (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('recovery', 'add-passkey')),
  expires_at INTEGER NOT NULL,
  UNIQUE (user_id, purpose)
);
CREATE INDEX auth_tokens_expiry ON auth_tokens(expires_at);

-- An invitation to one household. user_id is the invitee's account row (created pending when the
-- email is new; its user_handle is the WebAuthn user id). At most one live (unconsumed, unrevoked)
-- invitation per household and email, whatever its expiry.
CREATE TABLE household_invitations (
  hash TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  email TEXT NOT NULL CHECK (email = lower(email) AND email = trim(email)),
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inviter_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX household_invitations_live ON household_invitations(household_id, email)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;
CREATE INDEX household_invitations_user ON household_invitations(user_id);
CREATE INDEX household_invitations_expiry ON household_invitations(expires_at);

CREATE TABLE auth_sessions (
  hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  signed_in_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  household_id TEXT REFERENCES households(id) ON DELETE SET NULL,
  context_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE auth_challenges (
  hash TEXT PRIMARY KEY,
  ceremony TEXT NOT NULL CHECK (ceremony IN ('register', 'signin')),
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT REFERENCES auth_tokens(hash) ON DELETE CASCADE,
  session_hash TEXT REFERENCES auth_sessions(hash) ON DELETE CASCADE,
  invitation_hash TEXT REFERENCES household_invitations(hash) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at);

CREATE TABLE auth_rate_limits (
  key_hash TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL
);
CREATE INDEX auth_rate_limits_expiry ON auth_rate_limits(expires_at);

-- Platform policy, JSON values. multi_household_enabled (boolean) defaults to false when absent.
CREATE TABLE platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Who did what to whom, with a fixed action and outcome code. No payloads, emails or tokens.
CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  actor_user_id TEXT,
  household_id TEXT,
  target_user_id TEXT,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL
);
CREATE INDEX audit_events_at ON audit_events(at);

-- Offline operations that wrote this database (the platform migration). detail is JSON of counts
-- and hashes only.
CREATE TABLE platform_operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  phase TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'done')),
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
