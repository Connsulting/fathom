-- 011 year end: the owner's "not needed this year" marks on expected tax documents, and a record
-- of every accountant packet generated. item_key is the deterministic key of an expected item
-- (src/yearend/expected.mjs), for example 'w2:<employer>' or '1099-int:<account id>'. counts is
-- JSON {expected, received, missing, skipped, unmatched, files, unreadable, payments, decisions}.

CREATE TABLE yearend_marks (
  tax_year INTEGER NOT NULL,
  item_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  PRIMARY KEY (tax_year, item_key)
);

CREATE TABLE yearend_packets (
  id INTEGER PRIMARY KEY,
  tax_year INTEGER NOT NULL,
  generated_at TEXT NOT NULL,
  counts TEXT NOT NULL DEFAULT '{}',
  bytes INTEGER
);
CREATE INDEX yearend_packets_year ON yearend_packets (tax_year, id);
