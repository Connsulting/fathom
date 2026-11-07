// Year end: the expected tax documents for a tax year, derived deterministically from stored facts,
// accounts, ledger activity and documents; the received documents matched onto them; the owner's
// "not needed this year" marks; and the year-end decisions from the plan. Pure reads except
// setMark and recordPacket. See docs/architecture.md, Year end.

import { getFacts } from '../store/facts.mjs';
import { parseJson } from '../store/db.mjs';
import { normalizeName } from '../ingest/confirm.mjs';
import { accountLabel } from '../shared/account-label.mjs';
import { accountNaming } from '../accounts/naming.mjs';

// Document types that are tax forms a preparer needs. Paystubs, statements, notes, plan summaries
// and account metadata feed the ledger and are not packet documents.
export const RECEIVABLE = Object.freeze(['w2', '1099-int', '1099-div', '1099-b', '1099-nec', '1099-misc', '1099-k', '1099-r', '1099-sa',
  '1098', '5498', '5498-sa', 'k1', 'payroll', '1120s', 'other']);

const FORM_LABEL = {
  w2: 'W-2', '1099-int': '1099-INT', '1099-div': '1099-DIV', '1099-b': '1099-B', '1099-nec': '1099-NEC', '1099-misc': '1099-MISC',
  '1099-k': '1099-K', '1099-r': '1099-R', '1099-sa': '1099-SA', 1098: '1098', 5498: '5498', '5498-sa': '5498-SA', k1: 'K-1',
  payroll: 'Payroll report', '1120s': '1120-S data', other: 'Document',
};
export const formLabel = (t) => FORM_LABEL[t] || 'Document';

// The tax year being prepared on a clock date: the prior year through April 15, else this year.
export function taxYearFor(clock) {
  const y = Number(String(clock).slice(0, 4));
  return String(clock).slice(5) <= '04-15' ? y - 1 : y;
}

const BANK = ['checking', 'cash'];
const IRA = (a) => (a.kind === 'roth' || a.kind === 'retirement') && /\bira\b/i.test(`${a.name || ''}`) && !/401|403|457/.test(a.name || '');

function activeAccounts(db, year) {
  const from = `${year}-01-01`, to = `${year}-12-31`;
  const has = (table, col) => new Set(db.prepare(`SELECT DISTINCT account_id AS id FROM ${table} WHERE ${col} BETWEEN ? AND ?`).all(from, to).map((r) => r.id));
  const txn = has('transactions', 'date'), bal = has('balances', 'date'), pos = has('positions', 'as_of');
  const deposits = new Set(db.prepare('SELECT DISTINCT account_id AS id FROM transactions WHERE date BETWEEN ? AND ? AND amount > 0').all(from, to).map((r) => r.id));
  return { active: (id) => txn.has(id) || bal.has(id) || pos.has(id), deposits: (id) => deposits.has(id) };
}

function yearDocuments(db, year) {
  return db.prepare(`SELECT d.id, d.doc_type, d.tax_year, d.fields, d.file_id, f.name AS file_name, f.uploaded_at, f.stored_path, f.mime, f.parser AS file_parser
                     FROM documents d LEFT JOIN files f ON f.id = d.file_id WHERE d.tax_year = ? ORDER BY d.id`).all(year)
    .map((r) => ({ ...r, fields: parseJson(r.fields, {}) }));
}

// The name on a document that identifies who issued it: employer for W-2s and paystubs, payer for
// 1099s, issuer or institution otherwise.
export const issuerOf = (fields) => String(fields?.employerName || fields?.payerName || fields?.issuer || fields?.institution || fields?.entityName || '').trim();

// Employers for the year: every paystub and W-2 employer name, keyed by its normalized name.
function employers(docs) {
  const out = new Map();
  for (const d of docs) {
    if (d.doc_type !== 'paystub' && d.doc_type !== 'w2') continue;
    const name = String(d.fields.employerName || '').trim();
    const k = normalizeName(name);
    if (k && !out.has(k)) out.set(k, name);
  }
  return out;
}

const ARRIVES = {
  jan31: { note: 'By January 31', due: (y) => `${y + 1}-01-31` },
  feb15: { note: 'Mid February; corrected forms can follow into March', due: (y) => `${y + 1}-02-15` },
  feb28: { note: 'By the end of February', due: (y) => `${y + 1}-02-28` },
  mar15: { note: 'March, often later than promised', due: (y) => `${y + 1}-03-15` },
  may31: { note: 'By May 31, after filing; contribution records stand in until then', due: (y) => `${y + 1}-05-31` },
  close: { note: 'After December closes, by early February', due: (y) => `${y + 1}-02-10` },
};

