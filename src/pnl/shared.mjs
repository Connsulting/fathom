// Shared pieces of the P&L and household spending reads: errors, month ranges, the classified
// transaction set, account labels, figure keys and the figure registry that gives every number its
// source, detail rows and provenance. Everything here is read only.

import { cents, parseJson } from '../store/db.mjs';
import { accountLabel } from '../shared/account-label.mjs';
import { accountNaming } from '../accounts/naming.mjs';
import { resolveTokens } from '../shared/tokens.mjs';
import { resolveClock, tokenScope } from '../scenario/build.mjs';
import { loadCategoryInputs } from '../categories/store.mjs';
import { resolveCategories } from '../categories/resolve.mjs';

export const MAX_MONTHS = 36;
export const ROW_IDS = 50;
export const ITEM_LIMIT = 500;
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// code: unknown_entity (HTTP 404), bad_range, bad_option, bad_input (HTTP 400).
export class PnlError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PnlError';
    this.code = code;
  }
}

// ---------------------------------------------------------------- months

export const validMonth = (m) => typeof m === 'string' && MONTH.test(m);
const monthIndex = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;
const monthOfIndex = (i) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
export const addMonths = (m, n) => monthOfIndex(monthIndex(m) + n);
export const monthsBetween = (from, to) => {
  const out = [];
  for (let i = monthIndex(from); i <= monthIndex(to); i++) out.push(monthOfIndex(i));
  return out;
};
export const monthLabel = (m) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
export function monthEnd(m) {
  const y = Number(m.slice(0, 4));
  const mo = Number(m.slice(5, 7));
  return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
}

// 'Jan 2032', 'Jan to Jun 2032' or 'Nov 2031 to Oct 2032'.
export function spanLabel(from, to) {
  if (from === to) return monthLabel(from);
  if (from.slice(0, 4) === to.slice(0, 4)) return `${MONTH_NAMES[Number(from.slice(5, 7)) - 1]} to ${monthLabel(to)}`;
  return `${monthLabel(from)} to ${monthLabel(to)}`;
}

// Consecutive runs of a sorted month list, as 'Jan to Jun 2032, Sep 2032'.
export function runsLabel(months) {
  const runs = [];
  for (const m of months) {
    const last = runs.at(-1);
    if (last && addMonths(last[1], 1) === m) last[1] = m;
    else runs.push([m, m]);
  }
  return runs.map(([a, b]) => spanLabel(a, b)).join(', ');
}

export function checkMonth(m, name) {
  if (m == null) return null;
  if (!validMonth(m)) throw new PnlError('bad_range', `${name} must be a month as YYYY-MM`);
  return m;
}

export function checkRange(from, to) {
  if (from > to) throw new PnlError('bad_range', 'from is after to');
  if (monthIndex(to) - monthIndex(from) + 1 > MAX_MONTHS) throw new PnlError('bad_range', `a range is at most ${MAX_MONTHS} months`);
  return monthsBetween(from, to);
}

export function clockOf(db, clock) {
  if (clock != null && (typeof clock !== 'string' || !DAY.test(clock))) throw new PnlError('bad_input', 'clock must be a date as YYYY-MM-DD');
  return resolveClock(db, clock || undefined);
}

export function checkDb(db) {
  if (!db || typeof db.prepare !== 'function') throw new PnlError('bad_input', 'a store is required');
}

// ---------------------------------------------------------------- store reads

// An owner fact's value (any src but the planner's own), as the planner and loadCategoryInputs read it.
export function ownerFact(db, key) {
  const row = db.prepare("SELECT value FROM facts WHERE key = ? AND (src IS NULL OR src != 'planner')").get(key);
  return row ? parseJson(row.value, undefined) : undefined;
}

// Every transaction on or before the clock with its resolved category (default transfer priority).
export function classified(db, clock) {
  const input = loadCategoryInputs(db);
  input.transactions = input.transactions.filter((t) => t.date <= clock);
  const resolved = resolveCategories(input);
  return { accounts: input.accounts, transactions: input.transactions, resolved };
}

// Account labels by id. Demo rows resolve their tokens first; imported text stays plain text.
export function accountLabels(db) {
  const rows = db.prepare('SELECT * FROM accounts ORDER BY sort, id').all();
  let plain = null;
  const naming = accountNaming(db);
  const out = new Map();
  rows.forEach((a, i) => {
    let row = a;
    if (a.parser === 'demo-seed') {
      if (!plain) { const scope = tokenScope(db); plain = (s) => resolveTokens(scope, s, false); }
      row = { ...a, inst: plain(a.inst || ''), name: plain(a.name || ''), owner: plain(a.owner || '') };
    }
    out.set(a.id, { label: accountLabel({ ...row, ...naming.hint(a.id) }), order: i });
  });
  return out;
}

export const fileNames = (db) => new Map(db.prepare('SELECT id, name FROM files').all().map((f) => [f.id, f.name]));

// ---------------------------------------------------------------- rows and keys

export const lineRow = (l) => ({ table: 'pnl_lines', id: l.id, month: l.period, date: monthEnd(l.period), amount: l.amount, fileId: l.file_id ?? null, accountId: null, category: l.category });
export const txnRow = (t) => ({ table: 'transactions', id: t.id, month: t.date.slice(0, 7), date: t.date, amount: t.amount, fileId: t.file_id ?? null, accountId: t.account_id, description: t.description ?? '' });

