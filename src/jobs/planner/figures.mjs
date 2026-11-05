// Figures: every amount the planner shows, computed by deterministic code from the data and the
// merged facts, each with a kind (a actual, p projected, e estimate, m model output), a source and
// a locator (data rows, or the calculator inputs and steps). Labels carry no digits.
//
// computeFigures(data, facts, ctx) -> {figures: {key: row}, sources: {id: {label, asOf, kind}},
//   model: {salary?, deferral?}, warnings: [codes], info}
// householdTax(parts, ctx) -> re-exported from household.mjs

import { estimatedPaymentSafeHarbor, solo401kRoom, sepRoom, hsaLimit, TAX_2026 } from '../../calc/index.mjs';
import { cents } from '../../store/db.mjs';
import {
  pnlSums, ytd, dateLabel, monthLabel, cleanLabel, sum, addDays,
} from './data.mjs';
import { law, stdDeduction } from './law.mjs';
import {
  householdTax, seTaxByPerson, catchUpLimitFor, attributeContributions, payrollRecords, contributions,
  factPretax, stepsOf, planInputs, RETIREMENT_BLOCKS,
} from './household.mjs';
import { sameEmployer, docRecipient } from './payroll.mjs';
import { classifyPayments } from './payments.mjs';
import { notesFor } from './assumptions.mjs';
import { trailingCharitable } from './facts.mjs';
import { buildWargames } from './wargame.mjs';

const CASH_KINDS = ['checking', 'savings', 'cash', 'business'];
const PERSONAL_CASH = ['checking', 'savings', 'cash'];
// MG11: personal spending accounts: checking, savings, cash and personal cards (no business entity).
const SPEND_ACCOUNT = a => !a.entity && (PERSONAL_CASH.includes(a.kind) || a.kind === 'card' || /credit/i.test(a.kind ?? ''));
const PLAN_TERMS = 'plan_terms_confirmed';
// Figures the planner withholds as a group (R2-9): household tax and its targets, Virginia, solo room.
const TAX_KEYS = ['agi.est', 'tax.fed.qbi', 'tax.fed.taxable', 'tax.fed.income', 'tax.fed.se', 'tax.fed.proj', 'tax.va.proj',
  'sh.fed.required', 'sh.fed.remaining', 'sh.fed.priorTarget', 'sh.fed.priorRemaining', 'sh.fed.currentTarget',
  'sh.va.required', 'sh.va.remaining', 'va529.deduction', 'va529.deductionLeft', 'va529.taxSaved'];
const VA_KEYS = ['tax.va.proj', 'sh.va.required', 'sh.va.remaining', 'va529.deduction', 'va529.deductionLeft', 'va529.taxSaved'];
const SOLO_KEYS = ['room.solo401k', 'room.solo401k.employee', 'room.solo401k.employer', 'room.solo401k.catchUp', 'room.solo401k.rothCatchUp', 'room.solo401k.pretax'];
// Safe-harbor figures that use payments or withholding (R6-2 item 4).
const SH_FED_PAID = ['sh.fed.required', 'sh.fed.remaining', 'sh.fed.priorRemaining'];
const SH_VA_PAID = ['sh.va.required', 'sh.va.remaining'];
const IRA_ANY = a => /\bIRA\b/i.test(a.name) || a.kind === 'roth';
const IRA_PRETAX = a => /\bIRA\b/i.test(a.name) && !/roth/i.test(a.name) && a.kind !== 'roth';

export const SOURCES = Object.freeze({
  pnl: { label: 'Business profit and loss', kind: 'pnl' },
  'tax-payments': { label: 'Estimated tax payment log', kind: 'ledger' },
  'tax-withholding': { label: 'Withholding from your W-2s, paystubs and 1099s', kind: 'docs' },
  transactions: { label: 'Account transactions', kind: 'ledger' },
  docs: { label: 'Your documents', kind: 'documents' },
  'calc:tax': { label: 'Tax calculators, 2026 parameters', kind: 'calculator' },
  'calc:retirement': { label: 'Retirement room calculators', kind: 'calculator' },
  'calc:cash': { label: 'Cash model', kind: 'calculator' },
  'plan-projection': { label: 'Straight-line projection of this year', kind: 'projection' },
  'wargame-model': { label: 'War-game model: salary, tax and cash calculators', kind: 'model' },
  'calc:income': { label: 'Income received, summed from your records', kind: 'calculator' },
});

// ---------------------------------------------------------------- output helpers

export function createOut(clock) {
  const out = {
    clock, figures: {}, sources: {}, warnings: new Set(), model: {},
    info: { confirm: {}, blocked: [], calcFailed: [], withheld: {}, wargameInvalid: {} },
  };
  out.warn = code => out.warnings.add(code);
  out.source = (id, label, asOf, kind) => { out.sources[id] = { label, asOf, kind }; };
  out.put = (key, v, kind, label, src, locator, fileId = null) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    if (!out.sources[src] && SOURCES[src]) out.source(src, SOURCES[src].label, dateLabel(clock), SOURCES[src].kind);
    // MGN1: assumption codes stay; their readable sentences ride along as notes.
    const notes = notesFor(locator && locator.assumptions);
    out.figures[key] = {
      key, v: cents(v), kind, label: key.startsWith('wg.') ? label : cleanLabel(label), src, fileId,
      locator: { ...locator, ...(notes.length ? { notes } : {}), computedOn: clock },
    };
    return out.figures[key];
  };
  // A figure deliberately not produced this run, with the code that explains why (R2-9).
  out.withhold = (keys, code) => { for (const k of keys) if (!(k in out.info.withheld)) out.info.withheld[k] = code; };
  // Add confirm keys to a group without duplicates.
  out.confirm = (group, ...keys) => {
    const list = out.info.confirm[group] || (out.info.confirm[group] = []);
    for (const k of keys) if (!list.includes(k)) list.push(k);
  };
  // A calculator call that may throw on unusable inputs: warn calc_failed:<fn> and go on.
  out.safe = (fn, call) => {
    try { return call(); } catch (e) {
      if (e instanceof RangeError || e instanceof TypeError) {
        out.warn(`calc_failed:${fn}`);
        if (!out.info.calcFailed.includes(fn)) out.info.calcFailed.push(fn);
        return null;
      }
      throw e;
    }
  };
  return out;
}

export { householdTax, stepsOf };
export const rowsLoc = (table, ids, extra = {}) => ({ rows: { table, ids: ids.slice(0, 50), count: ids.length }, ...extra });

// ---------------------------------------------------------------- compute

