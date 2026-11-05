// Synthetic real-mode store for planner tests and the local real-data check.
//
// createRealStore(dataDir, {clock})            -> db (empty real store: mode real, clock, onboarding done)
// ingestFile(db, file, {accountHints})         -> {fileId, parser, rows, byKind, warnings}
// addDocument(db, {docType, taxYear, fields})  -> document id
// addFact(db, key, value, {src, confirmed})    -> void (owner-set by default)
// buildRealStore(dataDir, {clock, variant})    -> db with the synthetic household loaded
//
// Files run through the real parsers (pickParser + parse) and a small loader here. Every name,
// institution and amount below is invented. Variant options are documented on buildRealStore.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStoreFile, setSetting, getSetting, tx, DB_FILE } from '../../src/store/db.mjs';
import { pickParser } from '../../src/ingest/registry.mjs';
import { dedupeKey } from '../../src/ingest/dedupe.mjs';
import { writeXlsx, XLSX_MIME } from './xlsx.mjs';

export const CLOCK = '2026-11-05';
export const TAX_YEAR = 2026;
export const MONTHS = 10; // P&L, HSA and charitable data cover Jan..Oct of the tax year

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const sha = (...parts) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(typeof p === 'string' ? p : Buffer.from(p)).update('\0');
  return h.digest('hex');
};

// ---------------------------------------------------------------- the synthetic household

export const SCORP = Object.freeze({
  name: 'Northwind Advisory', slug: 'northwind-advisory', type: 's_corp', owner: 'owner',
  income: 20000, expenses: Object.freeze({ 'Officer salary': 5000, 'Payroll taxes': 382.5, Software: 300 }),
});
export const SOLE_PROP = Object.freeze({
  name: 'Bluebird Studio', slug: 'bluebird-studio', type: 'sole_prop', owner: 'spouse',
  income: 6000, expenses: Object.freeze({ Supplies: 500 }),
});
export const ENTITIES = Object.freeze([SCORP, SOLE_PROP]);

export const INST = Object.freeze({
  bank: 'Chase',
  hsa: 'Sample HSA Trust',
  college: 'Sample College Plan',
  card: 'Sample Card Co',
  broker: '',
});

export const MASKS = Object.freeze({ checking: '1111', business: '4444', hsa: '2222', college: '3333', card: '5555', ira: '6666' });

// Explicit account mapping hints (R18, S13, T8), keyed '<inst>|<mask>'.
export const HINTS = Object.freeze({
  [`${INST.bank}|${MASKS.checking}`]: { name: 'Personal checking', kind: 'checking', owner: null },
  [`${INST.bank}|${MASKS.business}`]: { name: 'Business checking', kind: 'business', owner: null, entity: SCORP.name },
  [`${INST.hsa}|${MASKS.hsa}`]: { name: 'Family HSA', kind: 'hsa', owner: 'owner' },
  [`${INST.college}|${MASKS.college}`]: { name: 'College 529', kind: '529', owner: null },
  [`${INST.card}|${MASKS.card}`]: { name: 'Rewards card', kind: 'card', owner: null },
  [`${INST.broker}|${MASKS.ira}`]: { name: 'Rollover IRA', kind: 'retirement', owner: 'owner' },
});

// Monthly amounts and balances the files below produce.
export const SYNTH = Object.freeze({
  checkingEnd: 25000,          // Chase 1111 on 2026-10-31
  businessEnd: 40000,          // Chase 4444 on 2026-10-31
  mortgage: 3000,              // monthly, Chase 1111
  groceries: 1500,             // monthly, Chase 1111
  hsaMonthly: 300,             // inflow into HSA 2222, Jan..Oct
  collegeMarch: 1000,          // one inflow into 529 3333 in March
  charityMonthly: 250,         // outflow from card 5555, Jan..Oct
  iraValue: 50000,             // Rollover IRA 6666 position value on 2026-10-31
  fedPaid: 6000,               // federal estimate paid in April, June, September
  statePaid: 2000,             // state estimate paid in the same months
  paidMonths: Object.freeze([4, 6, 9]),
  prior: Object.freeze({ federalTax: 30000, virginiaTax: 9000, agi: 240000 }),
  salaryRange: Object.freeze({ min: 50000, max: 110000 }),
  ownerAge: 45,
  spouseAge: 43,
});