// Figure key part: anything outside [A-Za-z0-9:-] (the separator dot and the escape included) as _xxxx.
export const enc = (s) => String(s).replace(/[^A-Za-z0-9:-]/g, (c) => `_${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

export const money = (v) => cents(v) || 0;
export const sumOf = (rows, pick = (r) => r.value) => money(rows.reduce((s, r) => s + pick(r), 0));
export const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id);

// ---------------------------------------------------------------- figures

const SOURCE_LABELS = {
  'pnl:workbook': 'Imported P&L workbook',
  'pnl:transactions': 'Categorized business transactions',
  'pnl:mixed': 'P&L workbook and categorized transactions',
  'spend:transactions': 'Categorized household transactions',
};

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// One registry per response. add() returns the key; done() returns {figures, sources}. A source's
// asOf is the newest counted row behind its figures (a workbook month counts as its month end), else
// the newest row behind any of its figures.
export function figureRegistry({ kind, labels, files }) {
  const figures = {};
  const newest = new Map();
  const bump = (src, slot, date) => {
    const n = newest.get(src) ?? { counted: '', any: '' };
    if (date > n[slot]) n[slot] = date;
    newest.set(src, n);
  };
  const add = (key, { v, label, rows, notes = [], sums = null, counted = false, detail = [] }) => {
    const lines = rows.filter((r) => r.table === 'pnl_lines');
    const txns = rows.filter((r) => r.table === 'transactions');
    const source = lines.length && txns.length ? 'workbook and transactions' : lines.length ? 'workbook' : 'transactions';
    const src = kind === 'spend' ? 'spend:transactions'
      : source === 'workbook' ? 'pnl:workbook' : source === 'transactions' ? 'pnl:transactions' : 'pnl:mixed';
    const accountIds = [...new Set(txns.map((r) => r.accountId))]
      .sort((a, b) => (labels.get(a)?.order ?? 0) - (labels.get(b)?.order ?? 0));
    const accounts = accountIds.map((id) => ({ id, label: labels.get(id)?.label ?? id }));
    const months = [...new Set(rows.map((r) => r.month))].sort();
    const rowRefs = [['pnl_lines', lines], ['transactions', txns]].filter(([, list]) => list.length)
      .map(([table, list]) => ({ table, ids: list.map((r) => r.id).sort((a, b) => a - b).slice(0, ROW_IDS), count: list.length }));
    if (!rowRefs.length) rowRefs.push({ table: kind === 'spend' ? 'transactions' : 'pnl_lines', ids: [], count: 0 });
    const fileIds = [...new Set(rows.map((r) => r.fileId).filter(Boolean))].sort();
    const fileRefs = fileIds.map((id) => ({ id, name: files.get(id) ?? 'Imported file' }));
    const counts = [];
    if (lines.length) counts.push(plural(lines.length, 'workbook line', 'workbook lines'));
    if (txns.length) counts.push(plural(txns.length, 'transaction', 'transactions'));
    const rowsDetail = [];
    if (months.length) rowsDetail.push({ k: 'Months', v: runsLabel(months) });
    if (accounts.length) rowsDetail.push({ k: 'Accounts', v: accounts.map((a) => a.label).join(', ') });
    rowsDetail.push({ k: 'Rows', v: counts.length ? counts.join(' and ') : 'No rows' });
    if (fileRefs.length) rowsDetail.push({ k: 'Files', v: fileRefs.map((f) => f.name).join(', ') });
    for (const r of rows) bump(src, counted ? 'counted' : 'any', r.date);
    if (!newest.has(src)) newest.set(src, { counted: '', any: '' });
    figures[key] = {
      v: money(v), src, kind: 'a', label, notes: notes.slice(0, 5), detail: [...rowsDetail, ...detail],
      ...(sums ? { sums } : {}),
      provenance: { source, accounts, months, rows: rowRefs, files: fileRefs },
    };
    return key;
  };
  const done = () => {
    const sources = {};
    for (const [src, n] of newest) sources[src] = { label: SOURCE_LABELS[src], asOf: n.counted || n.any || null };
    return { figures, sources };
  };
  return { add, done };
}

// Per-month sums for a multi-month figure: one entry per month that has rows behind it.
export function monthSums(rowsByMonth, months, asOfOf) {
  const out = [];
  for (const m of months) {
    const rows = rowsByMonth.get(m);
    if (rows && rows.length) out.push({ label: monthLabel(m), v: sumOf(rows), asOf: asOfOf(m) });
  }
  return out.length > 1 ? out : null;
}

// A row item for the rows reads (newest first): the signed amount and a figure of its own.
export function rowItem(reg, key, r, { account, category, label }) {
  const fig = reg.add(key, { v: r.amount, label, rows: [r], counted: true });
  return r.table === 'pnl_lines'
    ? { id: r.id, kind: 'workbook', date: r.month, description: 'Workbook line', account, category, amount: r.amount, fig }
    : { id: r.id, kind: 'transaction', date: r.date, description: r.description, account, category, amount: r.amount, fig };
}
