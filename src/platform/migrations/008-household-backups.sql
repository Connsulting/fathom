INSERT INTO platform_settings (key, value, updated_at)
VALUES ('backup_instance_id', json_quote(lower(hex(randomblob(16)))), CAST(strftime('%s', 'now') AS INTEGER) * 1000);

CREATE TABLE household_backup_operations (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  kind TEXT NOT NULL CHECK (kind IN ('backup', 'restore')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  phase TEXT NOT NULL,
  code TEXT,
  bundle_file TEXT NOT NULL,
  bundle_hash TEXT,
  source_root TEXT NOT NULL,
  source_generation INTEGER NOT NULL,
  target_root TEXT,
  file_count INTEGER NOT NULL DEFAULT 0,
  byte_count INTEGER NOT NULL DEFAULT 0,
  membership_drift INTEGER NOT NULL DEFAULT 0,
  rollback_expires_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX household_backup_operations_busy ON household_backup_operations(household_id)
WHERE status IN ('queued', 'running');