export function computeFigures(data, facts, ctx) {
  const { clock, entities } = ctx;
  const owner = ctx.owner || {};
  const out = createOut(clock);
  const TY = data.taxYear;

  // Accounts and cash.
  const accounts = data.accounts;
  for (const a of accounts) {
    if (!a.latest) continue;
    const src = `acct:${a.id}`;
    out.source(src, `${a.name || 'Account'}${a.mask ? ` ...${a.mask}` : ''}`, dateLabel(a.latest.date), 'account');
    out.put(`bal.${a.id}`, a.latest.amount, 'a', `Balance, ${a.name || 'account'}`, src, rowsLoc(a.latest.source, a.latest.ids), a.latest.fileId);
  }
  const withBal = kinds => accounts.filter(a => a.latest && kinds.includes(a.kind));
  const cashAccts = withBal(CASH_KINDS);
  if (cashAccts.length) {
    const ids = cashAccts.flatMap(a => a.latest.ids);
    const total = sum(cashAccts.map(a => a.latest.amount));
    const biz = withBal(['business']);
    const bizTotal = sum(biz.map(a => a.latest.amount));
    out.put('cash.total', total, 'a', 'Cash across checking, savings and business accounts', 'calc:cash', rowsLoc('balances', ids));
    if (biz.length) out.put('cash.business', bizTotal, 'a', 'Business cash', 'calc:cash', rowsLoc('balances', biz.flatMap(a => a.latest.ids)));
    out.put('cash.personal', cents(total - bizTotal), 'a', 'Personal cash', 'calc:cash', rowsLoc('balances', withBal(PERSONAL_CASH).flatMap(a => a.latest.ids)));
  }
  monthlyOutflow(data, out);

  // Profit and loss per entity.
  const year = data.year;
  const pnlEntities = entities.filter(e => e.lines.length);
  const corps = [];
  for (const e of pnlEntities) {
    const s = pnlSums(e);
    const m = e.months;
    const proj = x => cents(x * 12 / m);
    e.sums = s;
    e.proj = proj;
    const loc = ids => rowsLoc('pnl_lines', ids);
    out.put(`pnl.${e.slug}.income`, s.income, 'a', `${e.name} income, year to date`, 'pnl', loc(s.ids.income), s.fileId);
    out.put(`pnl.${e.slug}.expenses`, s.expenses, 'a', `${e.name} expenses, year to date`, 'pnl', loc(s.ids.all), s.fileId);
    out.put(`pnl.${e.slug}.net`, s.net, 'a', `${e.name} net profit, year to date`, 'pnl', loc(s.ids.all), s.fileId);
    out.put(`inc.ytd.${e.slug}`, s.income, 'a', `${e.name} income received this year`, 'pnl', loc(s.ids.income), s.fileId);
    const projLoc = (what, value) => ({ calc: 'straightLineProjection', inputs: { ytd: value, months: m }, steps: [{ label: what, formula: 'year to date * twelve / months of data', value: proj(value) }] });
    out.put(`pnl.${e.slug}.netProj`, proj(s.net), 'p', `${e.name} net profit, projected for the year`, 'plan-projection', projLoc('Projected net', s.net));
    if (e.classified && e.type === 's_corp') {
      out.put(`pnl.${e.slug}.salary`, s.salary, 'a', `${e.name} officer salary, year to date`, 'pnl', loc(s.ids.salary), s.fileId);
      out.put(`pnl.${e.slug}.payrollTax`, s.payrollTax, 'a', `${e.name} employer payroll tax, year to date`, 'pnl', loc(s.ids.payrollTax), s.fileId);
      out.put(`pnl.${e.slug}.salaryProj`, proj(s.salary), 'p', `${e.name} officer salary, projected for the year`, 'plan-projection', projLoc('Projected salary', s.salary));
      corps.push({ entity: e, person: e.owner, sums: s, proj });
    }
  }
  if (pnlEntities.length) {
    const lastPeriod = data.pnl.map(l => l.period).sort().at(-1);
    out.source('pnl', SOURCES.pnl.label, `through ${monthLabel(lastPeriod)}`, SOURCES.pnl.kind);
  } else if (TY) {
    out.warn('no_pnl');
  }
  const corp = corps[0] || null;
  if (corp) {
    const s = corp.sums;
    const P = cents(corp.proj(s.net) + corp.proj(s.salary) + corp.proj(s.payrollTax));
    out.put('scorp.profitProj', P, 'p', `${corp.entity.name} profit before owner salary, projected`, 'plan-projection',
      { calc: 'straightLineProjection', inputs: { net: s.net, salary: s.salary, payrollTax: s.payrollTax, months: corp.entity.months }, steps: [{ label: 'Profit before salary', formula: 'projected net + projected salary + projected employer payroll tax', value: P }] });
    corp.P = P;
  }

  const isVa = facts['household.state'] === 'VA';

  // Transactions: giving, HSA and college savings inflows.
  const txnSource = () => {
    const last = data.transactions.map(t => t.date).sort().at(-1);
    if (last) out.source('transactions', SOURCES.transactions.label, dateLabel(last), SOURCES.transactions.kind);
  };
  const gifts = trailingCharitable(data);
  if (gifts.length) {
    txnSource();
    const trailing = cents(-sum(gifts.map(t => t.amount)));
    out.put('giving.trailing', trailing, 'a', 'Charitable giving over the last year', 'transactions', rowsLoc('transactions', gifts.map(t => t.id)));
    const ytdGifts = gifts.filter(t => ytd(data, t));
    if (ytdGifts.length) out.put('giving.ytd', cents(-sum(ytdGifts.map(t => t.amount))), 'a', 'Charitable giving this year', 'transactions', rowsLoc('transactions', ytdGifts.map(t => t.id)));
    out.put('giving.twoYear', cents(2 * trailing), 'm', 'Giving bunched into this year', 'calc:tax',
      { calc: 'givingBunch', inputs: { trailing }, steps: [{ label: 'Bunched gift', formula: 'two times the trailing year of giving', value: cents(2 * trailing) }] });
  }
  const inflows = (accts, test = () => true) => {
    const ids = new Set(accts.map(a => a.id));
    return data.transactions.filter(t => ids.has(t.account_id) && t.amount > 0 && ytd(data, t) && test(t));
  };
  const hsaAccts = accounts.filter(a => a.kind === 'hsa');
  const hsaPersonalRows = inflows(hsaAccts, t => !/payroll|employer|rollover|transfer/i.test(`${t.category ?? ''} ${t.description ?? ''}`));
  const hsaPersonal = sum(hsaPersonalRows.map(t => t.amount));
  if (hsaPersonalRows.length) {
    txnSource();
    out.put('hsa.contrib.ytd', hsaPersonal, 'a', 'Your HSA contributions this year', 'transactions', rowsLoc('transactions', hsaPersonalRows.map(t => t.id)));
  }
  const collegeAccts = accounts.filter(a => a.kind === '529' || /529/.test(a.name));
  const collegeRows = inflows(collegeAccts);
  if (collegeAccts.length) {
    // Zero when nothing went in this year, so every rec that names it resolves (F10).
    if (collegeRows.length) txnSource();
    else if (!out.sources.transactions) out.source('transactions', SOURCES.transactions.label, dateLabel(clock), SOURCES.transactions.kind);
    out.put('va529.contrib.ytd', sum(collegeRows.map(t => t.amount)), 'a', 'College 529 contributions this year', 'transactions', rowsLoc('transactions', collegeRows.map(t => t.id)));
  }

  // Pre-tax IRA balances by person (R9, S9).
  const iraAccts = accounts.filter(a => IRA_PRETAX(a) && a.latest && a.latest.amount > 0);
  for (const p of ['owner', 'spouse']) {
    const mine = iraAccts.filter(a => a.owner === p);
    if (!mine.length) continue;
    out.put(`ira.pretax.${p}`, sum(mine.map(a => a.latest.amount)), 'a', p === 'owner' ? 'Your pre-tax IRA balance' : "Your spouse's pre-tax IRA balance",
      `acct:${mine[0].id}`, rowsLoc(mine[0].latest.source, mine.flatMap(a => a.latest.ids)));
  }
  // A pre-tax IRA with no balance or position on file leaves that person's pro-rata status unknown.
  const noBalance = accounts.filter(a => IRA_PRETAX(a) && !a.latest);
  out.info.ira = {
    unknownOwner: [...iraAccts, ...noBalance].some(a => a.owner !== 'owner' && a.owner !== 'spouse'),
    owner: iraAccts.some(a => a.owner === 'owner'),
    spouse: iraAccts.some(a => a.owner === 'spouse'),
    noBalance: { owner: noBalance.some(a => a.owner === 'owner'), spouse: noBalance.some(a => a.owner === 'spouse') },
  };

  if (!TY) {
    out.warn('unsupported_tax_year');
    incomeTotal(out);
    return finish(out);
  }

  // ---------------------------------------------------------------- the tax year
  let f = facts['household.filingStatus'];
  if (!['single', 'mfj', 'mfs', 'hoh', 'qss'].includes(f)) { f = 'single'; out.warn('filing_status_assumed'); }
  const persons = f === 'mfj' || f === 'mfs' ? ['owner', 'spouse'] : ['owner'];
  const inUnit = p => persons.includes(p);

  // Tax payments (R6-2): estimates and withholding each counted once, by kind and jurisdiction.
  const pay = classifyPayments(data, { persons, f, isVa });
  for (const w of pay.warnings) out.warn(w);
  out.info.heldReasons = [];
  const holdPayment = (part, keys) => {
    if (!part.blocked) return false;
    out.withhold(keys, part.blocked);
    if (!out.info.heldReasons.includes(part.blocked)) out.info.heldReasons.push(part.blocked);
    return true;
  };
  if (pay.lastPaidDate) out.source('tax-payments', SOURCES['tax-payments'].label, `through ${monthLabel(pay.lastPaidDate.slice(0, 7))}`, SOURCES['tax-payments'].kind);
  const putPaid = (key, label, part, shKeys) => {
    if (holdPayment(part, [key, ...shKeys]) || !part.rows.length) return;
    out.put(key, part.total, 'a', label, 'tax-payments', rowsLoc('tax_payments', part.ids, { assumptions: ['paid_rows_as_estimates'] }));
  };
  putPaid('tax.fed.paid', 'Federal estimated payments logged this year', pay.fed.paid, SH_FED_PAID);
  if (isVa) putPaid('tax.va.paid', 'Virginia estimated payments logged this year', pay.va.paid, SH_VA_PAID);
  // An owner-stated withholding total replaces the rows, so their blocks do not apply to it.
  const fedWithheldFact = typeof owner['tax.withholding.federal'] === 'number';
  const vaWithheldFact = typeof owner['tax.withholding.virginia'] === 'number';
  if (!fedWithheldFact) holdPayment(pay.fed.withheld, ['tax.fed.withheld', ...SH_FED_PAID]);
  if (isVa && !vaWithheldFact) holdPayment(pay.va.withheld, ['tax.va.withheld', ...SH_VA_PAID]);

  // Payroll records per recipient, employer and year (R6-1, R6-5).
  const blocked = [];
  const payroll = payrollRecords(data, entities, owner);
  const records = payroll.records;
  out.info.payrollBlocks = payroll.blocks.map(b => ({ code: b.code, employer: b.employer }));
  out.info.ask = payroll.ask;
  for (const b of payroll.blocks) if (!b.person || inUnit(b.person)) blocked.push(b.code);
  // inc.ytd.w2 (F8): outside-employer pay received in the tax year: W-2 box 1, or the latest
  // paystub's year-to-date gross. Held while any payroll document is unresolved.
  const outsideYtd = records.filter(r => !r.household);
  const section125 = records.some(r => inUnit(r.person) && r.section125Unknown) ? ['section125_unknown'] : [];
  if (payroll.blocks.length) out.withhold(['inc.ytd.w2', 'room.hsa'], payroll.blocks[0].code);
  else if (outsideYtd.length) {
    out.source('docs', SOURCES.docs.label, dateLabel(clock), SOURCES.docs.kind);
    const label = outsideYtd.some(r => r.projected) ? 'Outside employer gross pay received this year' : 'Outside employer wages received this year';
    out.put('inc.ytd.w2', sum(outsideYtd.map(r => r.ytdWages)), 'a', label, 'docs',
      rowsLoc('documents', outsideYtd.flatMap(r => r.docIds), { assumptions: outsideYtd.some(r => r.section125Unknown) ? ['section125_unknown'] : [] }), outsideYtd[0].fileId);
  }
  const ageOf = p => {
    const v = owner[p === 'spouse' ? 'household.spouseAge' : 'household.ownerAge'];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const ageKey = p => (p === 'spouse' ? 'household.spouseAge' : 'household.ownerAge');
  const sstbOf = e => (e && typeof e.sstb === 'boolean' ? e.sstb : typeof facts['business.sstb'] === 'boolean' ? facts['business.sstb'] : (out.warn('sstb_assumed'), true));

  // Inputs (parts) and what blocks them.
  if (f === 'mfs') { blocked.push('mfs_unsupported'); out.warn('mfs_unsupported'); }
  const w2 = [];
  const biz = [];
  const bizNames = {};
  for (const c of corps) {
    if (!inUnit(c.person)) continue;
    const ownRec = records.find(r => r.corp === c.entity.slug && r.person === c.person);
    // Three wage bases per part (E1, E3, E5): `agi` is taxable wages, `gross` Medicare wages (only
    // Additional Medicare Tax and FICA or SE inputs read it) and `comp` plan compensation (IRC
    // 415(c)(3), what plan sizing and limits read). A W-2 from the corp for the year sets all three
    // from its boxes (box 1; box 5; box 1 plus elective deferrals). Only with no W-2 does the P&L
    // officer salary projection stand in: gross pay for Medicare wages and compensation, less the
    // owner's stated pretax deferrals for taxable wages (I1, below).
    c.fromPnl = !ownRec && c.sums.salary > 0;
    const salary = c.fromPnl ? c.proj(c.sums.salary) : 0;
    const gross = ownRec ? ownRec.medicare : salary;
    const comp = ownRec ? ownRec.comp : salary;
    const pretax = ownRec ? ownRec.pretax : 0;
    c.w2 = null;
    if (comp > 0 || gross > 0) {
      c.w2 = { person: c.person, src: `corp:${c.entity.slug}`, gross, comp, agi: ownRec ? ownRec.wages : salary, pretax };
      w2.push(c.w2);
    }
    const K = c.proj(c.sums.net);
    biz.push({ id: c.entity.slug, kind: 'scorp', person: c.person, agi: K, qbi: K, seInput: null, w2Wages: comp, sstb: sstbOf(c.entity) });
    c.comp = comp;
    c.gross = gross;
    c.pretax = pretax;
  }
  // Payroll records per (person, employer) (F3, G1): the corp owner's wages from a household S corp
  // with a P&L come from its officer salary above, so that W-2 is not added again; any other
  // person's W-2 from a household S corp, and any W-2 from one with no P&L, counts as that
  // person's wages.
  for (const r of records) {
    if (!inUnit(r.person)) continue;
    if (r.corp) {
      const c = corps.find(x => x.entity.slug === r.corp);
      if (c && c.person === r.person) continue;
      const own = !c && entities.some(e => e.slug === r.corp && e.owner === r.person);
      const src = own ? `corp:${r.corp}` : `corp:${r.corp}:${r.person}`;
      w2.push({ person: r.person, src, gross: r.medicare, comp: r.comp, agi: r.wages, pretax: r.pretax });
      continue;
    }
    if (r.household) continue;
    w2.push({ person: r.person, src: 'outside', gross: r.medicare, comp: r.comp, agi: r.wages });
  }
  for (const e of pnlEntities) {
    if (!e.classified) { blocked.push(`entity_unclassified:${e.slug}`); out.warn('entity_unclassified'); continue; }
    if ((e.type === 'sole_prop' || e.type === 'llc_single') && inUnit(e.owner)) {
      const S = e.proj(e.sums.net);
      biz.push({ id: e.slug, kind: 'sole', person: e.owner, agi: S, qbi: S, seInput: S, w2Wages: 0, sstb: sstbOf(e) });
      bizNames[e.slug] = e.name;
    }
  }
  // Partnerships (S1, F2, R6-1 item 4). Ingest's K-1 carries no partnership name and no person, so
  // a partnership K-1 is matched only when exactly one K-1 and exactly one classified partnership
  // exist (the partner is that entity's owner); any other count blocks k1_unmatched. A partnership
  // with no K-1 needs income.partnershipEstimate (single partnership only). An S corp K-1 repeats
  // income the S corp's P&L already carries; with no such P&L it has nowhere to go and blocks.
  const k1s = data.documents.filter(d => d.docType === 'k1' && Number(d.taxYear) === TY);
  const partnerK1s = k1s.filter(d => d.fields.entityKind === 'partnership');
  if (k1s.some(d => d.fields.entityKind === 's_corp') && !entities.some(e => e.classified && e.type === 's_corp' && e.lines.length)) blocked.push('k1_scorp_unmatched');
  const partnerships = entities.filter(e => e.classified && e.type === 'partnership');
  const k1Inputs = [];
  const missingPartners = [];
  if (partnerK1s.length) {
    if (partnerK1s.length === 1 && partnerships.length === 1) {
      const e = partnerships[0];
      k1Inputs.push({ ...partnerK1s[0].fields, id: e.slug, partnership: e.name, person: e.owner });
    } else blocked.push('k1_unmatched');
  } else {
    const est = owner['income.partnershipEstimate'];
    if (partnerships.length === 1 && est && typeof est === 'object') {
      k1Inputs.push({ ...est, selfEmploymentEarnings: est.seEarnings, id: partnerships[0].slug, partnership: partnerships[0].name, person: partnerships[0].owner });
    } else missingPartners.push(...partnerships);
  }
  for (const e of missingPartners) if (inUnit(e.owner)) blocked.push('partnership_incomplete');
  const fields = ['ordinaryIncome', 'guaranteedPayments', 'selfEmploymentEarnings'];
  const complete = k => fields.every(x => k[x] !== null && k[x] !== '' && k[x] !== undefined && Number.isFinite(Number(k[x])));
  const incompleteK1 = k1Inputs.filter(k => !complete(k));
  out.info.partnershipsMissing = [
    ...missingPartners.filter(e => inUnit(e.owner)).map(e => e.name),
    ...incompleteK1.map(k => k.partnership).filter(Boolean),
  ];
  if (blocked.includes('partnership_incomplete') || incompleteK1.length) out.warn('partnership_incomplete');
  for (const k of k1Inputs) {
    if (!complete(k)) { blocked.push('partnership_incomplete'); continue; }
    if (!inUnit(k.person)) continue;
    const ordinary = Number(k.ordinaryIncome);
    biz.push({ id: k.id, kind: 'partnership', person: k.person, agi: cents(ordinary + Number(k.guaranteedPayments)), qbi: ordinary, seInput: Number(k.selfEmploymentEarnings), w2Wages: 0, sstb: sstbOf(partnerships.find(e => e.slug === k.id)) });
    bizNames[k.id] = k.partnership;
  }

  // Retirement contributions attributed to one sponsor each (R2-2, R3-1).
  const businesses = [
    ...entities.filter(e => e.classified && e.type === 's_corp' && inUnit(e.owner)).map(e => ({ kind: 'scorp', slug: e.slug, name: e.name, person: e.owner })),
    ...biz.filter(b => b.kind !== 'scorp').map(b => ({ kind: b.kind, slug: b.id, name: bizNames[b.id] ?? null, person: b.person })),
  ];
  const attributed = attributeContributions(owner, businesses);
  if (attributed.unattributed.some(c => inUnit(c.person))) { blocked.push('retirement_contribution_unattributed'); out.warn('retirement_contribution_unattributed'); }
  // E6: an own-corp W-2 whose box 12 was not read has unknown compensation, unless the owner states
  // that sponsor's deferrals (K4: a document that carries none leaves the type to the owner's
  // answer); then compensation is box 1 plus the stated non-Roth deferrals.
  for (const r of records) {
    if (!r.household || !r.corp || r.comp != null || !inUnit(r.person)) continue;
    const stated = attributed.entries.filter(c => c.person === r.person && c.plan === 'own-corp-401k' && c.sponsor.kind === 'scorp'
      && c.sponsor.slug === r.corp && (c.type === 'deferral' || c.type === 'catchup'));
    if (!stated.length) continue;
    r.comp = cents(r.wages + sum(stated.filter(c => c.roth !== true).map(c => Number(c.amount))));
    r.deferralKnown = true;
    for (const w of w2) if (w.comp == null && w.person === r.person && (w.src === `corp:${r.corp}` || w.src === `corp:${r.corp}:${r.person}`)) w.comp = r.comp;
    for (const c of corps) if (c.entity.slug === r.corp && c.person === r.person && c.comp == null) c.comp = r.comp;
    for (const b of biz) if (b.kind === 'scorp' && b.id === r.corp && b.w2Wages == null) b.w2Wages = r.comp;
  }
  for (const c of corps) {
    if (!c.w2 || !c.fromPnl) continue;
    const pretax = Math.min(c.comp, cents(c.pretax + factPretax(attributed, { records, corps }, c.person, c.entity.slug)));
    c.w2.agi = Math.max(0, cents(c.comp - pretax));
    c.w2.pretax = pretax;
    c.pretax = pretax;
  }
  const contrib = contributions(records, corps, attributed, owner);
  for (const t of inflows(accounts.filter(IRA_ANY), t => /contribution/i.test(t.category ?? ''))) {
    const a = accounts.find(x => x.id === t.account_id);
    if (a && contrib[a.owner]) contrib[a.owner].ira = cents(contrib[a.owner].ira + t.amount);
  }

  // Virginia529 accounts (S8, T5, MG9, R2-4). An entry is complete when virginiaPlan is boolean and,
  // for a Virginia plan, ownerAge70Plus is boolean and carryforward is a number of at least zero.
  // Capped accounts deduct up to the cap; an owner seventy or older deducts in full (Va. Code
  // 58.1-322.03(7)(a), (7)(b)).
  const vaPlans = owner['accounts.va529'] && typeof owner['accounts.va529'] === 'object' ? owner['accounts.va529'] : null;
  const cap = law('va529Cap');
  const college = collegeAccts.map(a => {
    const entry = vaPlans && vaPlans[a.id] && typeof vaPlans[a.id] === 'object' ? vaPlans[a.id] : null;
    const contribYtd = sum(inflows([a]).map(t => t.amount));
    const cf = entry ? entry.carryforward : undefined;
    const completeEntry = !!entry && typeof entry.virginiaPlan === 'boolean'
      && (entry.virginiaPlan === false || (typeof entry.ownerAge70Plus === 'boolean' && typeof cf === 'number' && Number.isFinite(cf) && cf >= 0));
    const va = completeEntry && entry.virginiaPlan === true;
    const age70 = va && entry.ownerAge70Plus === true;
    const capped = va && !age70;
    const deduction = capped ? Math.min(cap, cents(contribYtd + cf)) : age70 ? cents(contribYtd + cf) : 0;
    return { account: a, entry, contribYtd, carryforward: va ? cf : null, complete: completeEntry, capped, age70, deduction };
  });
  const va529Deduction = cents(sum(college.map(c => c.deduction)));
  out.info.va529 = {
    accounts: college.length,
    missing: college.filter(c => !c.complete).map(c => c.account.name),
    age70: college.filter(c => c.age70).map(c => c.account.name),
    eligible: college.filter(c => c.capped).length,
    age70Count: college.filter(c => c.age70).length,
    deduction: va529Deduction,
  };

  const itemized = typeof owner['tax.itemizedEstimate'] === 'number' ? owner['tax.itemizedEstimate'] : 0;
  const vaItemized = typeof owner['tax.vaItemizedEstimate'] === 'number' ? owner['tax.vaItemizedEstimate'] : null;
  const vaBlocked = !isVa ? null
    : itemized > stdDeduction(f) && vaItemized == null ? 'va_itemized_missing'
      : out.info.va529.missing.length ? 'va529_answers_missing' : null;
  const ages = Array.isArray(facts['household.dependentAges']) ? facts['household.dependentAges'] : [];
  // D2: an owner-stated prior-year qualified business loss carryforward, else none (with a note).
  const qbiCarry = owner['tax.prior.qbiLossCarryforward'];
  const parts = {
    f, state: facts['household.state'] ?? null, persons, w2, biz, hsaPersonal,
    itemized, vaItemized: itemized > stdDeduction(f) ? vaItemized : null,
    va529Deduction: isVa ? va529Deduction : 0,
    children: ages.filter(a => typeof a === 'number' && a < 17).length,
    vaBlocked,
    // K2: each person's plan aggregate per sponsor; every householdTax run validates it.
    retirement: Object.fromEntries(persons.map(p => [p, {
      byPlan: contrib[p].byPlan, allRegular: contrib[p].allRegular, allCatchUp: contrib[p].allCatchUp,
      outsideKnown: contrib[p].outsideKnown, catchUpLimit: catchUpLimitFor(ageOf(p)),
    }])),
    ...(typeof qbiCarry === 'number' && Number.isFinite(qbiCarry) && qbiCarry >= 0 ? { qbiLossCarryforward: qbiCarry } : {}),
  };
  const hasIncome = biz.length > 0 || w2.length > 0;

  // Self-employment tax, computed on its own so retirement sizing never depends on the household
  // tax result (R3-6).
  const seInfo = hasIncome ? out.safe('selfEmploymentTax', () => seTaxByPerson(parts)) : null;

  out.info.blocked = [...new Set(blocked)];
  out.info.vaBlocked = vaBlocked;
  out.info.persons = persons;
  out.info.f = f;

  // MG7, C3: whose plan a solo 401(k) would be, set even when tax is blocked. One selection feeds
  // sizing, deadlines and wording: an S corp paying its owner wages, else the first person with
  // positive sole proprietor earnings. Only when neither exists does a zero-salary S corp, a sole
  // proprietorship without earnings or a partnership name the sponsor for deadlines.
  const soleByPerson = p => sum(biz.filter(b => b.kind === 'sole' && b.person === p).map(b => b.seInput));
  const soleBizOf = p => biz.filter(b => b.kind === 'sole' && b.person === p);
  const corpInUnit = corps.find(c => inUnit(c.person) && c.w2) || null;
  const solePerson = corpInUnit ? null : persons.find(p => soleByPerson(p) > 0) || null;
  const soleSized = solePerson ? soleBizOf(solePerson).find(b => b.seInput > 0) : null;
  const zeroCorp = corps.find(c => inUnit(c.person)) || null;
  const soleAny = biz.find(b => b.kind === 'sole') || null;
  const partFirst = biz.find(b => b.kind === 'partnership') || null;
  out.info.solo = corpInUnit ? { person: corpInUnit.person, kind: 'scorp', entity: corpInUnit.entity.slug }
    : soleSized ? { person: soleSized.person, kind: 'sole', entity: soleSized.id }
      : zeroCorp ? { person: zeroCorp.person, kind: 'scorp', entity: zeroCorp.entity.slug }
        : soleAny ? { person: soleAny.person, kind: 'sole', entity: soleAny.id }
          : partFirst ? { person: partFirst.person, kind: 'partnership', entity: partFirst.id } : null;

  // The current-year run (K2: it validates the retirement contributions itself; the self-employed
  // plan deduction, MG5, R2-3, R3-2, comes from that validation).
  let run = null;
  let hh = null;
  if (hasIncome && !blocked.length) {
    run = out.safe('householdTax', () => householdTax(parts));
    if (!run) out.info.blocked = ['calc_failed'];
    else {
      for (const w of run.warnings) out.warn(w);
      if (run.blocked) {
        out.info.blocked = [run.blocked];
        out.warn(run.blocked);
        if (run.blocked === 'retirement_other_deferrals_missing') out.confirm('retirement', 'retirement.otherPlanDeferrals');
      } else hh = run;
    }
  }
  // A run blocked before its retirement deduction exists leaves nothing to size from.
  const retireBlocked = !!run && (RETIREMENT_BLOCKS.has(run.blocked) || run.blocked === 'w2_plan_compensation_unknown');
  if (hh) writeTax(data, out, { hh, parts, owner, f, isVa, pay, section125 });
  out.info.taxComputed = !!hh;

  // Retirement room (R5, R6, S5, S6, MG6, R2-5, R3-3, R3-5, R3-6).
  const retireMissing = ['retirement.planTermsConfirmed', 'retirement.aggregationConfirmed'].filter(k => owner[k] !== true);
  const conf = { planConfirmed: true, aggregationConfirmed: true };
  const zeroPlan = { deferral: 0, catchUp: 0, roth: 0, employer: 0, sep: 0 };
  const planSum = list => list.reduce((acc, b) => Object.fromEntries(Object.keys(zeroPlan).map(k => [k, cents(acc[k] + (b ? b[k] : 0))])), zeroPlan);
  const sizing = hasIncome && !blocked.length && !!seInfo && !retireBlocked;
  // E5: an S corp plan sized from its W-2 says so. E6: a person whose household plan deferrals
  // (box 12) were not read has unknown plan compensation and plan aggregates; nothing is sized for
  // them, with a visible reason.
  const compCodes = corpInUnit && !corpInUnit.fromPnl ? ['w2_plan_compensation'] : [];
  const COMP_UNKNOWN = 'w2_plan_compensation_unknown';
  const compUnknown = p => records.some(r => r.person === p && r.household && !r.deferralKnown)
    || corps.some(c => c.person === p && c.w2 && c.comp == null);
  const holdComp = keys => {
    out.withhold(keys, COMP_UNKNOWN);
    if (!out.info.heldReasons.includes(COMP_UNKNOWN)) out.info.heldReasons.push(COMP_UNKNOWN);
  };
  if (sizing) {
    const soloPerson = corpInUnit ? corpInUnit.person : solePerson;
    if (soloPerson) {
      const c = contrib[soloPerson];
      const missing = [...retireMissing, ...(ageOf(soloPerson) == null ? [ageKey(soloPerson)] : []), ...(c.outsideKnown ? [] : ['retirement.otherPlanDeferrals'])];
      if (missing.length) {
        out.confirm('retirement', ...missing);
        out.withhold(SOLO_KEYS, missing[0]);
      } else if (compUnknown(soloPerson)) {
        holdComp(SOLO_KEYS);
      } else {
        const plan = corpInUnit ? planSum([c.byPlan[corpInUnit.entity.slug]]) : planSum(soleBizOf(soloPerson).map(b => c.byPlan[b.id]));
        // Self-employed compensation: net profit less the deductible half of SE tax, before plan
        // contributions (Pub 560 worksheet steps 1 to 3).
        const compensation = corpInUnit ? corpInUnit.comp
          : Math.max(0, cents(sum(soleBizOf(soloPerson).map(b => b.seInput - (seInfo.dhByBiz[b.id] || 0)))));
        soloRoomFigures(out, {
          data, owner, person: soloPerson, corp: corpInUnit, compensation, age: ageOf(soloPerson), contrib: c, plan, conf, compCodes,
        });
      }
    }
    if (!retireMissing.length) {
      // SE inputs take Medicare wages (E5).
      const wagesOf = p => sum(w2.filter(w => w.person === p).map(w => w.gross));
      // C1b, K1: SEP room shares the employer limit with every plan of the same businesses, so it
      // takes their whole aggregate: deferrals, catch-ups and employer contributions.
      const sepPersons = persons.filter(p => soleByPerson(p) > 0);
      const sepHeld = sepPersons.some(compUnknown) || (!sepPersons.length && corpInUnit && compUnknown(corpInUnit.person));
      const seps = sepHeld ? [] : sepPersons.map(p => out.safe('sepRoom', () => sepRoom({
        kind: 'self-employed', netProfit: soleByPerson(p), filingStatus: f, w2SocialSecurityWages: wagesOf(p), w2MedicareWages: wagesOf(p),
        ...planInputs(contrib[p], planSum(soleBizOf(p).map(b => contrib[p].byPlan[b.id]))), ...conf,
      }))).filter(Boolean);
      if (sepHeld) holdComp(['room.sep']);
      else if (!seps.length && corpInUnit) {
        const c = contrib[corpInUnit.person];
        const env = out.safe('sepRoom', () => sepRoom({
          kind: 'w2', compensation: corpInUnit.comp, ...planInputs(c, c.byPlan[corpInUnit.entity.slug]), ...conf,
        }));
        if (env) seps.push({ ...env, w2Comp: true });
      }
      if (seps.length) {
        out.put('room.sep', sum(seps.map(e => e.value)), 'm', 'SEP IRA room left this year', 'calc:retirement',
          { calc: 'sepRoom', inputs: seps.map(e => e.inputs), steps: seps.flatMap(e => e.steps), assumptions: [PLAN_TERMS, ...(seps.some(e => e.w2Comp) ? compCodes : [])] });
      }
    } else {
      out.confirm('retirement', ...retireMissing);
    }
    if (run) iraRoom(out, { seInfo, persons, w2, biz, retireByBiz: run.retireByBiz, contrib, ageOf, f });
  }
  if (!payroll.blocks.length) hsaRoom(out, { facts, owner, records, hsaPersonal, hsaAccts, ageOf, ageKey, inUnit });
  if (hh && isVa && hh.va != null && college.some(c => c.capped || c.age70)) va529Figures(out, { hh, parts, college });
  incomeTotal(out);

  // War games.
  if (hh) {
    // H3: an S corp with no officer salary yet but positive projected profit still gets the salary
    // war game (no current point).
    const gameCorp = corpInUnit || corps.find(c => inUnit(c.person) && c.P > 0) || null;
    out.model = buildWargames(data, out, {
      clock, f, parts, hh, corp: gameCorp, corps, entities: pnlEntities, owner, facts, contrib, ageOf, ageKey,
      retireMissing, accounts, householdTax,
      priorWages: gameCorp ? priorFicaWages(data, owner, gameCorp.person, gameCorp.entity.name) : null,
    });
  } else {
    // R3-7: with no household tax neither game can be built from current inputs.
    const code = out.info.blocked[0] || vaBlocked || 'inputs_changed';
    out.info.wargameInvalid.salary = code;
    out.info.wargameInvalid.deferral = code;
  }

  // R2-9: what this run deliberately left out, and why.
  if (out.info.blocked.length) out.withhold([...TAX_KEYS, ...persons.map(p => `room.ira.${p}`), 'room.ira.household'], out.info.blocked[0]);
  else if (vaBlocked) out.withhold(VA_KEYS, vaBlocked);
  if (!sizing && out.info.blocked.length) out.withhold([...SOLO_KEYS, 'room.sep'], out.info.blocked[0]);
  for (const k of Object.keys(out.info.withheld)) if (out.figures[k]) delete out.info.withheld[k];
  return finish(out);
}

// MG6, R2-5, R3-3, R3-5: solo 401(k) room for the sized participant. Catch-up treatment follows IRC
// 414(v)(7)(A): an S corp owner whose prior-year Social Security wages (W-2 box 3, T.D. 10033) from
// the plan sponsor exceeded the threshold may make catch-ups only as Roth, and none at all without a
// Roth feature (Treas. Reg. 1.414(v)-2(b)(2)); a sole proprietor has no wages from the sponsor.
function soloRoomFigures(out, { data, owner, person, corp, compensation, age, contrib, plan, conf, compCodes = [] }) {
  const R = TAX_2026.retirement;
  const kind = corp ? 'w2' : 'self-employed';
  const priorWages = corp ? priorFicaWages(data, owner, person, corp.entity.name) : 0;
  const base = {
    compensation, kind, age, ...planInputs(contrib, plan), ...conf,
    ...(priorWages != null ? { priorYearSponsorWages: priorWages } : {}),
  };
  const allowed = out.safe('solo401kRoom', () => solo401kRoom(base));
  if (!allowed) { out.withhold(SOLO_KEYS, 'calc_failed'); return; }
  const affected = priorWages != null && priorWages > R.rothCatchUpPriorWages;
  const rothFact = owner['retirement.planOffersRoth'];
  let mode;
  if (!(allowed.value.catchUp > 0)) mode = 'none';
  else if (priorWages == null) mode = 'unknown';
  else if (!affected) mode = 'pretax';
  else if (rothFact === true) mode = 'roth';
  else mode = rothFact === false ? 'noRoth' : 'unconfirmed';
  const env = mode === 'noRoth' || mode === 'unconfirmed' ? out.safe('solo401kRoom', () => solo401kRoom({ ...base, catchUpAllowed: false })) : allowed;
  if (!env) { out.withhold(SOLO_KEYS, 'calc_failed'); return; }
  const v = env.value;
  const steps = [...env.steps];
  if (kind === 'self-employed') steps.push({ label: 'No wages from the plan sponsor; the Roth catch-up rule does not apply', formula: 'self-employed participant', value: 0 });
  else if (priorWages != null) steps.push({ label: "Last year's Social Security wages from the plan sponsor", formula: 'prior-year W-2 Social Security wages, or your stated amount', value: priorWages });
  const loc = extra => ({ calc: 'solo401kRoom', inputs: env.inputs, steps, assumptions: [PLAN_TERMS, ...compCodes, ...extra] });
  if (mode === 'unknown') {
    // C5: until last year's sponsor wages are known the catch-up may be pre-tax, Roth or (affected,
    // with no Roth feature) not allowed at all, and a disallowed catch-up frees compensation for the
    // employer contribution. A room figure publishes only when every allowed treatment gives the same
    // value; a confirmed Roth feature rules out the disallowed case.
    const off = rothFact === true ? allowed : out.safe('solo401kRoom', () => solo401kRoom({ ...base, catchUpAllowed: false }));
    if (!off) { out.withhold(SOLO_KEYS, 'calc_failed'); return; }
    out.info.retireCatchUp = 'retirement.priorYearFicaWages';
    const pending = ['room.solo401k', 'room.solo401k.catchUp', 'room.solo401k.rothCatchUp', 'room.solo401k.pretax'];
    if (off.value.employee === v.employee) out.put('room.solo401k.employee', v.employee, 'm', 'Employee deferral room left', 'calc:retirement', loc(['roth_elective']));
    else pending.push('room.solo401k.employee');
    if (off.value.employer === v.employer) out.put('room.solo401k.employer', v.employer, 'm', 'Employer contribution room left', 'calc:retirement', loc([]));
    else pending.push('room.solo401k.employer');
    out.withhold(pending, 'retirement.priorYearFicaWages');
    return;
  }
  out.put('room.solo401k.employee', v.employee, 'm', 'Employee deferral room left', 'calc:retirement', loc(['roth_elective']));
  out.put('room.solo401k.employer', v.employer, 'm', 'Employer contribution room left', 'calc:retirement', loc([]));
  const catchPre = mode === 'pretax' || mode === 'none' ? v.catchUp : 0;
  const roth = mode === 'roth' ? v.catchUp : 0;
  const pretax = cents(v.employee + v.employer + catchPre);
  if (mode === 'pretax') out.put('room.solo401k.catchUp', v.catchUp, 'm', 'Catch-up room left', 'calc:retirement', loc([]));
  if (mode === 'roth' || mode === 'noRoth' || mode === 'unconfirmed') {
    const code = mode === 'noRoth' ? ['roth_catch_up_unavailable'] : mode === 'unconfirmed' ? ['roth_catch_up_unconfirmed'] : [];
    out.put('room.solo401k.rothCatchUp', roth, 'm', 'Catch-up room left, Roth only', 'calc:retirement', loc(code));
    if (mode === 'unconfirmed') out.info.retireCatchUp = 'retirement.planOffersRoth';
  }
  out.put('room.solo401k.pretax', pretax, 'm', 'Pre-tax retirement room left', 'calc:retirement', loc(['roth_elective']));
  out.put('room.solo401k', cents(pretax + roth), 'm', 'Solo 401(k) room left this year', 'calc:retirement', loc([]));
}

// MG6: prior-year Social Security wages (box 3) for `person` from the S corp named `corpName`. K4
// precedence (recordedTypes in household.mjs): the latest prior-year W-2 from that employer whose
// recipient is `person` (ingest's withholding rows and answers) wins, else the owner fact. Box 1 is
// never used.
export function priorFicaWages(data, owner, person, corpName) {
  const amount = v => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const docs = data.documents.filter(d => d.docType === 'w2' && Number(d.taxYear) === data.taxYear - 1
    && sameEmployer(data, d.fields.employerName, corpName) && docRecipient(data, d).person === person);
  const doc = docs.at(-1);
  const recorded = doc ? amount(doc.fields.socialSecurityWages) : null;
  if (recorded != null) return recorded;
  const fact = owner['retirement.priorYearFicaWages'];
  return amount(fact && typeof fact === 'object' ? fact[person] : undefined);
}

// inc.ytd.total (F8): every income-received figure, P&L entities plus outside wages.
function incomeTotal(out) {
  const keys = Object.keys(out.figures).filter(k => k.startsWith('inc.ytd.') && k !== 'inc.ytd.total').sort();
  if (!keys.length) return;
  const total = sum(keys.map(k => out.figures[k].v));
  out.put('inc.ytd.total', total, 'a', 'Income received this year', 'calc:income',
    { ...rowsLoc('figures', keys), calc: 'sum', inputs: Object.fromEntries(keys.map(k => [k, out.figures[k].v])), steps: [{ label: 'Income received', formula: 'sum of income received per business plus outside wages', value: total }] });
}

function finish(out) {
  return { figures: out.figures, sources: out.sources, model: out.model, warnings: [...out.warnings].sort(), info: out.info };
}

// ---------------------------------------------------------------- pieces

// MG11: spending is every outflow from a personal spending account in the last three full months;
// an outflow matched to an inflow of exactly the same cents on another household account within
// five days is one leg of a transfer and is left out (product rule).
const dayNumber = iso => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000;
const toCents = v => Math.round(Number(v) * 100);

function monthlyOutflow(data, out) {
  const spend = data.accounts.filter(SPEND_ACCOUNT);
  const ids = new Set(spend.map(a => a.id));
  const household = new Set(data.accounts.map(a => a.id));
  const clockMonth = `${data.clock.slice(0, 7)}-01`;
  const start = addDays(clockMonth, -1).slice(0, 7);
  const months = [];
  let cursor = start;
  for (let i = 0; i < 3; i++) {
    months.unshift(cursor);
    cursor = addDays(`${cursor}-01`, -1).slice(0, 7);
  }
  const ordered = [...data.transactions].sort((a, b) => String(a.date).localeCompare(String(b.date)) || (a.id ?? 0) - (b.id ?? 0));
  const candidates = ordered.filter(t => ids.has(t.account_id) && t.amount < 0 && months.includes(String(t.date).slice(0, 7)));
  const usedIds = new Set();
  const rows = [];
  let matched = 0;
  for (const t of candidates) {
    const want = -toCents(t.amount);
    const m = ordered.find(u => !usedIds.has(u) && u.account_id !== t.account_id && household.has(u.account_id)
      && toCents(u.amount) === want && Math.abs(dayNumber(u.date) - dayNumber(t.date)) <= 5);
    if (m) { usedIds.add(m); matched += 1; } else rows.push(t);
  }
  const total = -sum(rows.map(t => t.amount));
  if (!(total > 0)) return;
  const avg = cents(total / 3);
  out.put('cash.monthlyOut', avg, 'e', 'Average monthly spending from personal accounts', 'calc:cash', {
    calc: 'monthlyOutflow', ...rowsLoc('transactions', rows.map(t => t.id)),
    inputs: { months, matchedTransfers: matched, accounts: spend.map(a => a.id) },
    steps: [
      { label: 'Matched transfers excluded', formula: 'outflows matched to an equal inflow on another household account within five days', value: matched },
      { label: 'Monthly outflow', formula: 'outflows over the last three full months / three', value: avg },
    ],
  });
  const personal = out.figures['cash.personal'];
  if (personal) {
    const runway = Math.round(personal.v / avg * 10) / 10;
    out.put('cash.runwayMonths', runway, 'e', 'Months of spending covered by personal cash', 'calc:cash',
      { calc: 'runway', inputs: { personal: personal.v, monthlyOut: avg }, steps: [{ label: 'Runway', formula: 'personal cash / monthly outflow', value: runway }] });
  }
}

function writeTax(data, out, { hh, parts, owner, f, isVa, pay, section125 }) {
  // MGN1, D2, D6: per-figure assumption codes.
  const planRate = hh.retire > 0 ? ['plan_rate_max'] : [];
  const fedCodes = ['agi_as_magi_proxy', 'qbi_material_participation', ...(parts.qbiLossCarryforward == null ? ['qbi_no_prior_loss'] : []), ...planRate, ...section125];
  const vaCodes = ['va_exemptions_omitted', ...planRate];
  const summary = summarizeParts(parts, hh);
  const steps = hh.steps;
  const loc = { calc: 'householdTax', parts: summary, steps, assumptions: fedCodes };
  const vaLoc = { calc: 'householdTax', parts: summary, steps, assumptions: vaCodes };
  out.put('agi.est', hh.agi, 'e', 'Estimated adjusted gross income', 'calc:tax', loc);
  out.put('tax.fed.qbi', hh.qbi, 'm', 'Qualified business income deduction', 'calc:tax', loc);
  out.put('tax.fed.taxable', hh.taxable, 'm', 'Federal taxable income', 'calc:tax', loc);
  out.put('tax.fed.income', hh.fedIncome, 'm', 'Federal income tax before credits', 'calc:tax', loc);
  if (hh.seTotal > 0) out.put('tax.fed.se', hh.seTotal, 'm', 'Self-employment tax', 'calc:tax', loc);
  out.put('tax.fed.proj', hh.fedTotal, 'm', 'Projected federal tax for the year', 'calc:tax', loc);
  if (hh.va != null) out.put('tax.va.proj', hh.va, 'm', 'Projected Virginia tax for the year', 'calc:tax', vaLoc);

  // Withholding (R3, T2, R6-2): an owner fact replaces the rows; otherwise ingest's withholding rows,
  // each counted once. Additional Medicare Tax withheld (W-2 box 6) is not extracted, so it counts
  // as zero with a note (D11).
  const withheld = (factKey, part, extra) => {
    if (typeof owner[factKey] === 'number') return { v: owner[factKey], src: 'docs', loc: rowsLoc('facts', [factKey]) };
    if (part.blocked) return { v: 0, blocked: part.blocked };
    return { v: part.total, src: 'tax-withholding', loc: rowsLoc('tax_payments', part.ids, extra) };
  };
  const fedW = withheld('tax.withholding.federal', pay.fed.withheld, { assumptions: ['addl_medicare_withholding_not_read'] });
  const vaW = isVa ? withheld('tax.withholding.virginia', pay.va.withheld, {}) : { v: 0 };
  if ((fedW.src === 'tax-withholding' && fedW.v > 0) || (vaW.src === 'tax-withholding' && vaW.v > 0)) {
    out.source('tax-withholding', SOURCES['tax-withholding'].label, dateLabel(pay.lastWithheldDate || data.clock), SOURCES['tax-withholding'].kind);
  }
  if (!fedW.blocked && fedW.v > 0) out.put('tax.fed.withheld', fedW.v, 'a', 'Federal tax withheld from wages', fedW.src, fedW.loc);
  if (!vaW.blocked && vaW.v > 0) out.put('tax.va.withheld', vaW.v, 'a', 'Virginia tax withheld from wages', vaW.src, vaW.loc);
  if (out.figures['tax.fed.withheld'] && out.figures['tax.fed.withheld'].src === 'docs') out.source('docs', SOURCES.docs.label, dateLabel(data.clock), SOURCES.docs.kind);
  if (out.figures['tax.va.withheld'] && out.figures['tax.va.withheld'].src === 'docs') out.source('docs', SOURCES.docs.label, dateLabel(data.clock), SOURCES.docs.kind);
  // A blocked payment or withholding figure holds the safe-harbor figures that use it (already
  // withheld with its code in computeFigures).
  const fedHeld = !!(fedW.blocked || pay.fed.paid.blocked);
  const vaHeld = !!(vaW.blocked || pay.va.paid.blocked);

  // Safe harbor (MG10): IRC 6654(d)(1)(B), (C). The prior-year target is fixed by last year's
  // return; the current-year target moves with the projection, so it is an estimate.
  const E = TAX_2026.estimated;
  const prior = priorYear(data, owner);
  const fedPaid = pay.fed.paid.total;
  const totalStep = hh.steps.filter(s => /Federal total/.test(s.label));
  const currentTarget = cents(hh.fedTotal * E.currentRate);
  const currentSteps = [...totalStep, { label: 'Current-year target', formula: 'projected tax * current-year percentage', value: currentTarget }];
  out.put('sh.fed.currentTarget', currentTarget, 'e', "Federal target from this year's projection", 'calc:tax',
    { calc: 'currentYearSafeHarbor', inputs: { currentYearTax: hh.fedTotal }, steps: currentSteps, assumptions: ['projection_target'] });
  if (prior.federalTax != null && prior.agi != null) {
    const env = out.safe('estimatedPaymentSafeHarbor', () => estimatedPaymentSafeHarbor({
      currentYearTax: hh.fedTotal, priorYearTax: prior.federalTax, priorYearAgi: prior.agi, filingStatus: f,
      withholding: fedW.v, paymentsMade: fedPaid, priorReturnFullYear: true, specialRulesAbsent: true,
    }));
    if (env) {
      const high = prior.agi > (f === 'mfs' ? E.mfsHighIncomeAgi : E.highIncomeAgi);
      const priorTarget = cents(prior.federalTax * (high ? E.highIncomePriorRate : E.priorRate));
      const priorRemaining = Math.max(0, cents(priorTarget - fedW.v - fedPaid));
      const smallBalance = cents(hh.fedTotal - fedW.v) < E.smallBalance;
      const projectionBinds = currentTarget < priorTarget || smallBalance;
      const kind = projectionBinds ? 'e' : 'm';
      const priorSteps = [{ label: 'Prior-year target', formula: "last year's tax * prior-year percentage for last year's income", value: priorTarget }];
      // D10: last year's tax from the uploaded return is its total tax as filed.
      const priorCodes = ['prior_return_full_year', ...(prior.fromReturn ? ['prior_tax_total_line'] : [])];
      out.put('sh.fed.priorTarget', priorTarget, 'm', "Federal target from last year's tax", 'calc:tax',
        { calc: 'priorYearSafeHarbor', inputs: { priorYearTax: prior.federalTax, priorYearAgi: prior.agi }, steps: priorSteps, assumptions: priorCodes });
      if (!fedHeld) {
        out.put('sh.fed.priorRemaining', priorRemaining, 'm', "Federal still to pay to reach last year's target", 'calc:tax',
          { calc: 'priorYearSafeHarbor', inputs: { priorYearTax: prior.federalTax, priorYearAgi: prior.agi, withholding: fedW.v, paymentsMade: fedPaid },
            steps: [...priorSteps, { label: 'Remaining', formula: 'prior-year target - withholding - payments', value: priorRemaining }], assumptions: priorCodes });
        const l = { calc: 'estimatedPaymentSafeHarbor', inputs: env.inputs, steps: [...env.steps, ...totalStep], assumptions: [...priorCodes, ...(projectionBinds ? ['projection_target'] : [])] };
        out.put('sh.fed.required', env.value.requiredAnnualPayment, kind, 'Federal safe-harbor target for the year', 'calc:tax', l);
        out.put('sh.fed.remaining', env.value.remaining, kind, 'Federal safe harbor still to pay', 'calc:tax', l);
      }
      out.info.priorHigh = high;
      out.info.shBasis = priorTarget <= currentTarget ? 'prior' : 'current';
    }
  } else {
    out.warn('prior_year_missing');
    const required = currentTarget;
    const remaining = Math.max(0, cents(required - fedW.v - fedPaid));
    const l = { calc: 'currentYearSafeHarbor', inputs: { currentYearTax: hh.fedTotal, withholding: fedW.v, paymentsMade: fedPaid },
      steps: [...currentSteps, { label: 'Remaining', formula: 'target - withholding - payments', value: remaining }], assumptions: ['projection_target'] };
    if (!fedHeld) {
      out.put('sh.fed.required', required, 'e', 'Federal safe-harbor target for the year', 'calc:tax', l);
      out.put('sh.fed.remaining', remaining, 'e', 'Federal safe harbor still to pay', 'calc:tax', l);
    }
  }
  out.info.priorYear = prior.federalTax != null && prior.agi != null;
  if (hh.va != null && !vaHeld) {
    const vaPaid = pay.va.paid.total;
    const hasPrior = prior.virginiaTax != null;
    let required = 0;
    if (cents(hh.va - vaW.v) >= law('vaEstimateThreshold')) required = hasPrior ? cents(Math.min(0.9 * hh.va, prior.virginiaTax)) : cents(0.9 * hh.va);
    const remaining = Math.max(0, cents(required - vaW.v - vaPaid));
    const kind = hasPrior ? 'm' : 'e';
    const l = { calc: 'virginiaSafeHarbor', inputs: { currentYearTax: hh.va, priorYearTax: prior.virginiaTax ?? null, withholding: vaW.v, paymentsMade: vaPaid },
      steps: [...hh.steps.filter(s => /^Virginia/.test(s.label)), { label: 'Virginia target', formula: 'lesser of current-year percentage of projected tax and prior-year tax, zero under the threshold', value: required },
        { label: 'Remaining', formula: 'target - withholding - payments', value: remaining }], assumptions: vaCodes };
    out.put('sh.va.required', required, kind, 'Virginia safe-harbor target for the year', 'calc:tax', l);
    out.put('sh.va.remaining', remaining, kind, 'Virginia estimate still to pay', 'calc:tax', l);
  }
}

function summarizeParts(parts, hh) {
  return {
    filingStatus: parts.f, state: parts.state,
    wages: parts.w2.map(w => ({ person: w.person, source: w.src.startsWith('corp:') ? 'own S corp' : 'outside employer', gross: w.gross, agi: w.agi })),
    businesses: parts.biz.map(b => ({ id: b.id, kind: b.kind, person: b.person, income: b.agi, qbi: b.qbi, seInput: b.seInput, retire: hh.retireByBiz[b.id] || 0 })),
    hsaPersonal: parts.hsaPersonal, itemized: parts.itemized || null, va529Deduction: parts.va529Deduction, children: parts.children,
    qbiLossCarryforward: parts.qbiLossCarryforward ?? null,
  };
}

// Last year's federal tax and AGI: the owner's tax.prior.* answers win; otherwise the uploaded
// form1040 for that year (latest by id), whose total tax stands in for Form 2210 line 8 (D10).
// Ingest reads no Virginia line, so Virginia tax comes only from tax.prior.virginia.
function priorYear(data, owner) {
  const doc = data.documents.filter(d => d.docType === 'form1040' && Number(d.taxYear) === data.taxYear - 1).at(-1);
  const amount = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const fact = key => amount(owner[key]);
  const field = name => (doc ? amount(doc.fields[name]) : null);
  const federalFact = fact('tax.prior.federal');
  const federalTax = federalFact ?? field('totalTax');
  return {
    federalTax, agi: fact('tax.prior.agi') ?? field('agi'), virginiaTax: fact('tax.prior.virginia'),
    fromReturn: federalFact == null && federalTax != null,
  };
}

// IRA room (IRC 219(b)(1), (b)(5), 219(c), 219(f)(1) with 401(c)(2)): compensation is wages plus
// self-employment earnings after the deductible half of SE tax and the self-employed plan deduction.
function iraRoom(out, { seInfo, persons, w2, biz, retireByBiz, contrib, ageOf, f }) {
  const comp = p => {
    const wages = sum(w2.filter(w => w.person === p).map(w => w.agi));
    const mine = biz.filter(b => b.person === p && b.seInput != null);
    const se = sum(mine.map(b => b.seInput));
    const dh = seInfo.se[p] ? seInfo.se[p].deductibleHalf : 0;
    const retire = sum(mine.map(b => retireByBiz[b.id] || 0));
    return cents(wages + Math.max(0, se - dh - retire));
  };
  const joint = f === 'mfj' ? sum(persons.map(comp)) : null;
  const contribAll = sum(persons.map(p => contrib[p].ira));
  const rooms = {};
  const steps = [];
  for (const p of persons) {
    const age = ageOf(p);
    const limit = law('iraLimit') + (age != null && age >= 50 ? law('iraCatchUp') : 0);
    const base = joint != null ? cents(joint - contribAll) : cents(comp(p) - contrib[p].ira);
    rooms[p] = Math.max(0, cents(Math.min(limit - contrib[p].ira, base)));
    steps.push({ label: `IRA room (${p})`, formula: 'min(limit - own contributions, compensation - contributions)', value: rooms[p] });
  }
  const assumptions = persons.some(p => ageOf(p) == null) ? ['age_unknown_no_catch_up'] : [];
  const loc = { calc: 'iraRoom', inputs: { compensation: Object.fromEntries(persons.map(p => [p, comp(p)])), contributions: Object.fromEntries(persons.map(p => [p, contrib[p].ira])), filingStatus: f }, steps, assumptions };
  for (const p of persons) out.put(`room.ira.${p}`, rooms[p], 'm', p === 'owner' ? 'Your IRA room this year' : "Your spouse's IRA room this year", 'calc:retirement', loc);
  const house = Math.max(0, cents(Math.min(sum(persons.map(p => rooms[p])), joint != null ? joint - contribAll : Infinity)));
  out.put('room.ira.household', house, 'm', 'Household IRA room this year', 'calc:retirement', { ...loc, steps: [...steps, { label: 'Household IRA room', formula: 'min(sum of rooms, joint compensation - contributions)', value: house }] });
}

function hsaRoom(out, { facts, owner, records, hsaPersonal, hsaAccts, ageOf, ageKey, inUnit }) {
  if (facts['benefits.hsa'] !== true) return;
  const eligible = owner['benefits.hsaEligible'];
  if (eligible === false) return;
  const coverage = owner['benefits.hsaCoverage'];
  const holder = (hsaAccts.find(a => a.owner === 'owner' || a.owner === 'spouse') || { owner: 'owner' }).owner;
  const missing = [];
  if (eligible !== true) missing.push('benefits.hsaEligible');
  if (coverage !== 'self' && coverage !== 'family') missing.push('benefits.hsaCoverage');
  if (ageOf(holder) == null) missing.push(ageKey(holder));
  if (missing.length) { out.info.confirm.hsa = missing; return; }
  const months = typeof owner['benefits.hsaEligibleMonths'] === 'number' ? owner['benefits.hsaEligibleMonths'] : 12;
  const employer = sum(records.filter(r => inUnit(r.person)).map(r => r.hsa));
  const env = out.safe('hsaLimit', () => hsaLimit({
    coverage, age: ageOf(holder), eligibleMonths: months, eligibilityConfirmed: true, employerContributions: employer, personalContributions: hsaPersonal,
  }));
  if (env) out.put('room.hsa', env.value.remaining, 'm', 'HSA room left this year', 'calc:retirement', { calc: 'hsaLimit', inputs: env.inputs, steps: env.steps, assumptions: [PLAN_TERMS] });
}

// MG9: Va. Code 58.1-322.03(7). Capped accounts deduct up to the cap a year; an owner seventy or
// older deducts contributions plus carryforward in full, so only capped accounts have room left.
function va529Figures(out, { hh, parts, college }) {
  const cap = law('va529Cap');
  const capped = college.filter(c => c.capped);
  const age70 = college.filter(c => c.age70);
  const counted = college.filter(c => c.capped || c.age70);
  const vaCodes = ['va_exemptions_omitted'];
  const steps = counted.map((c, i) => (c.capped
    ? { label: `Account ${i + 1} deduction, capped`, formula: 'min(cap, contributions this year + carryforward)', value: c.deduction }
    : { label: `Account ${i + 1} deduction, owner seventy or older`, formula: 'contributions this year + carryforward, no cap', value: c.deduction }));
  const total = cents(sum(counted.map(c => c.deduction)));
  out.put('va529.deduction', total, 'm', 'Virginia 529 deduction this year', 'calc:tax',
    { calc: 'va529Deduction', inputs: { cap, capped: capped.length, uncapped: age70.length }, steps: [...steps, { label: 'Deduction', formula: 'sum over Virginia plan accounts', value: total }] });
  if (capped.length) {
    const left = sum(capped.map(c => Math.max(0, cents(cap - c.deduction))));
    out.put('va529.deductionLeft', left, 'm', 'Virginia 529 deduction left this year', 'calc:tax',
      { calc: 'va529Deduction', inputs: { cap, accounts: capped.length }, steps: [...steps, { label: 'Deduction left', formula: 'cap - deduction, summed over capped Virginia plan accounts', value: left }] });
  }
  const full = householdTax({ ...parts, va529Deduction: cents(capped.length * cap + sum(age70.map(c => c.deduction))) });
  const saved = cents(hh.va - full.va);
  out.put('va529.taxSaved', saved, 'm', 'Virginia tax saved by using the deduction in full', 'calc:tax', {
    calc: 'virginiaIncomeTax',
    inputs: { current: hh.vaTaxable, full: full.vaTaxable },
    steps: [...hh.steps.filter(s => /^Virginia/.test(s.label)).map(s => ({ ...s, label: `Current: ${s.label}` })),
      ...full.steps.filter(s => /^Virginia/.test(s.label)).map(s => ({ ...s, label: `Full deduction: ${s.label}` })),
      { label: 'Tax saved', formula: 'Virginia tax now - Virginia tax with the full deduction', value: saved }],
    assumptions: vaCodes,
  });
}
