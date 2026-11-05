-- 002 ingest: file routing and coverage metadata, account identity, row dedupe keys and revision
-- slots, the archive of superseded rows, the confirm queue, learned column mappings, entity
-- aliases and facts held until an employer relation is answered.
-- Applies to a fresh store and to an existing one: every new column is nullable or defaulted.

-- files: how a file was routed and what it covers.
ALTER TABLE files ADD COLUMN parser TEXT;
ALTER TABLE files ADD COLUMN counts TEXT;             -- JSON {rows: {kind: n}, duplicates, revised, superseded, warnings, warningCodes: {code: n}, queued}
ALTER TABLE files ADD COLUMN source_id TEXT;
ALTER TABLE files ADD COLUMN header_signature TEXT;
ALTER TABLE files ADD COLUMN period_from TEXT;        -- ISO date or NULL
ALTER TABLE files ADD COLUMN period_to TEXT;          -- ISO date or NULL; orders revisions (NULL is oldest)
ALTER TABLE files ADD COLUMN coverage TEXT;           -- JSON array of source slots a workbook authoritatively covers
CREATE UNIQUE INDEX files_sha256 ON files (sha256) WHERE sha256 IS NOT NULL;

-- accounts: the normalized identity used for upsert.
ALTER TABLE accounts ADD COLUMN source_id TEXT;
ALTER TABLE accounts ADD COLUMN identity TEXT;        -- inst|mask:<mask>, inst|name:<name> or source:<hash>
CREATE UNIQUE INDEX accounts_identity ON accounts (identity) WHERE identity IS NOT NULL;

-- Ledger rows: occurrence ordinals, dedupe keys and revision slots.
ALTER TABLE transactions ADD COLUMN occurrence INTEGER;
ALTER TABLE balances ADD COLUMN dedupe_key TEXT;
ALTER TABLE positions ADD COLUMN dedupe_key TEXT;
ALTER TABLE pnl_lines ADD COLUMN dedupe_key TEXT;
ALTER TABLE pnl_lines ADD COLUMN source_slot TEXT;
ALTER TABLE tax_payments ADD COLUMN dedupe_key TEXT;
ALTER TABLE tax_payments ADD COLUMN source_slot TEXT;
ALTER TABLE tax_payments ADD COLUMN payer TEXT;
ALTER TABLE tax_payments ADD COLUMN date_precision TEXT;
ALTER TABLE tax_payments ADD COLUMN tax_year_basis TEXT;
ALTER TABLE documents ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX balances_dedupe ON balances (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX positions_dedupe ON positions (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX pnl_lines_dedupe ON pnl_lines (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX tax_payments_dedupe ON tax_payments (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX documents_dedupe ON documents (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX pnl_lines_slot ON pnl_lines (source_slot) WHERE source_slot IS NOT NULL;
CREATE INDEX tax_payments_slot ON tax_payments (source_slot) WHERE source_slot IS NOT NULL;

-- Rows replaced by a later import, kept as evidence. `row` is the archived row as JSON.
-- reason: revised, removed, older_snapshot, alias_merged, duplicate_confirmed, summarized.
CREATE TABLE superseded_rows (
  id INTEGER PRIMARY KEY,
  table_name TEXT NOT NULL,
  dedupe_key TEXT,
  row TEXT NOT NULL,
  file_id TEXT REFERENCES files(id),
  superseded_by TEXT REFERENCES files(id),
  reason TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX superseded_rows_key ON superseded_rows (dedupe_key, reason);

-- Questions the owner answers so imports land in the right place.
CREATE TABLE confirm_items (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT NOT NULL,                              -- JSON [{id, label}]
  context TEXT NOT NULL DEFAULT '{}',                 -- JSON
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'answered')),
  answer TEXT,
  file_id TEXT REFERENCES files(id),
  created_at TEXT NOT NULL,
  answered_at TEXT,
  UNIQUE (kind, subject)
);
CREATE INDEX confirm_items_status ON confirm_items (status, id);

-- Column mappings learned for unknown tabular exports, keyed by header signature.
CREATE TABLE column_mappings (
  signature TEXT PRIMARY KEY,
  mapping TEXT NOT NULL,                              -- JSON
  src TEXT NOT NULL,
  created_at TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0
);

-- alias is the normalized alias name; entity is the canonical display name.
CREATE TABLE entity_aliases (
  alias TEXT PRIMARY KEY,
  entity TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Fact assertions held per document until their hold (employer:<employerKey>) is answered.
CREATE TABLE held_facts (
  id INTEGER PRIMARY KEY,
  hold TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,                                -- JSON
  file_id TEXT REFERENCES files(id),
  parser TEXT,
  locator TEXT,
  confidence REAL,
  created_at TEXT NOT NULL
);
CREATE INDEX held_facts_hold ON held_facts (hold, id);
