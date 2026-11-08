// Planning data: everything the planner reads from the store for one run, plus the date helpers,
// the planning tax year (R10), household entities (R1) and per-source freshness (T9.5).
//
// loadPlanningData(db, clock) -> {clock, year, taxYear, accounts, pnl, taxPayments, taxPaymentsNext,
//   withholding, documents, transactions, files, confirm, conflictArchive, aliases, freshness}
//   taxPayments: this tax year's active rows; taxPaymentsNext: next year's (only for the tax_year
//   check); withholding: every active withholding row of any year (who a document belongs to);
//   confirm: ingest's answers the planner reads; conflictArchive: tax_payments rows a
//   withholding_conflict answer dropped; aliases: entity_aliases rows.
// ownerOf(value) -> 'owner' | 'spouse' | 'joint' | 'business' | null (ingest stores option labels)

import { parseJson, cents } from '../../store/db.mjs';
import { accountNaming } from '../../accounts/naming.mjs';
import { addDays, daysBetween } from '../../scenario/build.mjs';
import { monthEnd } from '../../ingest/format.mjs';
import { ledgerDisplayName, ledgerKind } from '../../pnl/ledgers.mjs';
import { connectedThrough, sourceStates } from '../../ingest/coverage.mjs';
import { OWNER_OPTIONS, normalizeName } from '../../ingest/confirm.mjs';

export const SUPPORTED_TAX_YEARS = Object.freeze([2026]);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const STALE_DAYS = 45;

// ---------------------------------------------------------------- dates

export const monthOf = iso => Number(String(iso).slice(5, 7));
export const yearOf = iso => Number(String(iso).slice(0, 4));
export const dayLabel = iso => `${MONTHS[monthOf(iso) - 1]} ${Number(iso.slice(8, 10))}`;
export const dateLabel = iso => `${dayLabel(iso)}, ${iso.slice(0, 4)}`;
export const monthLabel = period => `${MONTHS[monthOf(period) - 1]} ${period.slice(0, 4)}`;
export { addDays, daysBetween, monthEnd };

// `now` as an ISO date: a Date, an ISO date or timestamp string, epoch ms, or undefined.
export function isoDateOf(now) {
  if (now == null || now === '') return undefined;
  if (now instanceof Date) return now.toISOString().slice(0, 10);
  if (typeof now === 'number') return new Date(now).toISOString().slice(0, 10);
  const s = String(now);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 10);
}

// R10: the latest supported year Y <= the clock year whose return is not yet due (clock on or
// before Apr 15 of Y + 1), or null.
export function planningYear(clock) {
  for (let y = yearOf(clock); y >= yearOf(clock) - 1; y--) {
    if (clock <= `${y + 1}-04-15` && SUPPORTED_TAX_YEARS.includes(y)) return y;
  }
  return null;
}

// ---------------------------------------------------------------- text helpers

export const slugOf = name => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const sameName = (a, b) => String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase() && String(a ?? '').trim() !== '';
const sum = list => cents(list.reduce((a, b) => a + b, 0));
export { sum };

// Labels carry no digits except inside the identifiers the grounding guard masks.
export function cleanLabel(text) {
  return String(text ?? '')
    .replace(/(401\s*\(\s*k\s*\)|401k|529|W-2|1099)|\d+/gi, (m, keep) => keep || '')
    .replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').trim();
}

// ---------------------------------------------------------------- categories (R1)

export const isOfficer = c => /officer/i.test(c);
export const isPayrollTax = c => /payroll tax/i.test(c);
export const isIncome = c => c === 'Income';
export const isEmployer401k = c => /401\(?k\)?|retirement contribution|profit sharing/i.test(c);
export const isCharitable = c => /charit|donat/i.test(c ?? '');

// ---------------------------------------------------------------- load