// The expected items for the year, before matching. Each: {key, form, t, src, arrives, forms
// (document types that satisfy it), name (normalized issuer to prefer), why}.
export function expectedItems({ facts, accounts, year, active, deposits, employerNames = new Map(), mortgagePaid = false, pnlEntities = [] }) {
  const items = [];
  const add = (it) => items.push({ forms: [it.form], name: '', ...it });
  if (facts['income.w2'] === true) {
    if (employerNames.size) {
      for (const [k, name] of employerNames) add({ key: `w2:${k}`, form: 'w2', t: `W-2 from ${name}`, src: `${name} payroll`, arrives: 'jan31', name: k, why: 'Paystubs from this employer this year' });
    } else {
      add({ key: 'w2:any', form: 'w2', t: 'W-2 from each employer', src: 'Each employer’s payroll', arrives: 'jan31', why: 'You have W-2 income' });
    }
  }
  for (const a of accounts) {
    if (!active(a.id)) continue;
    const label = accountLabel(a);
    // Which documents are required follows the imported name, not the owner's display name.
    const imported = `${a.name || ''}`;
    const inst = normalizeName(a.inst);
    if (a.kind === 'taxable') {
      add({ key: `1099-composite:${a.id}`, form: '1099-b', forms: ['1099-b', '1099-div', '1099-int'], t: `Composite 1099 (B, DIV, INT) for ${label}`, src: `${a.inst || 'The brokerage'} tax center`, arrives: 'feb15', name: inst, why: 'Brokerage account with activity this year', account: a.id });
    } else if (BANK.includes(a.kind) || (a.kind === 'business' && !/payroll/i.test(imported))) {
      add({ key: `1099-int:${a.id}`, form: '1099-int', t: `1099-INT for ${label}`, src: `${a.inst || 'The bank'}; only issued above the IRS interest reporting threshold`, arrives: 'jan31', name: inst, why: 'Bank account with activity this year', account: a.id });
    } else if (a.kind === 'loan' && /mortgage|home/i.test(imported)) {
      add({ key: `1098:${a.id}`, form: '1098', t: `1098 mortgage interest for ${label}`, src: `${a.inst || 'The mortgage servicer'}`, arrives: 'jan31', name: inst, why: 'Mortgage account', account: a.id });
    } else if (IRA(a) && deposits(a.id)) {
      add({ key: `5498:${a.id}`, form: '5498', t: `5498 for ${label}`, src: `${a.inst || 'The IRA custodian'}`, arrives: 'may31', name: inst, why: 'IRA contributions this year', account: a.id });
    }
  }
  if (mortgagePaid && !items.some((i) => i.form === '1098')) {
    add({ key: '1098:mortgage', form: '1098', t: '1098 mortgage interest', src: 'Your mortgage servicer', arrives: 'jan31', why: 'Mortgage payments in your ledger this year' });
  }
  if (facts['retirement.ira'] === true && !items.some((i) => i.form === '5498')) {
    add({ key: '5498:ira', form: '5498', t: '5498 for IRA contributions', src: 'Each IRA custodian', arrives: 'may31', why: 'You hold IRAs' });
  }
  if (facts['income.partnership'] === true) {
    add({ key: 'k1:partnership', form: 'k1', t: 'K-1 from each partnership', src: 'The partnership’s preparer', arrives: 'mar15', why: 'You have partnership income' });
  }
  if (facts['income.selfEmployed'] === true) {
    add({ key: '1099-nec', form: '1099-nec', forms: ['1099-nec', '1099-misc'], t: '1099-NEC from clients', src: 'Each client that paid you above the 1099-NEC reporting threshold', arrives: 'jan31', why: 'You have self-employment income' });
    add({ key: '1099-k', form: '1099-k', t: '1099-K from payment processors', src: 'Each card or payment platform that paid you', arrives: 'jan31', why: 'You have self-employment income' });
  }
  if (facts['benefits.hsa'] === true || accounts.some((a) => a.kind === 'hsa')) {
    const hsa = accounts.find((a) => a.kind === 'hsa');
    const src = hsa?.inst || 'Your HSA custodian';
    add({ key: 'hsa:1099-sa', form: '1099-sa', t: '1099-SA for HSA distributions', src: `${src}; only issued when you took distributions`, arrives: 'jan31', name: normalizeName(hsa?.inst), why: 'You have an HSA' });
    add({ key: 'hsa:5498-sa', form: '5498-sa', t: '5498-SA for HSA contributions', src, arrives: 'may31', name: normalizeName(hsa?.inst), why: 'You have an HSA' });
  }
  if (facts['income.sCorp'] === true) {
    add({ key: 'scorp:payroll', form: 'payroll', t: 'S corp year-end payroll reports (W-3, Q4 941, 940)', src: 'Your payroll provider', arrives: 'jan31', why: 'You own an S corp' });
    add({ key: 'scorp:1120s', form: '1120s', t: '1120-S prep data (balance sheet, fixed assets, shareholder basis)', src: 'Your books', arrives: 'feb28', why: 'You own an S corp' });
  }
  const entities = pnlEntities.length ? pnlEntities : facts['income.sCorp'] === true ? [''] : [];
  for (const e of entities) {
    add({ key: `pnl:${normalizeName(e) || 'business'}`, form: 'pnl', forms: [], t: `Profit and loss for ${e || 'the business'}, full year`, src: 'Your books', arrives: 'close', why: 'Business ledger lines this year', entity: e });
  }
  return items;
}

