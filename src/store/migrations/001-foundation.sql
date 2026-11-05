-- 001 foundation: settings, narrative content, provenance (files, sources), the household ledger,
-- the plan (recs, decisions, goals, deadlines, events, packs), conversations, the engine (jobs,
-- spend) and API keys. schema_migrations is created by migrate() itself.
-- Money columns hold dollars rounded to cents. JSON columns hold JSON text.
-- Provenance on data-derived tables: file_id (the source file), parser, locator (row or cell).

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE content (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  src TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE files (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  sha256 TEXT,
  source_kind TEXT,
  uploaded_at TEXT NOT NULL,
  stored_path TEXT,
  status TEXT,
  note TEXT
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  as_of TEXT,
  kind TEXT,
  last_ingest_at TEXT,
  note TEXT
);

CREATE TABLE facts (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  src TEXT,
  as_of TEXT,
  confirmed INTEGER NOT NULL DEFAULT 0,
  file_id TEXT REFERENCES files(id),
  parser TEXT,
  locator TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  inst TEXT,
  mask TEXT CHECK (mask IS NULL OR (typeof(mask) = 'text' AND length(CAST(mask AS BLOB)) = 4 AND mask GLOB '[0-9][0-9][0-9][0-9]')),
  name TEXT,
  owner TEXT,
  kind TEXT,
  mirror TEXT,
  note TEXT,
  fig_key TEXT,
  file_id TEXT REFERENCES files(id),
  parser TEXT,
  locator TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  description TEXT,
  category TEXT,
  external_id TEXT,
  dedupe_key TEXT UNIQUE,
  file_id TEXT REFERENCES files(id),
  parser TEXT,
  locator TEXT
);
CREATE INDEX transactions_account_date ON transactions (account_id, date);

CREATE TABLE balances (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  file_id TEXT REFERENCES files(id),
  parser TEXT,
  locator TEXT,
  UNIQUE (account_id, date)
);

CREATE TABLE positions (
  id INTEGER PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  as_of TEXT NOT NULL,
  symbol TEXT,
  name TEXT,
  quantity REAL,
  price REAL,
  value REAL,
  cost_basis REAL,
  file_id TEXT REFERENCES files(id),
  parser TEXT,
  locator TEXT
);

CREATE TABLE pnl_lines (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  period TEXT NOT NULL CHECK (period GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  category TEXT NOT NULL,
  amount REAL NOT NULL,
  file_id TEXT REFERENCES files(id),
  parser TEXT,
  locator TEXT
);

CREATE TABLE tax_payments (
  id INTEGER PRIMARY KEY,
  jurisdiction TEXT NOT NULL,
  tax_year INTEGER,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  kind TEXT,
  file_id TEXT REFERENCES files(id),
  parser TEXT,
  locator TEXT
);

CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  doc_type TEXT NOT NULL,
  tax_year INTEGER,
  fields TEXT NOT NULL DEFAULT '{}',
  file_id TEXT REFERENCES files(id),
  parser TEXT,
  locator TEXT
);

CREATE TABLE figures (
  key TEXT PRIMARY KEY,
  v REAL NOT NULL,
  src TEXT REFERENCES sources(id),
  kind TEXT NOT NULL CHECK (kind IN ('a', 'p', 'e', 'm')),
  label TEXT NOT NULL DEFAULT '',
  file_id TEXT REFERENCES files(id),
  parser TEXT,
  locator TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE recs (
  id TEXT PRIMARY KEY,
  def TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'doing', 'waiting', 'snoozed', 'done', 'dismissed', 'hidden')),
  waiting_on TEXT,
  wake TEXT,
  tasks_done TEXT NOT NULL DEFAULT '[]',
  window_close TEXT,
  window_label TEXT,
  pack_id TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  file_id TEXT REFERENCES files(id),
  parser TEXT,
  locator TEXT
);

CREATE TABLE rec_events (
  id INTEGER PRIMARY KEY,
  rec_id TEXT NOT NULL REFERENCES recs(id),
  ts TEXT NOT NULL,
  action TEXT NOT NULL,
  arg TEXT,
  from_status TEXT,
  to_status TEXT,
  actor TEXT NOT NULL
);
CREATE INDEX rec_events_rec ON rec_events (rec_id, id);

CREATE TABLE conversations (
  key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  conversation_key TEXT NOT NULL REFERENCES conversations(key),
  role TEXT NOT NULL CHECK (role IN ('me', 'fathom', 'advisor', 'claude')),
  text TEXT NOT NULL,
  refs TEXT NOT NULL DEFAULT '[]',
  notice INTEGER NOT NULL DEFAULT 0,
  ts TEXT NOT NULL
);
CREATE INDEX messages_conversation ON messages (conversation_key, id);

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  def TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE deadlines (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  label TEXT,
  title TEXT NOT NULL,
  rec_id TEXT,
  hard INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  date TEXT,
  kind TEXT,
  title TEXT NOT NULL,
  body TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE packs_state (
  id TEXT PRIMARY KEY,
  def TEXT NOT NULL,
  active INTEGER,
  exploring INTEGER NOT NULL DEFAULT 0,
  what_if_asked INTEGER NOT NULL DEFAULT 0,
  what_if_done INTEGER NOT NULL DEFAULT 0,
  unhid TEXT NOT NULL DEFAULT '[]',
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'decided', 'upcoming')),
  wargame TEXT,
  rec_id TEXT,
  opens_on TEXT,
  when_label TEXT,
  note TEXT,
  decided_line TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cadence TEXT,
  does TEXT,
  cost REAL,
  next_label TEXT,
  last_label TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT,
  cost_usd REAL,
  note TEXT
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE spend_ledger (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  yyyymm TEXT NOT NULL CHECK (yyyymm GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  purpose TEXT NOT NULL,
  cost_usd REAL NOT NULL,
  model TEXT,
  tokens TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX spend_ledger_month ON spend_ledger (yyyymm);
