-- Item 24: the advisor review workflow. The owner runs it; there are no advisor accounts.
-- advisor_reviews: one row per time a recommendation went to the advisor. verdict is NULL while
-- it waits; confirmed or vetoed once the owner records the advisor's answer (note is escaped owner
-- text, reviewed_on the advisor's date). grounding_hash is the planner's grounding hash for the rec
-- when the verdict was recorded (NULL for recs the planner does not own). closed_at is set when a
-- later send replaced the row or the planner lifted a veto because the rec's inputs changed; closed
-- rows stay as history. rec_id is NULL only for a review of an item outside the plan (demo seed).
-- advisor_checkin holds the owner-set next check-in (one row, id 1). advisor_packets lists each
-- generated review packet; the HTML lives encrypted in the data volume at stored_path.

CREATE TABLE advisor_reviews (
  id INTEGER PRIMARY KEY,
  rec_id TEXT REFERENCES recs(id),
  title TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('confirmed', 'vetoed')),
  note TEXT NOT NULL DEFAULT '',
  reviewed_on TEXT,
  recorded_at TEXT,
  grounding_hash TEXT,
  closed_at TEXT,
  closed_reason TEXT
);
CREATE UNIQUE INDEX advisor_reviews_open ON advisor_reviews (rec_id) WHERE closed_at IS NULL AND rec_id IS NOT NULL;

CREATE TABLE advisor_checkin (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  date TEXT NOT NULL,
  time TEXT,
  length_min INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE advisor_packets (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  clock TEXT NOT NULL,
  rec_ids TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL
);
