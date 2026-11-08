-- Sources management (SRC1). An archived account leaves current balances, totals and Ask going
-- forward while its history stays; a removed file's rows are deleted and its removal is kept as a
-- captured change log (src/ingest/undo.mjs) keyed by the action receipt, so Undo restores it.
ALTER TABLE accounts ADD COLUMN archived_at TEXT;
ALTER TABLE files ADD COLUMN removed_at TEXT;
CREATE TABLE source_changes (
  receipt_id TEXT PRIMARY KEY,
  changes TEXT NOT NULL
);