// Match each received document to at most one expected item: an item with the same form whose
// preferred issuer name appears in the document's issuer, else the only item of that form.
export function matchDocuments(items, docs) {
  const matched = new Map(items.map((i) => [i.key, []]));
  const unmatched = [];
  for (const d of docs) {
    const cands = items.filter((i) => i.forms.includes(d.doc_type));
    const issuer = normalizeName(issuerOf(d.fields));
    let hit = issuer ? cands.find((i) => i.name && (issuer.includes(i.name) || i.name.includes(issuer))) : null;
    if (!hit) {
      const open = cands.filter((i) => !i.name);
      hit = cands.length === 1 ? cands[0] : open.length === 1 ? open[0] : null;
    }
    if (hit) matched.get(hit.key).push(d);
    else unmatched.push(d);
  }
  return { matched, unmatched };
}

export function loadMarks(db, year) {
  return new Map(db.prepare('SELECT item_key, reason, marked_at FROM yearend_marks WHERE tax_year = ?').all(year).map((r) => [r.item_key, r]));
}

// Mark an expected item not needed this year (reason required), or clear the mark (reason null).
export function setMark(db, { year, key, reason, now = new Date().toISOString() }) {
  if (reason == null) {
    db.prepare('DELETE FROM yearend_marks WHERE tax_year = ? AND item_key = ?').run(year, key);
    return { cleared: true };
  }
  db.prepare(`INSERT INTO yearend_marks (tax_year, item_key, reason, marked_at) VALUES (?, ?, ?, ?)
              ON CONFLICT(tax_year, item_key) DO UPDATE SET reason = excluded.reason, marked_at = excluded.marked_at`).run(year, key, reason, now);
  return { marked: true };
}

const fileOut = (d) => ({ id: d.file_id, name: d.file_name || 'Unnamed file', date: String(d.uploaded_at || '').slice(0, 10), docId: d.id, form: d.doc_type, issuer: issuerOf(d.fields) });

// P&L coverage per entity for the year: the latest month and the newest source file.
function pnlCoverage(db, year) {
  return db.prepare(`SELECT p.entity, max(p.period) AS through, count(DISTINCT p.period) AS months,
                       (SELECT p2.file_id FROM pnl_lines p2 WHERE p2.entity = p.entity AND substr(p2.period, 1, 4) = ? ORDER BY p2.period DESC, p2.id DESC LIMIT 1) AS file_id
                     FROM pnl_lines p WHERE substr(p.period, 1, 4) = ? GROUP BY p.entity ORDER BY p.entity`).all(String(year), String(year));
}

