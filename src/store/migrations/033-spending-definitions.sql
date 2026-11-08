CREATE TABLE spending_definitions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  def TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
ALTER TABLE preferences ADD COLUMN definition_id TEXT REFERENCES spending_definitions(id);
CREATE UNIQUE INDEX preferences_definition ON preferences(definition_id);
