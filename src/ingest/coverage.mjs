// The one rule for "SimpleFIN covers this": a file source is covered when it has accounts and every
// account that has rows from its files is mapped to a SimpleFIN connection. A covered file source
// is no longer the way that data arrives, so an old file date is not a stale source anywhere (the
// Cash card, the brief, the freshness job, the Files page). An account's own freshness still comes
// from its newest row.

// Account ids mapped to a SimpleFIN account while a connection exists (a disconnected bridge
// covers nothing, though its mappings stay).
export function connectedAccountIds(db) {
  if (!db.prepare('SELECT 1 FROM simplefin_connection WHERE id = 1').get()) return new Set();
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

// The newest row date (on or before `clock`) of the connected accounts when SimpleFIN covers every
// account that has transactions, else null. A synced account with no recent activity is current,
// so the household transaction log is not stale because its newest transaction is old.
export function connectedThrough(db, clock) {
  const connected = connectedAccountIds(db);
  if (!connected.size) return null;
  const withRows = db.prepare('SELECT DISTINCT account_id FROM transactions').all().map(r => r.account_id);
  if (!withRows.length || !withRows.every(id => connected.has(id))) return null;
  const marks = [...connected].map(() => '?').join(',');
  const row = db.prepare(`SELECT max(d) AS d FROM (
      SELECT max(date) AS d FROM transactions WHERE date <= ? AND account_id IN (${marks})
      UNION ALL SELECT max(date) FROM balances WHERE date <= ? AND account_id IN (${marks})
      UNION ALL SELECT max(as_of) FROM positions WHERE as_of <= ? AND account_id IN (${marks}))`).get(clock, ...connected, clock, ...connected, clock, ...connected);
  return row?.d ?? null;
}
