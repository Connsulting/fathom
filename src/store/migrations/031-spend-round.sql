-- Live spend mirrors (MT-05): a spend_ledger row mirrored from the platform reservation ledger
-- carries that round's id, at most once. Rows recorded before MT-05, and fake-mode rows, keep NULL.
ALTER TABLE spend_ledger ADD COLUMN round_id TEXT;
CREATE UNIQUE INDEX spend_ledger_round ON spend_ledger(round_id) WHERE round_id IS NOT NULL;
