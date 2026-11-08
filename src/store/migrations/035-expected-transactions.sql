CREATE TABLE expected_transactions (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('inflow', 'outflow')),
  due_date TEXT NOT NULL,
  date_precision TEXT NOT NULL CHECK (date_precision IN ('day', 'month', 'year')),
  amount REAL CHECK (amount IS NULL OR amount >= 0),
  account_id TEXT REFERENCES accounts(id),
  status TEXT NOT NULL CHECK (status IN ('expected', 'observed', 'cancelled')),
  statement TEXT NOT NULL,
  evidence TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  file_id TEXT REFERENCES files(id),
  observed_transaction_id TEXT REFERENCES transactions(id),
  created_at TEXT NOT NULL
);
