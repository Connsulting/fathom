// Shared helpers for the ingest tests: synthetic files, temp real stores, and scripted engines.
// Every value here is synthetic. Source modules are imported lazily through src().

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes, createHash } from 'node:crypto';
import { join } from 'node:path';
import { ROOT, src, tempDb, tempDir } from './server.mjs';
import { writeXlsx } from './xlsx.mjs';

export const NOW = '2032-03-10T12:00:00.000Z';
export const enc = new TextEncoder();

export const fixturePath = (name) => join(ROOT, 'test/fixtures/ingest', name);

export function fixture(name, mime) {
  return { name, bytes: new Uint8Array(readFileSync(fixturePath(name))), ...(mime ? { mime } : {}) };
}

export const textFile = (name, text, mime) => ({ name, bytes: enc.encode(text), ...(mime ? { mime } : {}) });
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const fileIdOf = (bytes) => 'f-' + sha256(bytes).slice(0, 24);

// Aggregator-format CSV (the frozen aggregator parser's headers). Outflows are positive in the
// export; the parser flips them to negative ledger amounts.
const AGG_HEADER = 'Date,Original Date,Account Type,Account Name,Account Number,Institution Name,Name,Custom Name,Amount,Description,Category,Note,Ignored From,Tax Deductible,Transaction Tags';
export function aggregatorCsv(rows) {
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
  const lines = rows.map((r) => [r.date, '', r.type ?? 'Checking', r.account ?? 'Synthetic checking', r.number ?? '5550001111',
    r.inst ?? 'Example Bank', r.name ?? '', '', r.amount, r.description ?? 'Synthetic row', r.category ?? 'Other', '', '', '', ''].map(q).join(','));
  return [AGG_HEADER, ...lines].join('\n') + '\n';
}
export const aggregatorFile = (name, rows) => textFile(name, aggregatorCsv(rows), 'text/csv');

// P&L workbook whose expense sheet names the entity differently from its income sheet:
// income "Northwind Design", expenses for "Northwind Design" and for the alias "Northwind".
export function northwindWorkbook({ travel = 200 } = {}) {
  return writeXlsx([
    { name: 'Northwind Design Income', rows: [['Payment Date', 'Client', 'Payment Amount'], ['2032-04-05', 'Synthetic Client', 1000], ['2032-04-20', 'Synthetic Client', 500]] },
    { name: 'Northwind Design Expenses', rows: [['Date', 'Amount', 'Category'], ['2032-04-08', 25, 'Software']] },
    { name: 'Northwind Expenses', rows: [['Date', 'Amount', 'Category'], ['2032-04-03', 40, 'Software'], ['2032-04-10', 60, 'Software'], ['2032-04-12', travel, 'Travel']] },
  ]);
}
export const northwindFile = (opts, name = 'northwind-pnl.xlsx') => ({ name, bytes: new Uint8Array(northwindWorkbook(opts)) });

// Same entity as business-pnl.xlsx's Example Studio for 2032, but its expense category changed:
// importing it after business-pnl.xlsx removes the old Office supplies slot row.
export function studioRemovalFile() {
  return {
    name: 'business-pnl-recut.xlsx',
    bytes: new Uint8Array(writeXlsx([
      { name: 'Example Studio Income', rows: [['Payment Date', 'Payment Amount'], ['2032-02-10', 350.2], ['2032-02-20', 49.8]] },
      { name: 'Example Studio', rows: [['Date', 'Amount', 'Category'], ['2032-02-15', 20, 'Software']] },
    ])),
  };
}

// Bank activity CSV in the frozen bank parser's layout; the 4 digit mask comes from the file name.
// rows: [{date: 'MM/DD/YYYY', amount: '-10.00', balance: '990.00' or '', description, check?}]
export const BANK_HEADER = 'Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #';
export function activityFile(name, rows) {
  const lines = rows.map((r) => [Number(r.amount) < 0 ? 'DEBIT' : 'CREDIT', r.date, r.description ?? 'Synthetic activity', r.amount, 'OTHER', r.balance ?? '', r.check ?? ''].join(','));
  return textFile(name, [BANK_HEADER, ...lines].join('\n') + '\n', 'text/csv');
}