// Ingest writes the account_owner option label ('You', 'Your spouse', ...) into accounts.owner.
export function ownerOf(value) {
  const ids = OWNER_OPTIONS.map(o => o.id);
  if (ids.includes(value)) return value;
  const option = OWNER_OPTIONS.find(o => o.label === value);
  return option ? option.id : null;
}

const CONFIRM_KINDS = ['employer_recipient', 'document_recipient', 'withholding_conflict', 'employer_relation', 'tax_year'];

// An owner fact's value (any src but the planner's own), or undefined.
function ownerFact(db, key) {
  const row = db.prepare("SELECT value FROM facts WHERE key = ? AND (src IS NULL OR src != 'planner')").get(key);
  return row ? parseJson(row.value, undefined) : undefined;
}

export function loadPlanningData(db, clock) {
  const taxYear = planningYear(clock);
  const year = taxYear ?? yearOf(clock);
  const lastPeriod = yearOf(clock) === year ? clock.slice(0, 7) : `${year}-12`;

  const pnl = db.prepare('SELECT * FROM pnl_lines WHERE period >= ? AND period <= ? ORDER BY id').all(`${year}-01`, lastPeriod).map(r => ({ ...r }));
  // A business account's entity: the owner's accounts.businessEntity answer, else the household's
  // only business when there is exactly one.
  const named = ownerFact(db, 'accounts.businessEntity');
  const byAccount = named && typeof named === 'object' && !Array.isArray(named) ? named : {};
  const listed = ownerFact(db, 'business.entities');
  const ledgerFacts = { 'pnl.ledgers': ownerFact(db, 'pnl.ledgers') };
  const businessNames = [...new Map([...(Array.isArray(listed) ? listed.map(e => e && e.name) : []), ...pnl.map(l => l.entity)]
    .filter(n => typeof n === 'string' && normalizeName(n) && ledgerKind(ledgerFacts, n, pnl.filter(l => sameName(l.entity, n))) !== 'spending').map(n => [normalizeName(n), n.trim()])).values()];
  const householdNames = parseJson(db.prepare("SELECT value FROM facts WHERE key = 'household.names'").get()?.value, {}) || {};
  const holders = new Map(db.prepare('SELECT account_id, holder FROM account_holders').all().map((r) => [r.account_id, r.holder]));
  const naming = accountNaming(db);
  const accounts = db.prepare('SELECT * FROM accounts WHERE archived_at IS NULL ORDER BY sort, id').all().map(a => {
    const kind = String(a.kind || '').toLowerCase();
    const stated = typeof byAccount[a.id] === 'string' && byAccount[a.id].trim() ? byAccount[a.id].trim() : null;
    return {
      id: a.id, inst: a.inst, mask: a.mask, name: a.name || '', display_name: a.display_name || null,
      holder: holders.get(a.id) || null, householdNames, ...naming.hint(a.id), owner: ownerOf(a.owner), kind,
      fileId: a.file_id, entity: stated ?? (kind === 'business' && businessNames.length === 1 ? businessNames[0] : null),
      latest: latestBalance(db, a.id, clock),
    };
  });

  const taxPayments = db.prepare('SELECT * FROM tax_payments WHERE tax_year = ? ORDER BY id').all(year).map(r => ({ ...r }));
  const taxPaymentsNext = db.prepare('SELECT * FROM tax_payments WHERE tax_year = ? ORDER BY id').all(year + 1).map(r => ({ ...r }));
  const withholding = db.prepare("SELECT id, file_id, payer, recipient, jurisdiction, tax_year FROM tax_payments WHERE kind = 'withholding' ORDER BY id").all().map(r => ({ ...r }));
  const confirm = db.prepare(`SELECT id, kind, subject, status, answer, context, file_id FROM confirm_items WHERE kind IN (${CONFIRM_KINDS.map(() => '?').join(', ')}) ORDER BY id`)
    .all(...CONFIRM_KINDS).map(r => ({ id: r.id, kind: r.kind, subject: r.subject, status: r.status, answer: r.answer ?? null, context: parseJson(r.context, {}) || {}, fileId: r.file_id ?? null }));
  const conflictArchive = db.prepare("SELECT id, file_id, superseded_by, row FROM superseded_rows WHERE table_name = 'tax_payments' AND reason = 'withholding_conflict' ORDER BY id")
    .all().map(r => ({ id: r.id, fileId: r.file_id ?? null, supersededBy: r.superseded_by ?? null, row: parseJson(r.row, {}) || {} }));
  const aliases = db.prepare('SELECT alias, entity FROM entity_aliases ORDER BY alias').all().map(r => ({ alias: r.alias, entity: r.entity }));
  const documents = db.prepare('SELECT * FROM documents ORDER BY id').all().map(d => ({
    id: d.id, docType: String(d.doc_type || '').toLowerCase(), taxYear: d.tax_year, fields: parseJson(d.fields, {}) || {}, fileId: d.file_id,
  }));
  const transactions = db.prepare('SELECT * FROM transactions WHERE date > ? AND date <= ? ORDER BY id').all(addDays(clock, -400), clock).map(r => ({ ...r }));
  const files = db.prepare('SELECT id, name, source_kind, uploaded_at, status FROM files WHERE removed_at IS NULL ORDER BY uploaded_at, id').all().map(r => ({ ...r }));

  return {
    clock, year, taxYear, accounts, pnl, taxPayments, taxPaymentsNext, withholding, documents, transactions, files,
    confirm, conflictArchive, aliases, freshness: freshness(db, clock),
  };
}

