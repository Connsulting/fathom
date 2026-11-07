CREATE TABLE action_receipts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  conversation_key TEXT,
  turn_id TEXT,
  label TEXT NOT NULL,
  before_state TEXT NOT NULL,
  after_state TEXT NOT NULL,
  before_value TEXT NOT NULL,
  after_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  undone_at TEXT,
  planning_pending INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX action_receipts_conversation ON action_receipts(conversation_key, created_at);

CREATE TABLE preferences (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
