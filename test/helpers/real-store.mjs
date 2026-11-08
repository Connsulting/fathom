// Synthetic real-mode store for planner tests and the local real-data check. Every file goes
// through ingest's own pipeline (src/ingest/pipeline.mjs ingestFile) and the owner's answers go
// through ingest's confirm code (src/ingest/confirm.mjs answer), so planner tests see exactly the
// rows, documents and questions production stores hold (plan Revision 6, R6-1 item 9).
//
// createRealStore(dataDir, {clock})           -> Promise<db> (empty real store: mode real, clock,
//                                                onboarding done, a synthetic platform at
//                                                platformFileOf(dataDir), the store at
//                                                storeFileOf(dataDir) and its data key wrapped under
//                                                the platform key of secretsFor(dataDir))
// householdOf(db)                             -> the household context ingest ran in (its vault,
//                                                root and platform)
// addFile(db, file, {answers})                -> Promise<ingest result> (CSV and workbook files, off engine)
// addPayroll(db, entry)                       -> Promise<ingest result> (one W-2, paystub, K-1 or
//                                                form1040 as a text file read by a scripted engine)
// answerPending(db, kind, option, filter)     -> answered item ids
// addFact(db, key, value, {src, confirmed})   -> void (owner-set by default)
// buildRealStore(dataDir, {clock, variant})   -> Promise<db> with the synthetic household loaded
//
// Every name, institution and amount below is invented. Variant options are documented on
// buildRealStore.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setSetting, getSetting, parseJson as parseStored } from '../../src/store/db.mjs';
import { createInstance, PLATFORM_FILE } from '../../src/platform/db.mjs';
import { createInstanceSecrets } from '../../src/platform/secrets.mjs';
import { createHouseholdContext } from '../../src/platform/runtime.mjs';
import { ingestFile } from '../../src/ingest/pipeline.mjs';
import { answer, pendingItems } from '../../src/ingest/confirm.mjs';
import { nameKey } from '../../src/ingest/extract.mjs';
import { createEngine } from '../../src/engine/index.mjs';
import { seedHistoricalDocument } from './historical-import.mjs';
import { importProposedRows } from './import-proposal-fixture.mjs';
import { writeXlsx, XLSX_MIME } from './xlsx.mjs';
import { secretsFor, servedStore } from './server.mjs';

export const CLOCK = '2026-11-05';
export const TAX_YEAR = 2026;
export const MONTHS = 10; // P&L, HSA and charitable data cover Jan..Oct of the tax year

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

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

// The owner's answers about each account, keyed '<inst>|<mask>' (R18, S13, T8). `kind` and `owner`
// become account_kind and account_owner answers (owner null leaves the question pending); `entity`
// becomes the accounts.businessEntity owner fact. `name` is the name ingest gives the account (the
// export's account name, else institution and mask); no answer renames an account.
export const HINTS = Object.freeze({
  [`${INST.bank}|${MASKS.checking}`]: { name: `${INST.bank} ${MASKS.checking}`, kind: 'checking', owner: null },
  [`${INST.bank}|${MASKS.business}`]: { name: `${INST.bank} ${MASKS.business}`, kind: 'business', owner: null, entity: SCORP.name },
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
  // The 2025 return: federalTax is the uploaded form1040's totalTax, agi its agi; virginiaTax is the
  // owner's tax.prior.virginia answer (ingest reads no Virginia line).
  prior: Object.freeze({ federalTax: 30000, virginiaTax: 9000, agi: 240000 }),
  salaryRange: Object.freeze({ min: 50000, max: 110000 }),
  ownerAge: 45,
  spouseAge: 43,
});

// Owner answers (src 'you', confirmed 1), R6 as amended by S8/S13. accounts.va529 is filled in
// once the 529 account id is known; business.entities and accounts.businessEntity come from the
// variant's entities and hints.
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
  'household.birthYears': { owner: 1981, spouse: 1983 }, // ages 45 and 43 in the tax year
  'business.cashBasis': true,
});

// ---------------------------------------------------------------- store primitives

export const platformFileOf = (dataDir) => join(dataDir, PLATFORM_FILE);
// The original household's store file of the instance in dataDir (households/<id>/fathom.sqlite).
export const storeFileOf = async (dataDir) => (await servedStore(dataDir))?.file ?? null;

// Per-store ingest context: the household context and config ingest needs, and a file counter.
const CTX = new WeakMap();
const ctxOf = (db) => {
  const c = CTX.get(db);
  if (!c) throw new Error('not a store built by test/helpers/real-store.mjs');
  return c;
};