// Owner answers (src 'you', confirmed 1), R6 as amended by S8/S13. accounts.va529 is filled in
// once the 529 account id is known.
export const OWNER_FACTS = Object.freeze({
  'household.state': 'VA',
  'household.filingStatus': 'mfj',
  'household.dependents': 1,
  'household.expectingChild': true,
  'household.dependentAges': [2],
  'retirement.planTermsConfirmed': true,
  'retirement.aggregationConfirmed': true,
  'benefits.hsaEligible': true,
  'benefits.hsaCoverage': 'family',
  'business.salaryRange': { min: 50000, max: 110000 },
  'household.ownerAge': 45,
  'household.spouseAge': 43,
  'business.cashBasis': true,
});

// ---------------------------------------------------------------- store primitives

export function createRealStore(dataDir, { clock = CLOCK } = {}) {
  mkdirSync(dataDir, { recursive: true });
  return createStoreFile(join(dataDir, DB_FILE), db => {
    setSetting(db, 'mode', 'real');
    setSetting(db, 'clock', clock);
    setSetting(db, 'onboarding', { done: true, step: 6 });
  });
}

const stampOf = (db) => `${getSetting(db, 'clock', CLOCK)}T09:00:00.000Z`;

export function accountId({ inst = '', mask = '', name = '' } = {}) {
  const identity = mask ? `${inst}|${mask}|` : `${inst}||${String(name).trim().toLowerCase()}`;
  return `acct-${sha(identity).slice(0, 8)}`;
}

export function accountIdByMask(db, mask) {
  const row = db.prepare('SELECT id FROM accounts WHERE mask = ?').get(mask);
  return row ? row.id : null;
}

export function accountIds(db) {
  return Object.fromEntries(db.prepare('SELECT id, mask FROM accounts WHERE mask IS NOT NULL').all().map(r => [r.mask, r.id]));
}

function normalizeKind(raw, name, sourceKind) {
  const text = `${raw ?? ''} ${name ?? ''}`.toLowerCase();
  if (/\bbusiness\b/.test(text)) return 'business';
  if (/\bhsa\b|health savings/.test(text)) return 'hsa';
  if (/529/.test(text)) return '529';
  if (/\broth\b/.test(text)) return 'roth';
  if (/\bira\b|401\s*\(?k\)?|retirement/.test(text)) return 'retirement';
  if (/saving/.test(text)) return 'savings';
  if (/credit|card/.test(text)) return 'card';
  if (/checking/.test(text)) return 'checking';
  if (/brokerage|taxable|individual|joint/.test(text)) return 'taxable';
  if (sourceKind === 'brokerage_positions') return 'taxable';
  return 'checking';
}

function ensureAccount(db, account, ctx) {
  const inst = account.inst ?? '';
  const mask = account.mask || '';
  const rawName = account.name || '';
  const id = accountId({ inst, mask, name: rawName });
  if (db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(id)) return id;
  const hint = (ctx.hints && ctx.hints[`${inst}|${mask}`]) || null;
  const name = (hint && hint.name) || rawName || `${inst} ${mask}`.trim();
  const kind = hint && hint.kind ? String(hint.kind).toLowerCase() : normalizeKind(account.kind, name, ctx.sourceKind);
  const owner = hint && hint.owner != null ? hint.owner : null;
  const locator = { ...(ctx.locator || {}), ...(hint && hint.entity ? { entity: hint.entity } : {}) };
  const sort = db.prepare('SELECT count(*) AS n FROM accounts').get().n;
  db.prepare(`INSERT INTO accounts (id, inst, mask, name, owner, kind, mirror, note, fig_key, file_id, parser, locator, sort)
              VALUES (?, ?, ?, ?, ?, ?, 'manual', '', NULL, ?, ?, ?, ?)`)
    .run(id, inst, mask || null, name, owner, kind, ctx.fileId, ctx.parser, JSON.stringify(locator), sort);
  return id;
}

