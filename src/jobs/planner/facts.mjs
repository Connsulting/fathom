// Derived facts: boolean and number facts the planner reads off the data, each with the rule and
// evidence rows that support it. The planner owns a key only while no row exists, the stored row
// is its own unconfirmed one, or it is an unconfirmed import assertion; owner answers and confirmed
// facts always win. Booleans are only ever derived as true.
//
// deriveFacts(data, {entities})         -> {key: {value, rule, rows: [{table, id, fileId}]}}
// deriveFigureFacts(figs, facts)         -> the same for income.agiEstimate and the Roth candidate
// mergeFacts(stored, derived)            -> {values, writes, deletes, checks}

import { cents } from '../../store/db.mjs';
import { isCollegeAccount } from '../../shared/account-kinds.mjs';
import { isCharitable, addDays } from './data.mjs';
import { sameEmployer } from './payroll.mjs';
import { canonicalJson } from '../../ingest/confirm.mjs';
import { rothPhaseOutEnd } from './law.mjs';

export const PLANNER_SRC = 'planner';

export const PLANNER_KEYS = Object.freeze([
  'income.sCorp', 'income.selfEmployed', 'income.partnership', 'income.w2', 'accounts.has529', 'benefits.hsa',
  'retirement.ira', 'retirement.solo401k', 'giving.charitable', 'giving.annualEstimate', 'income.agiEstimate',
  'retirement.backdoorRothCandidate',
]);

const MAX_ROWS = 20;
const ev = (table, id, fileId = null) => ({ table, id, fileId });

function fact(value, rule, rows) {
  return { value, rule, rows };
}

const docYearOk = (d, year) => d.taxYear == null || Number(d.taxYear) === year;

export function trailingCharitable(data) {
  const from = addDays(data.clock, -365);
  return data.transactions.filter(t => t.date > from && t.date <= data.clock && t.amount < 0 && isCharitable(t.category));
}

export function deriveFacts(data, { entities }) {
  const out = {};
  const year = data.year;
  const entityRows = e => [...(e.docId != null ? [ev('documents', e.docId, e.fileId)] : []), ...e.lines.map(l => ev(l.sourceTable || 'pnl_lines', l.id, l.file_id))];
  const typed = types => entities.filter(e => e.classified && types.includes(e.type));
  const docs = (types, test = () => true) => data.documents.filter(d => types.includes(d.docType) && test(d));
  const householdEntity = name => entities.some(e => sameEmployer(data, e.name, name));

  const scorps = typed(['s_corp']).filter(e => e.lines.length);
  const scorpW2 = docs(['w2'], d => docYearOk(d, year) && typed(['s_corp']).some(e => sameEmployer(data, e.name, d.fields.employerName)));
  if (scorps.length || scorpW2.length) {
    out['income.sCorp'] = fact(true, scorps.length ? 's_corp entity with profit and loss lines' : 'W-2 from the household S corp',
      [...scorps.flatMap(entityRows), ...scorpW2.map(d => ev('documents', d.id, d.fileId))]);
  }

  const soles = typed(['sole_prop', 'llc_single']).filter(e => e.lines.length);
  const necs = docs(['1099-nec'], d => Number(d.taxYear) === year);
  if (soles.length || necs.length) {
    out['income.selfEmployed'] = fact(true, soles.length ? 'sole proprietor entity with profit and loss lines' : 'Form 1099-NEC for the tax year',
      [...soles.flatMap(entityRows), ...necs.map(d => ev('documents', d.id, d.fileId))]);
  }

  const partners = typed(['partnership']);
  const k1s = docs(['k1'], d => d.fields.entityKind === 'partnership');
  if (partners.length || k1s.length) {
    out['income.partnership'] = fact(true, partners.length ? 'partnership entity' : 'partnership K-1',
      [...partners.flatMap(entityRows), ...k1s.map(d => ev('documents', d.id, d.fileId))]);
  }

  const outside = docs(['w2', 'paystub'], d => docYearOk(d, year) && String(d.fields.employerName ?? '').trim() && !householdEntity(d.fields.employerName));
  if (outside.length) out['income.w2'] = fact(true, 'W-2 or paystub from an outside employer', outside.map(d => ev('documents', d.id, d.fileId)));

  const accountFact = (key, rule, test) => {
    const hits = data.accounts.filter(test);
    if (hits.length) out[key] = fact(true, rule, hits.map(a => ev('accounts', a.id, a.fileId)));
  };
  accountFact('accounts.has529', 'an account of kind 529 or named 529', isCollegeAccount);
  accountFact('benefits.hsa', 'an account of kind hsa or named HSA', a => a.kind === 'hsa' || /\bHSA\b/i.test(a.name));
  accountFact('retirement.ira', 'an account named IRA', a => /\bIRA\b/i.test(a.name));
  accountFact('retirement.solo401k', 'an account named solo or individual 401(k)', a => /solo\s*401|individual\s*401|one.participant/i.test(a.name));

  const gifts = trailingCharitable(data);
  if (gifts.length) {
    const rows = gifts.map(t => ev('transactions', t.id, t.file_id));
    const total = cents(gifts.reduce((s, t) => s - t.amount, 0));
    out['giving.charitable'] = fact(true, 'charitable outflows in the last year', rows);
    if (total > 0) out['giving.annualEstimate'] = fact(total, 'sum of charitable outflows in the last year', rows);
  }
  return out;
}