function latestBalance(db, accountId, clock) {
  const b = db.prepare('SELECT id, date, amount, file_id FROM balances WHERE account_id = ? AND date <= ? ORDER BY date DESC, id DESC LIMIT 1').get(accountId, clock);
  if (b) return { date: b.date, amount: cents(b.amount), source: 'balances', ids: [b.id], fileId: b.file_id };
  const p = db.prepare('SELECT max(as_of) AS d FROM positions WHERE account_id = ? AND as_of <= ?').get(accountId, clock);
  if (!p || !p.d) return null;
  const rows = db.prepare('SELECT id, value, file_id FROM positions WHERE account_id = ? AND as_of = ? ORDER BY id').all(accountId, p.d);
  return { date: p.d, amount: sum(rows.map(r => r.value ?? 0)), source: 'positions', ids: rows.map(r => r.id), fileId: rows[0] ? rows[0].file_id : null };
}

// Federal installment due dates (Apr 15, Jun 15, Sep 15, Jan 15): the latest on or before clock.
function lastInstallmentDue(clock) {
  const y = yearOf(clock);
  const dates = [`${y - 1}-09-15`, `${y}-01-15`, `${y}-04-15`, `${y}-06-15`, `${y}-09-15`];
  return dates.filter(d => d <= clock).at(-1);
}

export const SOURCE_LABELS = Object.freeze({
  balances: 'Account balances',
  transactions: 'Account transactions',
  pnl: 'Business profit and loss',
  tax_payments: 'Estimated tax payment log',
});