// Load one file through the parser registry. A file no parser accepts gets a files row with
// status 'unparsed' and parser null.
export function ingestFile(db, file, { accountHints = {} } = {}) {
  const bytes = file.bytes instanceof Uint8Array ? file.bytes : new Uint8Array(Buffer.from(file.bytes));
  const named = { name: file.name, bytes, mime: file.mime };
  const digest = sha(bytes);
  const fileId = `file-${sha(file.name, bytes).slice(0, 12)}`;
  const parser = pickParser(named);
  const uploadedAt = stampOf(db);
  const insertFile = (status, sourceKind) => db.prepare(`INSERT OR IGNORE INTO files (id, name, mime, size, sha256, source_kind, uploaded_at, stored_path, status, note)
                                                         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`)
    .run(fileId, file.name, file.mime ?? null, bytes.length, digest, sourceKind, uploadedAt, status);
  if (!parser) {
    insertFile('unparsed', null);
    return { fileId, parser: null, rows: 0, byKind: {}, warnings: [] };
  }
  const parsed = parser.parse(named);
  const byKind = {};
  for (const row of parsed.rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
  const warnings = [...new Set(parsed.warnings.map(w => w.code))].sort();
  const prov = (row) => [fileId, parser.id, JSON.stringify(row.locator ?? {})];
  tx(db, () => {
    insertFile(parsed.rows.length ? 'parsed' : 'unparsed', parser.sourceKind);
    for (const row of parsed.rows) {
      const ctx = { hints: accountHints, fileId, parser: parser.id, sourceKind: parser.sourceKind, locator: row.locator };
      switch (row.kind) {
        case 'transaction': {
          const acct = ensureAccount(db, row.account, ctx);
          db.prepare(`INSERT INTO transactions (account_id, date, amount, description, category, external_id, dedupe_key, file_id, parser, locator)
                      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`)
            .run(acct, row.date, row.amount, row.description ?? '', row.category ?? null, dedupeKey(row), ...prov(row));
          break;
        }
        case 'balance': {
          const acct = ensureAccount(db, row.account, ctx);
          db.prepare(`INSERT INTO balances (account_id, date, amount, file_id, parser, locator) VALUES (?, ?, ?, ?, ?, ?)
                      ON CONFLICT(account_id, date) DO NOTHING`).run(acct, row.date, row.amount, ...prov(row));
          break;
        }
        case 'position': {
          const acct = ensureAccount(db, row.account, ctx);
          const seen = db.prepare('SELECT 1 FROM positions WHERE account_id = ? AND as_of = ? AND symbol = ?').get(acct, row.asOf, row.symbol);
          if (!seen) {
            db.prepare(`INSERT INTO positions (account_id, as_of, symbol, name, quantity, price, value, cost_basis, file_id, parser, locator)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
              .run(acct, row.asOf, row.symbol, row.name ?? null, row.quantity, row.price, row.value, row.costBasis ?? null, ...prov(row));
          }
          break;
        }
        case 'pnl_line': {
          const seen = db.prepare('SELECT 1 FROM pnl_lines WHERE entity = ? AND period = ? AND category = ?').get(row.entity, row.period, row.category);
          if (!seen) {
            db.prepare('INSERT INTO pnl_lines (entity, period, category, amount, file_id, parser, locator) VALUES (?, ?, ?, ?, ?, ?, ?)')
              .run(row.entity, row.period, row.category, row.amount, ...prov(row));
          }
          break;
        }
        case 'tax_payment': {
          const seen = db.prepare('SELECT 1 FROM tax_payments WHERE jurisdiction = ? AND tax_year = ? AND date = ? AND locator = ?')
            .get(row.jurisdiction, row.taxYear, row.date, JSON.stringify(row.locator ?? {}));
          if (!seen) {
            db.prepare('INSERT INTO tax_payments (jurisdiction, tax_year, date, amount, kind, file_id, parser, locator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
              .run(row.jurisdiction, row.taxYear, row.date, row.amount, row.paymentKind ?? 'paid', ...prov(row));
          }
          break;
        }
        case 'document':
          db.prepare('INSERT INTO documents (doc_type, tax_year, fields, file_id, parser, locator) VALUES (?, ?, ?, ?, ?, ?)')
            .run(row.docType, row.taxYear ?? null, JSON.stringify(row.fields ?? {}), ...prov(row));
          break;
        case 'fact':
          db.prepare(`INSERT INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
                      VALUES (?, ?, 'file', NULL, 0, ?, ?, ?, ?) ON CONFLICT(key) DO NOTHING`)
            .run(row.key, JSON.stringify(row.value), ...prov(row), uploadedAt);
          break;
        default:
          break;
      }
    }
  });
  return { fileId, parser: parser.id, rows: parsed.rows.length, byKind, warnings };
}

export function addDocument(db, { docType, taxYear = null, fields = {} }) {
  const r = db.prepare(`INSERT INTO documents (doc_type, tax_year, fields, file_id, parser, locator)
                        VALUES (?, ?, ?, NULL, 'manual', ?)`)
    .run(docType, taxYear, JSON.stringify(fields), JSON.stringify({ entered: 'owner' }));
  return Number(r.lastInsertRowid);
}

export function addFact(db, key, value, { src = 'you', confirmed = true, asOf = null } = {}) {
  db.prepare(`INSERT INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
              VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, src = excluded.src, as_of = excluded.as_of,
                confirmed = excluded.confirmed, file_id = NULL, parser = NULL, locator = NULL, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(value), src, asOf, confirmed ? 1 : 0, new Date().toISOString());
}

export function removeFact(db, key) {
  db.prepare('DELETE FROM facts WHERE key = ?').run(key);
}

// ---------------------------------------------------------------- synthetic files

const csvLine = (cells) => cells.map(c => {
  const s = String(c ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(',');
const csvFile = (name, header, rows) => ({
  name,
  mime: 'text/csv',
  bytes: new TextEncoder().encode([csvLine(header), ...rows.map(csvLine)].join('\n') + '\n'),
});
const us = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`;
const money2 = (n) => n.toFixed(2);

export function pnlWorkbook(entities, extra = [], { year = TAX_YEAR, months = MONTHS } = {}) {
  const sheets = [];
  for (const e of entities) {
    const income = [['Payment Date', 'Payment Amount']];
    if (e.income) for (let m = 1; m <= months; m++) income.push([`${year}-${pad(m)}-15`, e.income]);
    sheets.push({ name: `${e.name} Income`, rows: income });
    const lines = Object.entries(e.expenses || {}).concat(extra.filter(x => x.entity === e.name).map(x => [x.category, x.monthly]));
    if (lines.length) {
      const expenses = [['Date', 'Category', 'Amount']];
      for (let m = 1; m <= months; m++) {
        for (const [category, amount] of lines) expenses.push([`${year}-${pad(m)}-${pad(Math.min(28, lastDay(year, m)))}`, category, amount]);
      }
      sheets.push({ name: `${e.name} Expenses`, rows: expenses });
    }
  }
  return { name: 'Business P&L 2026.xlsx', mime: XLSX_MIME, bytes: writeXlsx(sheets) };
}

export function taxPaymentsWorkbook({ year = TAX_YEAR, fed = SYNTH.fedPaid, state = SYNTH.statePaid, months = SYNTH.paidMonths } = {}) {
  const rows = [[null, 'Federal', 'State'], ['Month', 'Owner Paid', 'Owner Paid']];
  MONTH_NAMES.forEach((label, i) => {
    const paid = months.includes(i + 1);
    rows.push([label, paid ? fed : null, paid ? state : null]);
  });
  return { name: 'Estimated taxes.xlsx', mime: XLSX_MIME, bytes: writeXlsx([{ name: String(year), rows }]) };
}

const CHASE_HEADER = ['Details', 'Posting Date', 'Description', 'Amount', 'Type', 'Balance', 'Check or Slip #'];

// Personal checking 1111: per month a deposit, the mortgage and groceries; the balance returns to
// 25,000 at every month end, ending 25,000 on Oct 31.
export function personalCheckingCsv({ year = TAX_YEAR, months = MONTHS } = {}) {
  const rows = [];
  let bal = SYNTH.checkingEnd;
  for (let m = 1; m <= months; m++) {
    const deposit = SYNTH.mortgage + SYNTH.groceries;
    bal += deposit; rows.push(['CREDIT', `${year}-${pad(m)}-01`, 'Deposit', deposit, 'ACH_CREDIT', bal]);
    bal -= SYNTH.mortgage; rows.push(['DEBIT', `${year}-${pad(m)}-05`, 'Mortgage', -SYNTH.mortgage, 'ACH_DEBIT', bal]);
    bal -= SYNTH.groceries; rows.push(['DEBIT', `${year}-${pad(m)}-${pad(lastDay(year, m))}`, 'Grocery store', -SYNTH.groceries, 'DEBIT_CARD', bal]);
  }
  rows.reverse(); // newest first, like the bank export
  return csvFile(`Chase${MASKS.checking}_Activity_${year}1031.csv`, CHASE_HEADER,
    rows.map(([d, date, desc, amt, type, b]) => [d, us(date), desc, money2(amt), type, money2(b), '']));
}

// Business checking 4444: a client receipt and a payroll and vendor run per month; +4,000 a month
// from zero, ending 40,000 on Oct 31.
export function businessCheckingCsv({ year = TAX_YEAR, months = MONTHS } = {}) {
  const rows = [];
  let bal = 0;
  for (let m = 1; m <= months; m++) {
    bal += 20000; rows.push(['CREDIT', `${year}-${pad(m)}-10`, 'Client receipt', 20000, 'ACH_CREDIT', bal]);
    bal -= 16000; rows.push(['DEBIT', `${year}-${pad(m)}-${pad(lastDay(year, m))}`, 'Payroll and vendors', -16000, 'ACH_DEBIT', bal]);
  }
  rows.reverse();
  return csvFile(`Chase${MASKS.business}_Activity_${year}1031.csv`, CHASE_HEADER,
    rows.map(([d, date, desc, amt, type, b]) => [d, us(date), desc, money2(amt), type, money2(b), '']));
}

// Aggregator export: amounts are outflow-positive (the parser flips the sign).
export function aggregatorCsv({ year = TAX_YEAR, months = MONTHS } = {}) {
  const rows = [];
  for (let m = 1; m <= months; m++) {
    rows.push([`${year}-${pad(m)}-15`, 'HSA', 'Family HSA', MASKS.hsa, INST.hsa, money2(-SYNTH.hsaMonthly), 'HSA deposit', 'Deposit']);
    rows.push([`${year}-${pad(m)}-20`, 'Credit Card', 'Rewards card', MASKS.card, INST.card, money2(SYNTH.charityMonthly), 'Example Charity Fund', 'Charitable']);
  }
  rows.push([`${year}-03-10`, '529', 'College 529', MASKS.college, INST.college, money2(-SYNTH.collegeMarch), 'College plan deposit', 'Deposit']);
  rows.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return csvFile('aggregator-export.csv',
    ['Date', 'Account Type', 'Account Name', 'Account Number', 'Institution Name', 'Amount', 'Description', 'Category'], rows);
}

export function positionsCsv({ asOf = `${TAX_YEAR}-10-31` } = {}) {
  return csvFile(`Positions_${asOf}.csv`,
    ['Account Number', 'Account Name', 'Symbol', 'Description', 'Quantity', 'Last Price', 'Current Value'],
    [[`X0000${MASKS.ira}`, 'Rollover IRA', 'IDXF', 'Example Total Market Index Fund', '400', '125.00', money2(SYNTH.iraValue)]]);
}

// ---------------------------------------------------------------- the full build

// variant (all optional):
//   entities:     replace ENTITIES ({name, type, owner, income, expenses, doc?: false to skip the entity document})
//   pnlExtra:     [{entity, category, monthly}] extra expense lines (positive amounts are expenses)
//   documents:    extra documents [{docType, taxYear, fields}]
//   facts:        owner facts to add or override; a value of undefined leaves the fact out
//   hints:        account hints merged over HINTS ({'<inst>|<mask>': {...}})
//   taxPayments:  false to leave out the tax payment workbook
//   priorReturn:  false to leave out the 2025 tax_return document
export function buildRealStore(dataDir, { clock = CLOCK, variant = {} } = {}) {
  const db = createRealStore(dataDir, { clock });
  const entities = variant.entities || ENTITIES;
  const hints = { ...HINTS, ...(variant.hints || {}) };
  const files = [
    pnlWorkbook(entities, variant.pnlExtra || []),
    ...(variant.taxPayments === false ? [] : [taxPaymentsWorkbook()]),
    personalCheckingCsv(),
    businessCheckingCsv(),
    aggregatorCsv(),
    positionsCsv(),
  ];
  for (const f of files) {
    const out = ingestFile(db, f, { accountHints: hints });
    if (!out.parser) throw new Error(`synthetic file ${f.name} was not recognised by any parser`);
  }
  for (const e of entities) {
    if (e.doc === false) continue;
    addDocument(db, { docType: 'entity', taxYear: null, fields: { name: e.name, type: e.type, owner: e.owner } });
  }
  if (variant.priorReturn !== false) {
    addDocument(db, { docType: 'tax_return', taxYear: TAX_YEAR - 1, fields: { ...SYNTH.prior } });
  }
  for (const d of variant.documents || []) addDocument(db, d);

  const collegeId = accountIdByMask(db, MASKS.college);
  const facts = {
    ...OWNER_FACTS,
    'accounts.va529': { [collegeId]: { virginiaPlan: true, ownerAge70Plus: false, carryforward: 0 } },
    ...(variant.facts || {}),
  };
  for (const [key, value] of Object.entries(facts)) {
    if (value === undefined) continue;
    addFact(db, key, value);
  }
  return db;
}

// ---------------------------------------------------------------- inspection helpers for tests

export const PACKS_DIR = fileURLToPath(new URL('../../packs/', import.meta.url));

export const parseJson = (s, fallback = null) => {
  if (s == null) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
};

// Temp directories and open handles, removed together (call cleanup() in an after hook).
export function scratch(prefix = 'fathom-planner-') {
  const dirs = [];
  const dbs = [];
  return {
    dir() { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; },
    track(db) { dbs.push(db); return db; },
    store(opts) { const d = this.dir(); return this.track(buildRealStore(d, opts)); },
    cleanup() {
      for (const db of dbs) { try { db.close(); } catch { /* already closed */ } }
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    },
  };
}

export function figureRow(db, key) {
  const r = db.prepare('SELECT * FROM figures WHERE key = ?').get(key);
  return r ? { ...r, locator: parseJson(r.locator, null) } : null;
}

export function plannerFigures(db) {
  return db.prepare("SELECT * FROM figures WHERE parser = 'planner' ORDER BY key").all().map(r => ({ ...r, locator: parseJson(r.locator, null) }));
}

export function factRow(db, key) {
  const r = db.prepare('SELECT * FROM facts WHERE key = ?').get(key);
  return r ? { ...r, value: parseJson(r.value, null), locator: parseJson(r.locator, null) } : null;
}

export function recRow(db, id) {
  const r = db.prepare('SELECT * FROM recs WHERE id = ?').get(id);
  return r ? { ...r, def: parseJson(r.def, {}), tasks_done: parseJson(r.tasks_done, []) } : null;
}

export function plannerRec(db, id) {
  const r = db.prepare('SELECT * FROM planner_recs WHERE rec_id = ?').get(id);
  return r ? { ...r } : null;
}

// Planner-owned recs not retired, sorted by id.
export function activeRecIds(db) {
  return db.prepare('SELECT rec_id FROM planner_recs WHERE retired_at IS NULL ORDER BY rec_id').all().map(r => r.rec_id);
}

export function recEvents(db, id) {
  return db.prepare('SELECT * FROM rec_events WHERE rec_id = ? ORDER BY id').all(id).map(r => ({ ...r }));
}

export function contentValue(db, key) {
  const r = db.prepare('SELECT value FROM content WHERE key = ?').get(key);
  return r ? parseJson(r.value, null) : undefined;
}

// Logical dump of the named tables: rows as sorted JSON strings, with `omit` columns removed.
export function dumpTables(db, tables, { omit = [] } = {}) {
  const out = {};
  for (const t of tables) {
    out[t] = db.prepare(`SELECT * FROM "${t}"`).all().map(r => {
      const row = { ...r };
      for (const c of omit) delete row[c];
      return JSON.stringify(row);
    }).sort();
  }
  return out;
}