// The full checklist for a tax year: {year, items, unmatched}. Item status: have (a matched
// document, or for a P&L all twelve months stored), skipped (marked not needed), missing (past its
// usual arrival date on the clock), else expected.
// `plain` resolves demo tokens in seeded account text to plain text (imported text is left as is).
export function yearendChecklist(db, { year, clock, plain = (s) => s }) {
  const facts = getFacts(db);
  const householdNames = facts['household.names'] && typeof facts['household.names'] === 'object' ? facts['household.names'] : {};
  const holders = new Map(db.prepare('SELECT account_id, holder FROM account_holders').all().map((r) => [r.account_id, r.holder]));
  const hints = accountNaming(db);
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY sort, id').all()
    .map((a) => (a.parser === 'demo-seed' ? { ...a, inst: plain(a.inst || ''), name: plain(a.name || ''), owner: plain(a.owner || '') } : a))
    .map((a) => {
      const hint = hints.hint(a.id);
      // The owner prefix of a demo account is a name token; the rest of the row is already plain.
      return { ...a, householdNames, holder: holders.get(a.id) || null, ...hint, ...(a.parser === 'demo-seed' ? { labelPrefix: plain(hint.labelPrefix ?? '') } : {}) };
    });
  const { active, deposits } = activeAccounts(db, year);
  const all = yearDocuments(db, year);
  const docs = all.filter((d) => RECEIVABLE.includes(d.doc_type) && d.file_id);
  const mortgagePaid = !!db.prepare("SELECT 1 FROM transactions WHERE date BETWEEN ? AND ? AND (lower(description) LIKE '%mortgage%' OR category = 'mortgage') LIMIT 1")
    .get(`${year}-01-01`, `${year}-12-31`);
  const pnl = pnlCoverage(db, year);
  const items = expectedItems({ facts, accounts, year, active, deposits, employerNames: employers(all), mortgagePaid, pnlEntities: pnl.map((p) => p.entity) });
  const { matched, unmatched } = matchDocuments(items, docs);
  const marks = loadMarks(db, year);
  const fileName = (id) => db.prepare('SELECT name, uploaded_at FROM files WHERE id = ?').get(id);
  const out = items.map((i) => {
    const arrives = ARRIVES[i.arrives];
    const files = matched.get(i.key).map(fileOut);
    let status;
    let note = arrives.note;
    if (i.form === 'pnl') {
      const p = pnl.find((x) => x.entity === i.entity);
      if (p && p.file_id) {
        const f = fileName(p.file_id);
        if (p.through === `${year}-12` && p.months === 12) files.push({ id: p.file_id, name: f?.name || 'Ledger', date: String(f?.uploaded_at || '').slice(0, 10), pnl: true });
        else note = `Stored through ${p.through}. ${arrives.note}`;
      }
    }
    const mark = marks.get(i.key);
    if (files.length) status = 'have';
    else if (mark) status = 'skipped';
    else status = clock > arrives.due(year) ? 'missing' : 'expected';
    const item = { key: i.key, form: i.form, t: i.t, status, src: i.src, note, due: arrives.due(year), why: i.why, files };
    if (mark) item.skip = { reason: mark.reason, at: mark.marked_at };
    return item;
  });
  return { year, items: out, unmatched: unmatched.map((d) => ({ ...fileOut(d), t: `${formLabel(d.doc_type)}${issuerOf(d.fields) ? ` from ${issuerOf(d.fields)}` : ''}` })) };
}

// Year-end decisions: every open or decided decision, upcoming ones that open by December 31, and
// every visible rec whose window closes in the tax year or that is tied to filing (its window
// label or title names filing). A rec a listed decision already points to is not listed twice.
export function yearendDecisions({ year, recs, decisions, recRows, opensOn = new Map() }) {
  const end = `${year}-12-31`;
  const out = [];
  const seen = new Set();
  for (const d of decisions) {
    if (d.status === 'unavailable') continue;
    const opensBy = d.status !== 'upcoming' || (opensOn.get(d.id) && opensOn.get(d.id) <= end);
    if (!opensBy) continue;
    if (d.recId) seen.add(d.recId);
    out.push({ kind: 'decision', id: d.id, t: d.title, status: d.status, done: d.status === 'decided', when: d.when || '', recId: d.recId || null });
  }
  const closeOf = new Map(recRows.map((r) => [r.id, r.window_close]));
  for (const r of recs) {
    if (seen.has(r.id) || ['hidden', 'dismissed'].includes(r.status)) continue;
    const close = closeOf.get(r.id);
    const inYear = close && close >= `${year}-01-01` && close <= end;
    const filing = /filing/i.test(`${r.window?.label || ''} ${r.title || ''}`);
    if (!inYear && !filing) continue;
    out.push({ kind: 'rec', id: r.id, t: r.title, status: r.status, done: r.status === 'done', when: r.window?.label || '' });
  }
  return out;
}

export function loadPackets(db, year) {
  return db.prepare('SELECT id, generated_at, counts, bytes FROM yearend_packets WHERE tax_year = ? ORDER BY id DESC LIMIT 10').all(year)
    .map((r) => ({ id: r.id, at: r.generated_at, counts: parseJson(r.counts, {}), bytes: r.bytes }));
}

export function recordPacket(db, { year, counts, bytes, now = new Date().toISOString() }) {
  return Number(db.prepare('INSERT INTO yearend_packets (tax_year, generated_at, counts, bytes) VALUES (?, ?, ?, ?)')
    .run(year, now, JSON.stringify(counts), bytes).lastInsertRowid);
}

// The scenario's yearend section.
export function buildYearend(db, { clock, recs, decisions, plain }) {
  const year = taxYearFor(clock);
  const { items, unmatched } = yearendChecklist(db, { year, clock, plain });
  const recRows = db.prepare('SELECT id, window_close FROM recs').all();
  const opensOn = new Map(db.prepare('SELECT id, opens_on FROM decisions').all().map((r) => [r.id, r.opens_on]));
  const decs = yearendDecisions({ year, recs, decisions, recRows, opensOn });
  return { year, docs: items, unmatched, decisions: decs, packets: loadPackets(db, year) };
}
