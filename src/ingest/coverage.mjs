// The one rule for history versus stale (sourceStates below), used by every place that counts
// staleness: the Files page sources, the account list and dialog, the Cash card, the brief, the
// freshness job and the planner's missing-data check. A file source is covered when it has
// accounts and every account that has rows from its files is mapped to a SimpleFIN connection.
// A covered file source is no longer the way that data arrives, so an old file date is history,
// not stale. An account's own freshness still comes from its newest row.

import { freshnessOf } from './freshness.mjs';

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

const DAY = /^(\d{4})-(\d{2})-(\d{2})/;
const isoDay = (value) => (typeof value === 'string' && DAY.test(value) ? value.slice(0, 10) : null);

// Every row an account has, by the ingest source of the live file that carried it ('' for a row
// with no file or a file with no source).
const ROWS = `SELECT r.account_id AS account, coalesce(f.source_id, '') AS source, max(r.d) AS d FROM (
    SELECT account_id, file_id, date AS d FROM transactions
    UNION ALL SELECT account_id, file_id, date FROM balances
    UNION ALL SELECT account_id, file_id, as_of FROM positions
  ) r LEFT JOIN files f ON f.id = r.file_id
  WHERE r.account_id IS NOT NULL AND (f.id IS NULL OR f.removed_at IS NULL)
  GROUP BY r.account_id, coalesce(f.source_id, '')`;

// The shared rule, at `clock` (an ISO day). Returns {sources, accounts}, Maps keyed by id:
//   accounts (every account with an ingest source): {state, asOf, ageDays, kind, sourceId,
//     archived}. state is 'archived' for an archived account (never stale, never counted);
//     otherwise its newest row's freshness for its source's cadence:
//     'fresh' | 'stale' | 'unknown'.
//   sources (every ingest source): {state, asOf, ageDays, cadence, kind, fed}. A file source is
//     'history' when every account its live files fed is connected, archived, or has a newer row
//     from another source; otherwise, and for a source that fed no account, its freshness by date:
//     'fresh' | 'stale' | 'unknown'. fed maps each account it fed to its newest row date from it.
export function sourceStates(db, clock) {
  const connected = connectedAccountIds(db);
  const rows = db.prepare("SELECT id, kind, as_of FROM sources WHERE substr(id, 1, 4) = 'ing:' ORDER BY id").all();
  const kindOf = new Map(rows.map((r) => [r.id, r.kind]));
  const archived = new Set(db.prepare('SELECT id FROM accounts WHERE archived_at IS NOT NULL').all().map((r) => r.id));

  // account -> source -> newest row date
  const bySource = new Map();
  for (const r of db.prepare(ROWS).all()) {
    if (!bySource.has(r.account)) bySource.set(r.account, new Map());
    bySource.get(r.account).set(r.source, isoDay(r.d) ?? '');
  }
  const newest = (id) => [...(bySource.get(id)?.values() ?? [])].sort().at(-1) ?? '';

  const accounts = new Map();
  for (const a of db.prepare('SELECT id, source_id FROM accounts WHERE source_id IS NOT NULL ORDER BY id').all()) {
    const asOf = newest(a.id);
    const kind = kindOf.get(a.source_id);
    const f = asOf && kind ? freshnessOf({ kind, asOf }, clock) : null;
    let state = f ? f.state : 'unknown';
    if (archived.has(a.id)) state = 'archived';
    accounts.set(a.id, { state, asOf, ageDays: f ? f.ageDays : null, kind: kind ?? null, sourceId: a.source_id, archived: archived.has(a.id) });
  }

  const sources = new Map();
  for (const s of rows) {
    const fed = new Map();
    for (const [account, per] of bySource) if (per.has(s.id)) fed.set(account, per.get(s.id));
    const f = freshnessOf({ kind: s.kind, asOf: s.as_of }, clock);
    const newerElsewhere = (account, d) => [...bySource.get(account)].some(([source, other]) => source !== s.id && other > d);
    const history = s.kind !== 'simplefin' && fed.size > 0
      && [...fed].every(([account, d]) => connected.has(account) || archived.has(account) || newerElsewhere(account, d));
    sources.set(s.id, { state: history ? 'history' : f.state, asOf: s.as_of ?? '', ageDays: f.ageDays, cadence: f.cadence, kind: s.kind, fed });
  }
  return { sources, accounts };
}