export async function createRealStore(dataDir, { clock = CLOCK } = {}) {
  mkdirSync(dataDir, { recursive: true });
  const keys = secretsFor(dataDir);
  // A real instance: platform.sqlite (one served real household, no accounts) and the household
  // root, so the server, the CLIs and serveAppFixture open it as a migrated real deployment. The
  // platform handle stays open for the household context ingest runs in and is closed with the
  // store by scratch().cleanup() or closeRealStore(db); callers that need accounts open
  // platformFileOf(dataDir).
  const { db, platform, householdId } = await createInstance(dataDir, {
    mode: 'real',
    platformKey: keys.platformKey,
    init: async d => {
      await setSetting(d, 'mode', 'real');
      await setSetting(d, 'clock', clock);
      await setSetting(d, 'onboarding', { done: true, step: 6 });
    },
  });
  const config = {
    dataDir, platformKeyFile: keys.platformKeyFile, mcpSecretFile: keys.mcpSecretFile,
    engine: 'off', clock, demo: false, port: 0, host: '127.0.0.1', claudeCredentialFile: null, emailTransport: 'dev',
  };
  const secrets = createInstanceSecrets({ config, mode: 'real' });
  const household = await createHouseholdContext({ householdId, mode: 'real', db, config, platform, secrets });
  CTX.set(db, { config, household, platform, seq: 0, householdId, platformFile: platformFileOf(dataDir) });
  return db;
}

// The household context of a store built here.
export const householdOf = (db) => ctxOf(db).household;

// Close a store built here and the platform handle its household context holds.
export async function closeRealStore(db) {
  const c = CTX.get(db);
  try { await db.close(); } catch { /* already closed */ }
  if (c) { try { await c.platform.close(); } catch { /* already closed */ } }
}

export const stampOf = async (db) => `${await getSetting(db, 'clock', CLOCK)}T09:00:00.000Z`;

export async function accountIdByMask(db, mask) {
  const row = await db.prepare('SELECT id FROM accounts WHERE mask = ?').get(mask);
  return row ? row.id : null;
}

export async function accountIds(db) {
  return Object.fromEntries((await db.prepare('SELECT id, mask FROM accounts WHERE mask IS NOT NULL').all()).map(r => [r.mask, r.id]));
}

const engineOf = (mode, responses = []) => {
  const inner = createEngine({ mode, responses: responses.map(rows => ({ text: JSON.stringify({ rows }) })) });
  return { mode, isOn: () => mode !== 'off', call: async req => await inner.call(req), extract: async req => inner.extract(req) };
};

// Answer every pending item of `kind` that `filter(item)` accepts; `option` is an option id or a
// function of the item returning one (null skips it). Returns the answered ids.
export async function answerPending(db, kind, option, filter = () => true) {
  const done = [];
  for (const item of await pendingItems(db)) {
    if (item.kind !== kind || !filter(item)) continue;
    const id = typeof option === 'function' ? await option(item) : option;
    if (id == null) continue;
    await answer(db, item.id, id, { now: await stampOf(db) });
    done.push(item.id);
  }
  return done;
}

// Account answers from hints ('<inst>|<mask>' -> {kind, owner}), matched by mask.
async function answerAccounts(db, hints) {
  const byMask = new Map(Object.entries(hints).map(([k, h]) => [k.split('|')[1], h]));
  const hintOf = async (accountId) => {
    const row = await db.prepare('SELECT mask FROM accounts WHERE id = ?').get(accountId);
    return row && row.mask ? byMask.get(row.mask) ?? null : null;
  };
  await answerPending(db, 'account_kind', async item => (await hintOf(item.subject))?.kind ?? null);
  await answerPending(db, 'account_owner', async item => (await hintOf(item.subject))?.owner ?? null);
}

// Ingest one CSV or workbook file through the pipeline with the off engine. answers (optional):
// {hints, taxYear: 'tax_year' | 'payment_year' | null}. Throws when ingest does not import it.
export async function addFile(db, file, { answers = {} } = {}) {
  const c = ctxOf(db);
  if (file.proposalRows) for (const row of file.proposalRows.filter(r => r.target === 'pnl')) await db.prepare('INSERT OR IGNORE INTO entity_aliases(alias,entity,created_at) VALUES (?,?,?)').run(row.fields.entity.toLowerCase().replace(/[^a-z0-9]/g, ''), row.fields.entity, await stampOf(db));
  const out = file.proposalRows
    ? await importProposedRows({ db, ...c }, file.proposalRows, { name: file.name, now: await stampOf(db) })
    : await ingestFile(db, file, { actorId: 'actor-synthetic', engine: engineOf('off'), config: c.config, household: c.household, now: await stampOf(db) });
  if (out.status !== 'imported') throw new Error(`synthetic file ${file.name} was not imported (${out.status})`);
  if (answers.hints) await answerAccounts(db, answers.hints);
  if (answers.taxYear) await answerPending(db, 'tax_year', answers.taxYear);
  return out;
}