// Coverage workbooks (R4). P&L: entity "Example Studio" (income and expense sheets) plus
// "Example Shop" (income). variant: 'base' | 'deleteRow' (Studio Travel row gone) |
// 'emptySlot' (Studio sheets keep their headers, no data) | 'sheetGone' (Studio sheets removed) |
// 'otherYear' (Studio has only a 2031 row, Shop unchanged) | 'allEmpty' (every sheet header-only) |
// 'emptyMultiYear' (Studio header-only, Shop rows in 2031 and 2032).
export function coveragePnlFile(variant = 'base') {
  const income = ['Payment Date', 'Payment Amount'];
  const ledger = ['Date', 'Amount', 'Category'];
  const studioIncome = { name: 'Example Studio Income', rows: [income, ['2032-02-10', 400]] };
  const studioExpenses = { name: 'Example Studio Expenses', rows: [ledger, ['2032-02-09', 30, 'Software'], ['2032-03-11', 50, 'Travel']] };
  const shop = { name: 'Example Shop Income', rows: [income, ['2032-03-04', 175.25]] };
  let sheets;
  if (variant === 'base') sheets = [studioIncome, studioExpenses, shop];
  else if (variant === 'deleteRow') sheets = [studioIncome, { ...studioExpenses, rows: studioExpenses.rows.slice(0, 2) }, shop];
  else if (variant === 'emptySlot') sheets = [{ ...studioIncome, rows: [income] }, { ...studioExpenses, rows: [ledger] }, shop];
  else if (variant === 'sheetGone') sheets = [shop];
  else if (variant === 'otherYear') sheets = [{ ...studioIncome, rows: [income, ['2031-11-10', 300]] }, shop];
  else if (variant === 'allEmpty') sheets = [{ ...studioIncome, rows: [income] }, { ...studioExpenses, rows: [ledger] }, { ...shop, rows: [income] }];
  else if (variant === 'emptyMultiYear') sheets = [{ ...studioIncome, rows: [income] }, { ...studioExpenses, rows: [ledger] }, { ...shop, rows: [income, ['2031-12-04', 80], ['2032-03-04', 175.25]] }];
  else throw new TypeError(`unknown variant ${variant}`);
  return { name: `coverage-pnl-${variant}.xlsx`, bytes: new Uint8Array(writeXlsx(sheets)) };
}

// Tax workbook: sheet 2032, Federal (B, C) and State (D, E) groups, Owner and Spouse Paid columns.
// variant: 'base' | 'deleteRow' (March row gone) | 'emptySlot' (Spouse columns kept, all empty) |
// 'sheetGone' (only a 2031 sheet).
export function coverageTaxFile(variant = 'base') {
  const head = [[null, 'Federal', null, 'State'], ['Month', 'Owner Paid', 'Spouse Paid', 'Owner Paid', 'Spouse Paid']];
  const months = [['January', 100, 50, 30, 20], ['February', 110, null, 35, null], ['March', 120, 60, null, null]];
  let sheets;
  if (variant === 'base') sheets = [{ name: '2032', rows: [...head, ...months] }];
  else if (variant === 'deleteRow') sheets = [{ name: '2032', rows: [...head, ...months.slice(0, 2)] }];
  else if (variant === 'emptySlot') sheets = [{ name: '2032', rows: [...head, ...months.map(([m, fo, , so]) => [m, fo, null, so, null])] }];
  else if (variant === 'sheetGone') sheets = [{ name: '2031', rows: [...head, ['December', 90, null, 25, null]] }];
  else throw new TypeError(`unknown variant ${variant}`);
  return { name: `coverage-tax-${variant}.xlsx`, bytes: new Uint8Array(writeXlsx(sheets)) };
}

// Partly unreadable workbooks (review finding F1). P&L: Example Studio with Software 2032-02 in
// two rows (30 + 20) and Travel 2032-03 (50). variant: 'base' | 'unreadable' (second Software
// amount is a formula with no cached value, Travel amount is text) | 'travelGone' (readable,
// Travel row deleted).
export function unreadablePnlFile(variant = 'base') {
  const income = { name: 'Example Studio Income', rows: [['Payment Date', 'Payment Amount'], ['2032-02-10', 400]] };
  const head = ['Date', 'Amount', 'Category'];
  const rows = {
    base: [head, ['2032-02-09', 30, 'Software'], ['2032-02-15', 20, 'Software'], ['2032-03-11', 50, 'Travel']],
    unreadable: [head, ['2032-02-09', 30, 'Software'], ['2032-02-15', { formula: 'B2*2' }, 'Software'], ['2032-03-11', 'not a number', 'Travel']],
    travelGone: [head, ['2032-02-09', 30, 'Software'], ['2032-02-15', 20, 'Software']],
  }[variant];
  if (!rows) throw new TypeError(`unknown variant ${variant}`);
  return { name: `unreadable-pnl-${variant}.xlsx`, bytes: new Uint8Array(writeXlsx([income, { name: 'Example Studio Expenses', rows }])) };
}

// Tax: the coverage base layout. 'unreadable': March federal Owner Paid is a formula with no cached
// value and February state Owner Paid is text. 'marchGone': readable, March row deleted.
export function unreadableTaxFile(variant = 'base') {
  const head = [[null, 'Federal', null, 'State'], ['Month', 'Owner Paid', 'Spouse Paid', 'Owner Paid', 'Spouse Paid']];
  const months = {
    base: [['January', 100, 50, 30, 20], ['February', 110, null, 35, null], ['March', 120, 60, null, null]],
    unreadable: [['January', 100, 50, 30, 20], ['February', 110, null, 'n/a', null], ['March', { formula: 'B3+10' }, 60, null, null]],
    marchGone: [['January', 100, 50, 30, 20], ['February', 110, null, 35, null]],
  }[variant];
  if (!months) throw new TypeError(`unknown variant ${variant}`);
  return { name: `unreadable-tax-${variant}.xlsx`, bytes: new Uint8Array(writeXlsx([{ name: '2032', rows: [...head, ...months] }])) };
}

