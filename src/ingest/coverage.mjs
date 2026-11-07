// The one rule for "SimpleFIN covers this": a file source is covered when it has accounts and every
// account that has rows from its files is mapped to a SimpleFIN connection. A covered file source
// is no longer the way that data arrives, so an old file date is not a stale source anywhere (the
// Cash card, the brief, the freshness job, the Files page). An account's own freshness still comes
// from its newest row.

// Account ids mapped to a SimpleFIN account.
export function connectedAccountIds(db) {
  return new Set(db.prepare("SELECT account_id FROM simplefin_accounts WHERE status = 'mapped' AND account_id IS NOT NULL").all().map(r => r.account_id));
}

// Ids of the file sources (sources that files were read for) whose accounts are all connected.
export function coveredFileSources(db) {
  const connected = connectedAccountIds(db);
  if (!connected.size) return new Set();
  const rows = db.prepare(`SELECT DISTINCT f.source_id AS source, r.account_id AS account
    FROM files f JOIN (
      SELECT file_id, account_id FROM transactions UNION SELECT file_id, account_id FROM balances UNION SELECT file_id, account_id FROM positions
    ) r ON r.file_id = f.id
    WHERE f.source_id IS NOT NULL AND r.account_id IS NOT NULL`).all();
  const accounts = new Map();
  for (const { source, account } of rows) {
    if (!accounts.has(source)) accounts.set(source, new Set());
    accounts.get(source).add(account);
  }
  return new Set([...accounts].filter(([, ids]) => [...ids].every(id => connected.has(id))).map(([source]) => source));
}
