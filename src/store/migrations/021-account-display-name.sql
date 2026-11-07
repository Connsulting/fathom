-- Owner display name, separate from the imported accounts.name. Null means use the default label.
-- Imports and SimpleFIN refreshes do not write this column.
ALTER TABLE accounts ADD COLUMN display_name TEXT;
