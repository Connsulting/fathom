CREATE TABLE import_model_spend (
  file_id TEXT NOT NULL REFERENCES files(id),
  call INTEGER NOT NULL CHECK (call BETWEEN 1 AND 4),
  source_sha256 TEXT NOT NULL,
  correlation_id TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  cost_usd REAL NOT NULL CHECK (cost_usd >= 0),
  estimated INTEGER NOT NULL CHECK (estimated IN (0, 1)),
  retry INTEGER NOT NULL CHECK (retry IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed')),
  reason_code TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (file_id, call)
);