const DOC_TAX_YEAR = (docType, fields) => (docType === 'paystub' ? Number(String(fields.payDate).slice(0, 4)) : fields.taxYear);

// One document through ingest's extraction path: a text file whose bytes are unique to this store
// and call, read by a scripted engine that classifies it as `docType` and returns `fields` (ingest's
// extraction shape, R6-0 item 1). entry: {docType, fields, recipient?, relation?, document?,
// conflict?}, each answer applied after the import when ingest asks it:
//   relation   employer_relation for this employer: 'outside' | 'household'
//   recipient  employer_recipient for this employer: 'owner' | 'spouse' | 'both'
//   document   document_recipient for this file: 'owner' | 'spouse'
//   conflict   withholding_conflict raised by this file: 'first' | 'second' | 'both', or
//              {<jurisdiction as stored>: option}
export async function addPayroll(db, entry) {
  const c = ctxOf(db);
  const { docType, fields } = entry;
  c.seq += 1;
  const out = await importProposedRows({ db, ...c }, [{ target: 'document', docType, fields }], { name: `synthetic-${docType}-${c.seq}.xlsx`, marker: `Synthetic source ${c.seq}`, now: await stampOf(db) });
  if (out.status !== 'imported') throw new Error(`synthetic ${docType} was not imported (${out.status})`);
  const employer = fields.employerName;
  const key = employer !== undefined ? nameKey(employer) : null;
  if (entry.relation && key) await answerPending(db, 'employer_relation', entry.relation, i => i.subject === key);
  if (entry.recipient && key) await answerPending(db, 'employer_recipient', entry.recipient, i => i.subject === key);
  if (entry.document) await answerPending(db, 'document_recipient', entry.document, i => String(i.subject).endsWith(`:doc:${out.fileId}`));
  if (entry.conflict) {
    const jurisdictionOf = async (item) => {
      const row = await db.prepare('SELECT jurisdiction FROM tax_payments WHERE id = ?').get(item.context.second?.id);
      return row ? row.jurisdiction : null;
    };
    await answerPending(db, 'withholding_conflict', async item => (typeof entry.conflict === 'string' ? entry.conflict : entry.conflict[await jurisdictionOf(item)] ?? null),
      item => item.fileId === out.fileId);
  }
  return out;
}

// The owner's notes file through ingest's notes path: the notes parser stores the note, and a
// scripted engine plays extract-notes, returning `extraction` ({facts: [{key, value, confidence}],
// goals: []}) in ingest's notes extraction shape (the test/ingest/confirm.test.mjs pattern). Ingest
// records each fact under src ing:notes:<scope>. Bytes are unique per store and call.
export async function addNotes(db, extraction) {
  const c = ctxOf(db);
  c.seq += 1;
  const file = {
    name: `household-notes-${c.seq}.md`, mime: 'text/markdown',
    bytes: new TextEncoder().encode(`# Household notes\n\nSynthetic owner note number ${c.seq} for a test household.\n`),
  };
  const out = await seedHistoricalDocument({ db, ...c }, file, [[{ goals: [], ...extraction }]]);
  if (out.status !== 'imported') throw new Error(`synthetic notes were not imported (${out.status})`);
  return out;
}

// Payroll entries in ingest's extraction shape. `person` becomes the employer_recipient answer and
// `relation` the employer_relation answer (leave it out for an employer that is a P&L entity, which
// ingest does not ask about). federalWithheld defaults to 0: ingest stores a federal withholding
// row whenever the field is read, and that row is what carries the recipient answer.
export const w2Doc = ({ person, relation, taxYear = TAX_YEAR, ...fields }) =>
  ({ docType: 'w2', fields: { taxYear, federalWithheld: 0, ...fields }, ...(person ? { recipient: person } : {}), ...(relation ? { relation } : {}) });
export const paystubDoc = ({ person, relation, ...fields }) =>
  ({ docType: 'paystub', fields: { federalWithholding: 0, ...fields }, ...(person ? { recipient: person } : {}), ...(relation ? { relation } : {}) });

