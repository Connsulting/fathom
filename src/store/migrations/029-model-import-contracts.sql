ALTER TABLE column_mappings ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0);
ALTER TABLE column_mappings ADD COLUMN mapping_version INTEGER NOT NULL DEFAULT 1 CHECK (mapping_version > 0);
ALTER TABLE column_mappings ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'unapproved'
  CHECK (approval_status IN ('unapproved', 'approved', 'invalidated'));
ALTER TABLE column_mappings ADD COLUMN approved_by TEXT;
ALTER TABLE column_mappings ADD COLUMN approved_at TEXT;
ALTER TABLE column_mappings ADD COLUMN structural_context TEXT;

CREATE TABLE import_proposals (
  id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  file_id TEXT NOT NULL REFERENCES files(id),
  source_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('waiting_for_engine', 'budget_exhausted', 'needs_confirmation',
    'needs_clarification', 'needs_source_text', 'approved', 'imported', 'rejected', 'superseded')),
  proposal TEXT NOT NULL,
  interpreter_version TEXT NOT NULL,
  mapping_id TEXT,
  mapping_version INTEGER CHECK (mapping_version > 0),
  reason_code TEXT,
  actor_id TEXT,
  approval_evidence TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (id, version)
);
CREATE INDEX import_proposals_file ON import_proposals (file_id, version);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL,
  proposal_version INTEGER NOT NULL,
  file_id TEXT NOT NULL REFERENCES files(id),
  status TEXT NOT NULL CHECK (status IN ('committed', 'undone')),
  before_state TEXT NOT NULL,
  after_state TEXT NOT NULL,
  receipt_id TEXT,
  created_at TEXT NOT NULL,
  undone_at TEXT,
  FOREIGN KEY (proposal_id, proposal_version) REFERENCES import_proposals(id, version),
  UNIQUE (proposal_id, proposal_version)
);
