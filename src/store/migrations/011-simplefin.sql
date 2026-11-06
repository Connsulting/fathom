-- Item 22: read-only bank and brokerage connections through SimpleFIN Bridge.
-- simplefin_connection holds at most one connection. access_blob is the access URL encrypted with
-- the data key (AES-256-GCM, base64 text); the plaintext URL is never stored. status is 'ok',
-- 'reconnect' (revoked access, payment required or an auth error from the bridge) or 'error'.
-- messages is a JSON list of sanitized bridge error messages from the last sync.
CREATE TABLE simplefin_connection (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  access_blob TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  last_sync_at TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  error_code TEXT,
  messages TEXT,
  accounts INTEGER NOT NULL DEFAULT 0
);

-- One row per SimpleFIN account seen: sf_key is a hash of the connection and account ids.
-- status 'mapped' writes rows into account_id; 'pending_match' waits on an account_match confirm
-- question about candidate_id and imports nothing until it is answered.
CREATE TABLE simplefin_accounts (
  sf_key TEXT PRIMARY KEY,
  account_id TEXT,
  candidate_id TEXT,
  status TEXT NOT NULL,
  name TEXT,
  created_at TEXT NOT NULL
);
