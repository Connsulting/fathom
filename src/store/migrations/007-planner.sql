-- 007 planner: bookkeeping for planner-owned recommendations, and a src column on the brief
-- tables the planner rewrites, so it replaces only its own rows.
-- retired_from: the rec status when the planner retired it. held_from: the status a blocked rec
-- held before the planner parked it as waiting on data.

CREATE TABLE planner_recs (
  rec_id TEXT PRIMARY KEY REFERENCES recs(id),
  trigger_id TEXT NOT NULL,
  grounding_hash TEXT NOT NULL,
  prose_src TEXT NOT NULL CHECK (prose_src IN ('model', 'template')),
  first_run INTEGER REFERENCES job_runs(id),
  last_run INTEGER REFERENCES job_runs(id),
  retired_at TEXT,
  retired_reason TEXT,
  retired_from TEXT,
  held_from TEXT
);

ALTER TABLE events ADD COLUMN src TEXT;
ALTER TABLE deadlines ADD COLUMN src TEXT;
ALTER TABLE decisions ADD COLUMN src TEXT;

-- Why a decision or figure is no longer usable for current decisions; null when current. Rows stay
-- as history.
ALTER TABLE decisions ADD COLUMN unavailable_reason TEXT;
ALTER TABLE figures ADD COLUMN unavailable_reason TEXT;
