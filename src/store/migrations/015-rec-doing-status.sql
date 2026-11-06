-- The 'accepted' and 'doing' rec statuses merge into 'doing' (the owner's "Doing it"): committed
-- work moves to In motion with its steps tracked. The recs CHECK lists the statuses, so the table is
-- rebuilt without 'accepted'. Rows referencing recs (rec_events, planner_recs, advisor_reviews) keep
-- their ids; foreign_key_check must pass before the migration commits (see REBUILDS_TABLE in db.mjs).
-- Rec history is rewritten in the new vocabulary: the accept action reads as start, and accepted as doing.
-- REBUILDS_TABLE

CREATE TABLE recs_new (
  id TEXT PRIMARY KEY,
  def TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'doing', 'waiting', 'snoozed', 'done', 'dismissed', 'hidden')),
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

INSERT INTO recs_new (id, def, status, waiting_on, wake, tasks_done, window_close, window_label, pack_id, sort, updated_at, file_id, parser, locator)
SELECT id, def, CASE status WHEN 'accepted' THEN 'doing' ELSE status END, waiting_on, wake, tasks_done,
       window_close, window_label, pack_id, sort, updated_at, file_id, parser, locator
FROM recs;

DROP TABLE recs;
ALTER TABLE recs_new RENAME TO recs;

UPDATE rec_events SET action = 'start' WHERE action = 'accept';
UPDATE rec_events SET from_status = 'doing' WHERE from_status = 'accepted';
UPDATE rec_events SET to_status = 'doing' WHERE to_status = 'accepted';
