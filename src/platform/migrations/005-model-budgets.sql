-- Household and instance model budgets (MT-05). Additive only.
-- household_model_budgets: the operator's monthly allocation per household in dollars (cents); a
-- missing row is a zero allocation, so a household created after this migration starts unfunded.
-- model_rounds: the shared reservation ledger every paid live round passes before dispatch. One
-- row per round (kind 'round') plus at most one settled 'carry' row per household and month that
-- carries the household's pre-MT-05 spend for that month. month is the actual UTC month. Committed
-- spend: a settled row's cost_usd; a reserved or held row's max(reserved_usd, cost_usd). No
-- prompts, results, tool output or credential bytes. Times are epoch milliseconds.

CREATE TABLE household_model_budgets (
  household_id TEXT PRIMARY KEY REFERENCES households(id),
  allocation_usd REAL NOT NULL CHECK (allocation_usd >= 0 AND allocation_usd <= 10000),
  updated_at INTEGER NOT NULL
);

CREATE TABLE model_rounds (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  month TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  kind TEXT NOT NULL CHECK (kind IN ('round', 'carry')),
  purpose TEXT,
  model TEXT,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'settled', 'held')),
  hold_code TEXT CHECK (hold_code IS NULL OR hold_code IN ('cost_unknown', 'interrupted', 'reservation_bound_exceeded')),
  reserved_usd REAL NOT NULL CHECK (reserved_usd >= 0),
  cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  input_tokens INTEGER,
  output_tokens INTEGER,
  receipt_ref TEXT,
  reserved_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX model_rounds_household_month ON model_rounds(household_id, month);
CREATE INDEX model_rounds_month ON model_rounds(month);
CREATE UNIQUE INDEX model_rounds_carry ON model_rounds(household_id, month) WHERE kind = 'carry';

-- Existing households keep the funding they had: the hand-set instance cap (a JSON number from 0
-- to 10000, rounded to cents) becomes each non-deleted household's allocation, else zero.
INSERT INTO household_model_budgets (household_id, allocation_usd, updated_at)
SELECT h.id,
  coalesce((SELECT round(CAST(s.value AS REAL), 2) FROM platform_settings s
    WHERE s.key = 'instance_model_cap_usd' AND json_valid(s.value) AND json_type(s.value) IN ('integer', 'real')
      AND CAST(s.value AS REAL) BETWEEN 0 AND 10000), 0),
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM households h WHERE h.status != 'deleted';