function freshness(db, clock) {
  const one = sql => (db.prepare(sql).get(clock) || {}).d || null;
  const bal = one('SELECT max(date) AS d FROM balances WHERE date <= ?');
  const pos = one('SELECT max(as_of) AS d FROM positions WHERE as_of <= ?');
  const period = one('SELECT max(period) AS d FROM pnl_lines WHERE period <= substr(?, 1, 7)');
  const latest = {
    balances: [bal, pos].filter(Boolean).sort().at(-1) || null,
    // SimpleFIN covering every account with transactions keeps the log current (ingest/coverage.mjs).
    transactions: [one('SELECT max(date) AS d FROM transactions WHERE date <= ?'), connectedThrough(db, clock)].filter(Boolean).sort().at(-1) || null,
    pnl: period ? monthEnd(period) : null,
    tax_payments: one('SELECT max(date) AS d FROM tax_payments WHERE date <= ?'),
  };
  // With ingest accounts, balances and transactions are stale exactly when an active account is
  // stale under the shared rule (coverage.mjs), the accounts the Cash card counts: an archived,
  // connected or covered account never asks for a fresh export.
  const accounts = [...sourceStates(db, clock).accounts.values()];
  const anyStale = accounts.some(a => a.state === 'stale');
  return Object.entries(latest).map(([id, date]) => {
    let state = 'current';
    if (!date) state = 'missing';
    else if (id === 'tax_payments') state = date < lastInstallmentDue(clock) ? 'stale' : 'current';
    else if (accounts.length && ['balances', 'transactions'].includes(id)) state = anyStale ? 'stale' : 'current';
    else if (daysBetween(date, clock) > STALE_DAYS) state = 'stale';
    return { id, label: SOURCE_LABELS[id], latest: date, state };
  });
}

// ---------------------------------------------------------------- entities (R1, T8)

// Household businesses: the business.entities fact gives classification; P&L entities match by
// trimmed, case-insensitive name; an unmatched P&L entity is unclassified.
export function resolveEntities(data, facts) {
  const TYPES = ['s_corp', 'sole_prop', 'llc_single', 'partnership', 'c_corp'];
  const out = [];
  const add = e => {
    if (!e || typeof e.name !== 'string' || !e.name.trim()) return;
    if (out.some(x => sameName(x.name, e.name))) return;
    out.push({
      name: e.name.trim(), slug: slugOf(e.name), type: TYPES.includes(e.type) ? e.type : null,
      owner: e.owner === 'spouse' ? 'spouse' : 'owner', sstb: typeof e.sstb === 'boolean' ? e.sstb : null,
      docId: null, fileId: null, classified: TYPES.includes(e.type), lines: [],
    });
  };
  const listed = facts['business.entities'];
  if (Array.isArray(listed)) for (const e of listed) add(e);
  for (const line of data.pnl) {
    let e = out.find(x => sameName(x.name, line.entity));
    if (!e) {
      out.push({ name: String(line.entity).trim(), slug: slugOf(line.entity), type: null, owner: 'owner', sstb: null, docId: null, fileId: null, classified: false, lines: [] });
      e = out.at(-1);
    }
    e.lines.push(line);
  }
  for (const e of out) {
    e.displayName = e.lines.length ? ledgerDisplayName(e.lines[0]) : e.name;
    e.months = e.lines.length ? Math.max(...e.lines.map(l => monthOf(l.period))) : 0;
  }
  return out.filter(e => ledgerKind(facts, e.name, e.lines) !== 'spending');
}

// P&L sums for one entity (amounts: income positive, expenses negative).
export function pnlSums(entity) {
  const lines = entity.lines;
  const pick = test => lines.filter(l => test(l.category));
  return {
    income: sum(pick(isIncome).map(l => l.amount)),
    expenses: sum(lines.filter(l => l.amount < 0).map(l => -l.amount)),
    net: sum(lines.map(l => l.amount)),
    salary: sum(pick(isOfficer).map(l => -l.amount)),
    payrollTax: sum(pick(isPayrollTax).map(l => -l.amount)),
    employer401k: sum(pick(isEmployer401k).map(l => -l.amount)),
    ids: { all: lines.map(l => l.id), income: pick(isIncome).map(l => l.id), salary: pick(isOfficer).map(l => l.id), payrollTax: pick(isPayrollTax).map(l => l.id) },
    fileId: lines[0] ? lines[0].file_id : null,
  };
}

// Transactions in the planning year up to the clock.
export function ytd(data, t) {
  const end = `${data.year}-12-31` < data.clock ? `${data.year}-12-31` : data.clock;
  return t.date >= `${data.year}-01-01` && t.date <= end;
}
