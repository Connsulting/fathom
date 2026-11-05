-- 008 confirm deck: per-answer change logs so a confirm answer can be revised or reopened, the
-- engine's best guess per pending question, and an ingest epoch that every file import bumps.
-- confirm_undo.changes is the JSON log of every row the answer changed ([{table, op, rowid,
-- before, after}], row images as JSON text); ingest_epoch is the epoch when it was recorded and
-- used_at is set once a later import or planning run re-applied the answer (both make it final).
-- confirm_guesses holds one row per question sent to the engine; option_id is NULL when the
-- engine gave no valid guess, so the question is never sent again. Guesses never answer.
-- ingest_epoch has at most one row (id 1). The demo seed deletes it, so readers coalesce to 0.

CREATE TABLE confirm_undo (
  item_id INTEGER PRIMARY KEY REFERENCES confirm_items(id) ON DELETE CASCADE,
  ingest_epoch INTEGER NOT NULL,
  changes TEXT NOT NULL,                              -- JSON [{table, op, rowid, before, after}]
  created_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE confirm_guesses (
  item_id INTEGER PRIMARY KEY REFERENCES confirm_items(id) ON DELETE CASCADE,
  option_id TEXT,
  reason TEXT,
  model TEXT NOT NULL,
  ts TEXT NOT NULL
);

CREATE TABLE ingest_epoch (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  n INTEGER NOT NULL
);

CREATE TRIGGER files_insert_ingest_epoch AFTER INSERT ON files BEGIN
  INSERT INTO ingest_epoch (id, n) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1;
END;

CREATE TRIGGER files_update_ingest_epoch AFTER UPDATE ON files BEGIN
  INSERT INTO ingest_epoch (id, n) VALUES (1, 1) ON CONFLICT(id) DO UPDATE SET n = n + 1;
END;