// Brokerage positions CSV in the frozen parser's layout, as of 2032-03-05 (from the content line).
// rows: [{symbol, description, quantity, price, value}]
const POS_HEADER = "Account number,Account name,Symbol,Description,Quantity,Last price,Last price change,Current value,Today's gain/loss dollar,Today's gain/loss percent,Total gain/loss dollar,Total gain/loss percent,Percent of account,Cost basis total,Average cost basis,Type";
export function positionsFile(name, rows, { asOf = 'Mar-05-2032' } = {}) {
  const lines = rows.map((r) => ['Z5550002222', 'Synthetic brokerage', r.symbol, r.description ?? 'Synthetic fund', r.quantity, '$' + r.price, '0', '$' + r.value, '0', '0', '0', '0', '10%', '', '', 'Cash'].join(','));
  return textFile(name, [POS_HEADER, ...lines, '', `Date downloaded ${asOf} 10:00 a.m ET`].join('\n') + '\n', 'text/csv');
}

// Text paystub with identifier-shaped numbers. Each distinct argument set gives distinct bytes.
export function paystubText({ payDate = '2032-03-15', employer = 'Example Employer LLC', gross = '5000.00' } = {}) {
  return [
    'SYNTHETIC PAYSTUB',
    `Employer: ${employer}, EIN 12-3456789`,
    'Employee SSN 123-45-6789',
    'Direct deposit to account 000123456789',
    `Pay date ${payDate}`,
    `Gross pay ${gross}`,
    'Federal withholding 700.00 State withholding 250.00',
  ].join('\n');
}

// A temp migrated store in real mode, with a data key from vault.loadDataKey and a config shaped
// like loadConfig() output. Returns { db, dataDir, config, key, keyFile, opts(engine), close() }.
export async function realStore({ engine = 'off' } = {}) {
  const { setSetting } = await src('src/store/db.mjs');
  const { loadDataKey } = await src('src/ingest/vault.mjs');
  const store = await tempDb();
  setSetting(store.db, 'mode', 'real');
  const keyDir = await tempDir('fathom-key-');
  const keyFile = join(keyDir, 'data.key');
  writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
  const config = { dataDir: store.dataDir, dataKeyFile: keyFile, engine, clock: null, demo: false, port: 0, host: '127.0.0.1', claudeCredentialFile: null, emailTransport: 'dev' };
  const key = await loadDataKey({ dataDir: store.dataDir, keyFile, mode: 'real' });
  return {
    ...store,
    config,
    key,
    keyFile,
    opts: (eng, extra = {}) => ({ engine: eng, config, now: NOW, key, ...extra }),
    close() {
      try { store.db.close(); } catch { /* already closed */ }
      rmSync(store.dataDir, { recursive: true, force: true });
      rmSync(keyDir, { recursive: true, force: true });
    },
  };
}

// Engines. Fake engines carry the runtime engine's shape: { mode, isOn(), call(), extract() }.
// `responses` are row arrays; each becomes a scripted response whose text is {"rows": [...]}.
export async function fakeEngine(responses = [], { capUsd = 200 } = {}) {
  const { createEngine } = await src('src/engine/index.mjs');
  const inner = createEngine({ mode: 'fake', capUsd, responses: responses.map((rows) => ({ text: JSON.stringify({ rows }) })) });
  return { mode: 'fake', isOn: () => true, call: (req) => inner.call(req), extract: (req) => inner.extract(req) };
}

// A fake engine that records every request it receives (extract and call), independent of the
// code under test. `sent()` returns every text block or text document it was given.
export async function recordingEngine(responses = [], opts) {
  const base = await fakeEngine(responses, opts);
  const extracts = [];
  const calls = [];
  return {
    mode: 'fake',
    isOn: () => true,
    extracts,
    calls,
    call(req) { calls.push(structuredClone(req)); return base.call(req); },
    extract(req) { extracts.push(req); return base.extract(req); },
    sent() {
      const out = [];
      for (const r of extracts) {
        if (r?.document?.type === 'text') out.push(r.document.text);
        if (typeof r?.system === 'string') out.push(r.system);
      }
      for (const r of calls) out.push(JSON.stringify(r.messages ?? []), String(r.system ?? ''));
      return out.join('\n');
    },
  };
}

export async function offEngine() {
  const { createEngine } = await src('src/engine/index.mjs');
  const inner = createEngine({ mode: 'off' });
  return { mode: 'off', isOn: () => false, call: (req) => inner.call(req), extract: (req) => inner.extract(req) };
}

export const all = (db, sql, ...args) => db.prepare(sql).all(...args).map((r) => ({ ...r }));
export const one = (db, sql, ...args) => { const r = db.prepare(sql).get(...args); return r ? { ...r } : r; };
export const count = (db, table, where = '1 = 1', ...args) => db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...args).n;
export const items = (db, kind) => all(db, 'SELECT * FROM confirm_items WHERE kind = ? ORDER BY id', kind);
export const parseJson = (s) => (s == null ? s : JSON.parse(s));

export async function ingest() { return src('src/ingest/pipeline.mjs'); }