export function deriveFigureFacts(figs, facts) {
  const out = {};
  const agi = figs['agi.est'];
  if (!agi) return out;
  const rows = [ev('figures', 'agi.est')];
  out['income.agiEstimate'] = fact(agi.v, 'figure agi.est', rows);
  const f = facts['household.filingStatus'] || 'single';
  if (agi.v > rothPhaseOutEnd(f)) out['retirement.backdoorRothCandidate'] = fact(true, 'estimated AGI above the Roth IRA phase-out (AGI as the MAGI proxy)', rows);
  return out;
}

// D13: the planner may write a key when no row exists, the stored row is its own unconfirmed one, or
// the key is one it derives (PLANNER_KEYS) and the stored row is an unconfirmed document or parser
// assertion (src ing:<parser>:<scope>, not ing:notes:). A fact from the owner's notes is never
// overwritten; a derived value that disagrees with it becomes a check (ingest's fact_check
// question). It deletes only its own rows.
const plannerOwned = row => row && row.src === PLANNER_SRC && !row.confirmed;
const srcOf = row => String((row && row.src) ?? '');
const fromNotes = row => !!row && !row.confirmed && srcOf(row).startsWith('ing:notes:');
const plannerWritable = (key, row) => !row || plannerOwned(row)
  || (PLANNER_KEYS.includes(key) && !row.confirmed && srcOf(row).startsWith('ing:') && !srcOf(row).startsWith('ing:notes:'));

// mergeFacts(stored, derived, {keep}) -> {values, writes, deletes, checks}; checks: [{key, value,
// rule, rows, stored}] derived values that disagree with an owner's notes fact.
export function mergeFacts(stored, derived, { keep = [] } = {}) {
  const values = {};
  for (const [k, r] of Object.entries(stored)) values[k] = r.value;
  const writes = [];
  const deletes = [];
  const checks = [];
  for (const [key, d] of Object.entries(derived)) {
    const row = stored[key];
    if (PLANNER_KEYS.includes(key) && fromNotes(row)) {
      if (canonicalJson(row.value) !== canonicalJson(d.value)) checks.push({ key, ...d, stored: row.value });
      continue;
    }
    if (!plannerWritable(key, row)) continue;
    values[key] = d.value;
    writes.push({ key, ...d });
  }
  for (const key of PLANNER_KEYS) {
    if (plannerOwned(stored[key]) && !(key in derived) && !keep.includes(key)) {
      delete values[key];
      deletes.push(key);
    }
  }
  return { values, writes, deletes, checks };
}

// Provenance for a derived fact (the first evidence row's file, at most MAX_ROWS rows).
export function factProvenance(d) {
  const rows = d.rows.slice(0, MAX_ROWS).map(r => ({ table: r.table, id: r.id }));
  return { fileId: d.rows[0] ? d.rows[0].fileId ?? null : null, parser: PLANNER_SRC, locator: { rule: d.rule, rows, count: d.rows.length } };
}

// Owner-set facts (src not planner): the only source of calculator confirmations (R6).
export function ownerFactsOf(stored) {
  const out = {};
  for (const [k, r] of Object.entries(stored)) if (r.src !== PLANNER_SRC) out[k] = r.value;
  return out;
}

