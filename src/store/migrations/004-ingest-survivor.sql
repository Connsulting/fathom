-- 004 ingest survivor: the dedupe key of the active row a duplicate_confirmed tombstone was
-- confirmed against, so a later key collision on the tombstoned key is asked about against it.
-- Nullable: other reasons and tombstones archived before this migration carry no survivor.
ALTER TABLE superseded_rows ADD COLUMN survivor_key TEXT;
