-- 017 confirm context: what Fathom needs to answer a confirm question itself and to show its
-- evidence. New tables only: confirm_undo logs hold whole-row images, so a new column on accounts
-- or confirm_items would make every stored log fail its revert.
-- account_holders keeps the holder or owner name a source itself carries for an account (first
-- source wins). confirm_auto records the answers Fathom made, with the rule and its evidence (JSON
-- {text, basis: [item ids], ancestors: [item ids], refs}); it is written inside the captured answer,
-- so reverting the answer removes it. confirm_auto_declined marks an item whose auto answer the
-- owner undid: it is never answered automatically again. simplefin_snapshots holds what the last
-- sync saw of each bridge account (no account or connection ids), for the account_match card.

CREATE TABLE account_holders (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  holder TEXT NOT NULL,                               -- as written in the source
  file_id TEXT REFERENCES files(id),
  locator TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE confirm_auto (
  item_id INTEGER PRIMARY KEY REFERENCES confirm_items(id) ON DELETE CASCADE,
  rule TEXT NOT NULL,                                 -- cross_format_duplicate | holder_match | shared_mask
  evidence TEXT NOT NULL,                             -- JSON {text, basis, ancestors, refs}
  created_at TEXT NOT NULL
);

CREATE TABLE confirm_auto_declined (
  item_id INTEGER PRIMARY KEY REFERENCES confirm_items(id) ON DELETE CASCADE,
  at TEXT NOT NULL
);

CREATE TABLE simplefin_snapshots (
  sf_key TEXT PRIMARY KEY REFERENCES simplefin_accounts(sf_key) ON DELETE CASCADE,
  snapshot TEXT NOT NULL,                             -- JSON {inst, name, mask, maskSure, balance, balanceDate, from, to, count, recent}
  at TEXT NOT NULL
);