export async function addFact(db, key, value, { src = 'you', confirmed = true, asOf = null } = {}) {
  await db.prepare(`INSERT INTO facts (key, value, src, as_of, confirmed, file_id, parser, locator, updated_at)
              VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, src = excluded.src, as_of = excluded.as_of,
                confirmed = excluded.confirmed, file_id = NULL, parser = NULL, locator = NULL, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(value), src, asOf, confirmed ? 1 : 0, new Date().toISOString());
}

export async function removeFact(db, key) {
  await db.prepare('DELETE FROM facts WHERE key = ?').run(key);
}

// The stored value of a fact, or undefined.
export async function factValue(db, key) {
  const r = await db.prepare('SELECT value FROM facts WHERE key = ?').get(key);
  return r ? parseStored(r.value, null) : undefined;
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
  const proposalRows = [];
  for (const e of entities) for (let m = 1; m <= months; m++) {
    const line = (category, amount) => ({ target: 'pnl', purpose: 'business', fields: { entity: e.name, period: `${year}-${pad(m)}`, category, amount, basis: 'cash' } });
    if (e.income) proposalRows.push(line('Income', e.income));
    for (const [category, amount] of Object.entries(e.expenses || {}).concat(extra.filter(x => x.entity === e.name).map(x => [x.category, x.monthly]))) proposalRows.push(line(category, -amount));
  }
  return { name: 'Business P&L 2026.xlsx', mime: XLSX_MIME, bytes: writeXlsx(sheets), proposalRows };
}

export function taxPaymentsWorkbook({ year = TAX_YEAR, fed = SYNTH.fedPaid, state = SYNTH.statePaid, months = SYNTH.paidMonths } = {}) {
  const rows = [[null, 'Federal', 'State'], ['Month', 'Owner Paid', 'Owner Paid']];
  MONTH_NAMES.forEach((label, i) => {
    const paid = months.includes(i + 1);
    rows.push([label, paid ? fed : null, paid ? state : null]);
  });
  const proposalRows = months.flatMap(m => [['federal', fed], ['state', state]].filter(([, amount]) => amount != null).map(([jurisdiction, amount]) => ({ target: 'tax_payment', kind: 'estimate', status: 'paid', datePrecision: 'month',
    fields: { jurisdiction, payer: 'Owner', recipient: 'you', amount, taxYear: year, taxYearBasis: 'sheet_label', paymentDate: `${year}-${pad(m)}-${lastDay(year, m)}` } })));
  return { name: 'Estimated taxes.xlsx', mime: XLSX_MIME, bytes: writeXlsx([{ name: String(year), rows }]), proposalRows };
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

// The 2025 return as ingest's form1040 extraction (agi and total tax only).
export const priorReturn = ({ agi = SYNTH.prior.agi, totalTax = SYNTH.prior.federalTax, ...rest } = {}) =>
  ({ docType: 'form1040', fields: { taxYear: TAX_YEAR - 1, agi, totalTax, ...rest } });

// variant (all optional):
//   entities:     replace ENTITIES ({name, type, owner, income, expenses, doc?: false to leave the
//                 entity out of the business.entities owner fact})
//   pnlExtra:     [{entity, category, monthly}] extra expense lines (positive amounts are expenses)
//   payroll:      extra documents through ingest, in order: [{docType, fields, recipient?,
//                 relation?, document?, conflict?}] (see addPayroll)
//   facts:        owner facts to add or override; a value of undefined leaves the fact out
//   hints:        account answers merged over HINTS ({'<inst>|<mask>': {kind, owner, entity}})
//   files:        false to leave out every default file (P&L, tax payment workbook, bank, aggregator
//                 and positions exports), for a household that only has its payroll documents
//   taxPayments:  false to leave out the tax payment workbook, or taxPaymentsWorkbook options
//   taxYear:      the tax_year answer for the workbook sheet ('tax_year' by default; null leaves
//                 it pending)
//   priorReturn:  false to leave out the 2025 form1040 and the tax.prior.virginia answer, or
//                 form1040 fields for priorReturn()
export async function buildRealStore(dataDir, { clock = CLOCK, variant = {} } = {}) {
  const db = await createRealStore(dataDir, { clock });
  const entities = variant.entities || ENTITIES;
  const businessHint = `${INST.bank}|${MASKS.business}`;
  const selectedBusiness = entities.find(e => e.type === 's_corp') || entities.find(e => e.owner === 'owner') || entities[0];
  const hints = { ...HINTS, ...(variant.entities ? { [businessHint]: { ...HINTS[businessHint], entity: selectedBusiness?.name || null } } : {}), ...(variant.hints || {}) };
  const taxYear = variant.taxYear === undefined ? 'tax_year' : variant.taxYear;
  const files = variant.files === false ? [] : [
    pnlWorkbook(entities, variant.pnlExtra || []),
    ...(variant.taxPayments === false ? [] : [taxPaymentsWorkbook(typeof variant.taxPayments === 'object' ? variant.taxPayments : {})]),
    personalCheckingCsv(),
    businessCheckingCsv(),
    aggregatorCsv(),
    positionsCsv(),
  ];
  for (const f of files) await addFile(db, f, { answers: { hints, taxYear } });
  if (variant.priorReturn !== false) await addPayroll(db, priorReturn(typeof variant.priorReturn === 'object' ? variant.priorReturn : {}));
  for (const entry of variant.payroll || []) await addPayroll(db, entry);

  const collegeId = await accountIdByMask(db, MASKS.college);
  const businessEntity = {};
  for (const [k, h] of Object.entries(hints)) {
    const id = h && h.entity ? await accountIdByMask(db, k.split('|')[1]) : null;
    if (id) businessEntity[id] = h.entity;
  }
  const listed = entities.filter(e => e.doc !== false).map(e => ({ name: e.name, type: e.type, owner: e.owner, ...(typeof e.sstb === 'boolean' ? { sstb: e.sstb } : {}) }));
  const facts = {
    ...OWNER_FACTS,
    ...(listed.length ? { 'business.entities': listed } : {}),
    ...(Object.keys(businessEntity).length ? { 'accounts.businessEntity': businessEntity } : {}),
    ...(variant.priorReturn !== false ? { 'tax.prior.virginia': SYNTH.prior.virginiaTax } : {}),
    ...(collegeId ? { 'accounts.va529': { [collegeId]: { virginiaPlan: true, carryforward: 0 } } } : {}),
    ...(variant.facts || {}),
  };
  for (const [key, value] of Object.entries(facts)) {
    if (value === undefined) continue;
    await addFact(db, key, value);
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
    async store(opts) { const d = this.dir(); return this.track(await buildRealStore(d, opts)); },
    async cleanup() {
      for (const db of dbs) await closeRealStore(db);
      for (const d of dirs) rmSync(d, { recursive: true, force: true });
    },
  };
}

export async function figureRow(db, key) {
  const r = await db.prepare('SELECT * FROM figures WHERE key = ?').get(key);
  return r ? { ...r, locator: parseJson(r.locator, null) } : null;
}

export async function plannerFigures(db) {
  return (await db.prepare("SELECT * FROM figures WHERE parser = 'planner' ORDER BY key").all()).map(r => ({ ...r, locator: parseJson(r.locator, null) }));
}

export async function factRow(db, key) {
  const r = await db.prepare('SELECT * FROM facts WHERE key = ?').get(key);
  return r ? { ...r, value: parseJson(r.value, null), locator: parseJson(r.locator, null) } : null;
}

export async function recRow(db, id) {
  const r = await db.prepare('SELECT * FROM recs WHERE id = ?').get(id);
  return r ? { ...r, def: parseJson(r.def, {}), tasks_done: parseJson(r.tasks_done, []) } : null;
}

export async function plannerRec(db, id) {
  const r = await db.prepare('SELECT * FROM planner_recs WHERE rec_id = ?').get(id);
  return r ? { ...r } : null;
}

// Planner-owned recs not retired, sorted by id.
export async function activeRecIds(db) {
  return (await db.prepare('SELECT rec_id FROM planner_recs WHERE retired_at IS NULL ORDER BY rec_id').all()).map(r => r.rec_id);
}

export async function recEvents(db, id) {
  return (await db.prepare('SELECT * FROM rec_events WHERE rec_id = ? ORDER BY id').all(id)).map(r => ({ ...r }));
}

export async function contentValue(db, key) {
  const r = await db.prepare('SELECT value FROM content WHERE key = ?').get(key);
  return r ? parseJson(r.value, null) : undefined;
}

// Logical dump of the named tables: rows as sorted JSON strings, with `omit` columns removed.
export async function dumpTables(db, tables, { omit = [] } = {}) {
  const out = {};
  for (const t of tables) {
    out[t] = (await db.prepare(`SELECT * FROM "${t}"`).all()).map(r => {
      const row = { ...r };
      for (const c of omit) delete row[c];
      return JSON.stringify(row);
    }).sort();
  }
  return out;
}
