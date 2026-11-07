CREATE TABLE transaction_category_corrections (
  transaction_id INTEGER PRIMARY KEY REFERENCES transactions(id) DEFERRABLE INITIALLY DEFERRED,
  category TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('household','business','income','transfer','tax','saving','excluded')),
  updated_at TEXT NOT NULL
);
CREATE TABLE category_merchant_rules (
  merchant TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('household','business','income','transfer','tax','saving','excluded')),
  updated_at TEXT NOT NULL
);
CREATE TABLE category_source_rules (
  parser TEXT NOT NULL,
  category TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK (bucket IN ('household','business','income','transfer','tax','saving','excluded')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (parser, category)
);
CREATE TABLE transaction_category_guesses (
  transaction_id INTEGER PRIMARY KEY REFERENCES transactions(id) DEFERRABLE INITIALLY DEFERRED,
  category TEXT,
  model TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE transaction_category_imports (
  transaction_id INTEGER PRIMARY KEY REFERENCES transactions(id) DEFERRABLE INITIALLY DEFERRED,
  dedupe_key TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL,
  parser TEXT NOT NULL,
  file_id TEXT REFERENCES files(id),
  locator TEXT,
  date TEXT NOT NULL,
  description TEXT,
  updated_at TEXT NOT NULL
);
