// The one rule for history versus stale (sourceStates below), used by every place that counts
// staleness: the Files page sources, the account list and dialog, the Cash card, the brief, the
// freshness job and the planner's missing-data check. A file source is covered when it has
// accounts and every account that has rows from its files is mapped to a SimpleFIN connection.
// A covered file source is no longer the way that data arrives, so an old file date is history,
// not stale. An account's own freshness still comes from its newest row.

import { freshnessOf } from './freshness.mjs';
import { parseJson } from '../store/db.mjs';

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
// account that has transactions, else null. A recent balance snapshot can cover an older
// transaction log; sourceStates still checks the newest date of each account separately.
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

// The per-account half of the rule. Returns {archived, bySource, covered}: bySource maps account ->
// source -> newest row date from it, and covered(account, source) says whether that file source is
// history for that one account: it fed the account, and the account is connected, archived, or has
// a newer row from another source. sourceStates calls a source history when it is covered for every
// account it fed; the account dialog marks one account's feed with it.
function historyRule(db) {
  const connected = connectedAccountIds(db);
  const archived = new Set(db.prepare('SELECT id FROM accounts WHERE archived_at IS NOT NULL').all().map((r) => r.id));
  const bySource = new Map();
  for (const r of db.prepare(ROWS).all()) {
    if (!bySource.has(r.account)) bySource.set(r.account, new Map());
    bySource.get(r.account).set(r.source, isoDay(r.d) ?? '');
  }
  const covered = (account, source) => {
    const per = bySource.get(account);
    if (!source || !per || !per.has(source)) return false;
    const d = per.get(source);
    return connected.has(account) || archived.has(account) || [...per].some(([other, od]) => other !== source && od > d);
  };
  return { archived, bySource, covered };
}

// covered(accountId, sourceId) from historyRule, for a caller that asks about one account's feeds.
export function fileSourceHistory(db) {
  return historyRule(db).covered;
}

function payrollThrough(db, source, clock, connected) {
  const employers = db.prepare(`SELECT d.fields FROM documents d JOIN files f ON f.id=d.file_id
    WHERE d.doc_type='paystub' AND f.source_id=? AND f.removed_at IS NULL`).all(source)
    .map(r => parseJson(r.fields, {}).employerName).filter(Boolean);
  if (!employers.length || !connected.size) return null;
  const key = text => String(text).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const deposits = db.prepare('SELECT account_id,date,description FROM transactions WHERE amount>0 AND date<=? ORDER BY date').all(clock)
    .filter(t => connected.has(t.account_id));
  const dates = employers.map(employer => {
    const name = key(employer);
    const matches = deposits.filter(t => name && ` ${key(t.description)} `.includes(` ${name} `));
    if (new Set(matches.map(t => t.date.slice(0, 7))).size < 2) return null;
    const latest = matches.at(-1)?.date;
    return freshnessOf({ kind: 'paystub', asOf: latest }, clock).state === 'fresh' ? latest : null;
  });
  return dates.every(Boolean) ? dates.sort()[0] : null;
}

export function refreshDependencies(db, figures, clock) {
  const accountIds = new Set(), sourceIds = new Set();
  const tables = new Set(['transactions', 'balances', 'positions', 'pnl_lines', 'tax_payments', 'documents', 'facts']);
  const fileSource = db.prepare('SELECT source_id FROM files WHERE id=? AND removed_at IS NULL');
  const addFile = id => { const source = id && fileSource.get(id)?.source_id; if (source) sourceIds.add(source); };
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (tables.has(value.table) && Array.isArray(value.ids)) {
      const table = value.table;
      for (const id of value.ids) {
        const row = db.prepare(`SELECT * FROM ${table} WHERE ${table === 'facts' ? 'key' : 'id'}=?`).get(id);
        if (row?.account_id) accountIds.add(row.account_id);
        addFile(row?.file_id);
      }
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') visit(child);
  };
  for (const [key, figure] of Object.entries(figures)) {
    if (key.startsWith('bal.')) accountIds.add(key.slice(4));
    addFile(figure.fileId);
    visit(figure.locator);
  }
  const connected = connectedAccountIds(db), states = sourceStates(db, clock);
  for (const source of sourceIds) if (states.sources.get(source)?.state === 'history') sourceIds.delete(source);
  const accounts = db.prepare('SELECT id,inst,name,display_name,source_id FROM accounts WHERE archived_at IS NULL ORDER BY id').all()
    .filter(a => accountIds.has(a.id) && !connected.has(a.id) && ['stale', 'unknown'].includes(states.accounts.get(a.id)?.state));
  return { accounts, sourceIds };
}

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
  const rows = db.prepare("SELECT id, kind, as_of FROM sources WHERE substr(id, 1, 4) = 'ing:' ORDER BY id").all();
  const kindOf = new Map(rows.map((r) => [r.id, r.kind]));
  const { archived, bySource, covered } = historyRule(db);
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

  const connected = connectedAccountIds(db);
  const sources = new Map();
  for (const s of rows) {
    const fed = new Map();
    for (const [account, per] of bySource) if (per.has(s.id)) fed.set(account, per.get(s.id));
    const payroll = s.kind === 'paystub' ? payrollThrough(db, s.id, clock, connected) : null;
    const asOf = payroll && payroll > s.as_of ? payroll : s.as_of;
    const f = freshnessOf({ kind: s.kind, asOf }, clock);
    const history = s.kind !== 'simplefin' && fed.size > 0 && [...fed.keys()].every((account) => covered(account, s.id));
    sources.set(s.id, { state: history ? 'history' : f.state, asOf: asOf ?? '', ageDays: f.ageDays, cadence: f.cadence, kind: s.kind, fed });
  }
  return { sources, accounts };
}
