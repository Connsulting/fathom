// Figures: every amount the planner shows, computed by deterministic code from the data and the
// merged facts, each with a kind (a actual, p projected, e estimate, m model output), a source and
// a locator (data rows, or the calculator inputs and steps). Labels carry no digits.
//
// computeFigures(data, facts, ctx) -> {figures: {key: row}, sources: {id: {label, asOf, kind}},
//   model: {salary?, deferral?}, warnings: [codes], info}
// householdTax(parts, ctx) -> re-exported from household.mjs

import { estimatedPaymentSafeHarbor, solo401kRoom, sepRoom, hsaLimit } from '../../calc/index.mjs';
import { cents } from '../../store/db.mjs';
import {
  pnlSums, ytd, dateLabel, monthLabel, cleanLabel, sum, addDays,
} from './data.mjs';
import { law, stdDeduction } from './law.mjs';
import { householdTax, payrollRecords, contributions, stepsOf, num } from './household.mjs';
import { trailingCharitable } from './facts.mjs';
import { buildWargames } from './wargame.mjs';

export const ASSUMES_CONFIRMED = 'assumes plan terms and eligibility are confirmed with your advisor';
const CASH_KINDS = ['checking', 'savings', 'cash', 'business'];
const PERSONAL_CASH = ['checking', 'savings', 'cash'];
const IRA_PRETAX = a => /\bIRA\b/i.test(a.name) && !/roth/i.test(a.name);

export const SOURCES = Object.freeze({
  pnl: { label: 'Business profit and loss', kind: 'pnl' },
  'tax-payments': { label: 'Estimated tax payment log', kind: 'ledger' },
  transactions: { label: 'Account transactions', kind: 'ledger' },
  docs: { label: 'Your documents', kind: 'documents' },
  'calc:tax': { label: 'Tax calculators, 2026 parameters', kind: 'calculator' },
  'calc:retirement': { label: 'Retirement room calculators', kind: 'calculator' },
  'calc:cash': { label: 'Cash model', kind: 'calculator' },
  'plan-projection': { label: 'Straight-line projection of this year', kind: 'projection' },
  'wargame-model': { label: 'War-game model: salary, tax and cash calculators', kind: 'model' },
});

// ---------------------------------------------------------------- output helpers

export function createOut(clock) {
  const out = { clock, figures: {}, sources: {}, warnings: new Set(), info: { confirm: {}, blocked: [] }, model: {} };
  out.warn = code => out.warnings.add(code);
  out.source = (id, label, asOf, kind) => { out.sources[id] = { label, asOf, kind }; };
  out.put = (key, v, kind, label, src, locator, fileId = null) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    if (!out.sources[src] && SOURCES[src]) out.source(src, SOURCES[src].label, dateLabel(clock), SOURCES[src].kind);
    out.figures[key] = {
      key, v: cents(v), kind, label: key.startsWith('wg.') ? label : cleanLabel(label), src, fileId,
      locator: { ...locator, computedOn: clock },
    };
    return out.figures[key];
  };
  // A calculator call that may throw on unusable inputs: warn calc_failed:<fn> and go on.
  out.safe = (fn, call) => {
    try { return call(); } catch (e) {
      if (e instanceof RangeError || e instanceof TypeError) { out.warn(`calc_failed:${fn}`); return null; }
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

  // Tax payments.
  const payments = jurisdiction => data.taxPayments.filter(t => t.jurisdiction === jurisdiction);
  const fedPay = payments('federal');
  const isVa = facts['household.state'] === 'VA';
  const vaPay = isVa ? payments('state') : [];
  if (fedPay.length || vaPay.length) {
    const last = data.taxPayments.map(t => t.date).sort().at(-1);
    out.source('tax-payments', SOURCES['tax-payments'].label, dateLabel(last), SOURCES['tax-payments'].kind);
  }
  if (fedPay.length) out.put('tax.fed.paid', sum(fedPay.map(t => t.amount)), 'a', 'Federal estimated tax paid this year', 'tax-payments', rowsLoc('tax_payments', fedPay.map(t => t.id)));
  if (vaPay.length) out.put('tax.va.paid', sum(vaPay.map(t => t.amount)), 'a', 'Virginia estimated tax paid this year', 'tax-payments', rowsLoc('tax_payments', vaPay.map(t => t.id)));

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
  if (collegeRows.length) {
    txnSource();
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
  out.info.ira = {
    unknownOwner: iraAccts.some(a => a.owner !== 'owner' && a.owner !== 'spouse'),
    owner: iraAccts.some(a => a.owner === 'owner'),
    spouse: iraAccts.some(a => a.owner === 'spouse'),
  };

  if (!TY) {
    out.warn('unsupported_tax_year');
    return finish(out);
  }

  // ---------------------------------------------------------------- the tax year
  let f = facts['household.filingStatus'];
  if (!['single', 'mfj', 'mfs', 'hoh', 'qss'].includes(f)) { f = 'single'; out.warn('filing_status_assumed'); }
  const persons = f === 'mfj' || f === 'mfs' ? ['owner', 'spouse'] : ['owner'];
  const inUnit = p => persons.includes(p);
  const records = payrollRecords(data, entities, out);
  const contrib = contributions(persons, records, corps, owner);
  for (const t of inflows(accounts.filter(IRA_PRETAX), t => /contribution/i.test(t.category ?? ''))) {
    const a = accounts.find(x => x.id === t.account_id);
    if (a && contrib[a.owner]) contrib[a.owner].ira = cents(contrib[a.owner].ira + t.amount);
  }
  const ageOf = p => {
    const v = owner[p === 'spouse' ? 'household.spouseAge' : 'household.ownerAge'];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const ageKey = p => (p === 'spouse' ? 'household.spouseAge' : 'household.ownerAge');
  const sstbOf = e => (e && typeof e.sstb === 'boolean' ? e.sstb : typeof facts['business.sstb'] === 'boolean' ? facts['business.sstb'] : (out.warn('sstb_assumed'), true));

  // Inputs (parts) and what blocks them.
  const blocked = [];
  const w2 = [];
  const biz = [];
  for (const c of corps) {
    if (!inUnit(c.person)) continue;
    const ownRec = records.find(r => r.corp === c.entity.slug);
    const gross = c.sums.salary > 0 ? c.proj(c.sums.salary) : ownRec ? cents(ownRec.wages + ownRec.pretax) : 0;
    const pretax = ownRec ? ownRec.pretax : 0;
    if (gross > 0) w2.push({ person: c.person, src: `corp:${c.entity.slug}`, gross, agi: Math.max(0, cents(gross - pretax)), pretax });
    const K = c.proj(c.sums.net);
    biz.push({ id: c.entity.slug, kind: 'scorp', person: c.person, agi: K, qbi: K, seInput: null, w2Wages: gross, sstb: sstbOf(c.entity) });
    c.gross = gross;
    c.pretax = pretax;
  }
  for (const r of records) {
    if (r.household || !inUnit(r.person)) continue;
    w2.push({ person: r.person, src: 'outside', gross: cents(r.wages + r.pretax), agi: r.wages });
  }
  for (const e of pnlEntities) {
    if (!e.classified) { blocked.push(`entity_unclassified:${e.slug}`); out.warn('entity_unclassified'); continue; }
    if ((e.type === 'sole_prop' || e.type === 'llc_single') && inUnit(e.owner)) {
      const S = e.proj(e.sums.net);
      biz.push({ id: e.slug, kind: 'sole', person: e.owner, agi: S, qbi: S, seInput: S, w2Wages: 0, sstb: sstbOf(e) });
    }
  }
  const k1s = data.documents.filter(d => d.docType === 'k1' && Number(d.taxYear) === TY);
  const partnerships = entities.filter(e => e.classified && e.type === 'partnership');
  const k1Inputs = k1s.map(d => ({ ...d.fields, id: `k1-${d.id}` }));
  if (!k1Inputs.length && partnerships.length) {
    const est = owner['income.partnershipEstimate'];
    if (est && typeof est === 'object') k1Inputs.push({ ...est, id: `${partnerships[0].slug}` });
    else blocked.push('partnership_incomplete');
  }
  for (const k of k1Inputs) {
    const fields = ['ordinaryIncome', 'guaranteedPayments', 'seEarnings'];
    if (!fields.every(x => Number.isFinite(Number(k[x])) && k[x] !== null && k[x] !== '')) { blocked.push('partnership_incomplete'); continue; }
    const person = k.person === 'spouse' ? 'spouse' : 'owner';
    if (k.person !== 'owner' && k.person !== 'spouse') out.warn('person_assumed');
    if (!inUnit(person)) continue;
    const ordinary = Number(k.ordinaryIncome);
    biz.push({ id: k.id, kind: 'partnership', person, agi: cents(ordinary + Number(k.guaranteedPayments)), qbi: ordinary, seInput: Number(k.seEarnings), w2Wages: 0, sstb: sstbOf(null) });
  }

  // Virginia529 accounts (S8, T5).
  const vaPlans = owner['accounts.va529'] && typeof owner['accounts.va529'] === 'object' ? owner['accounts.va529'] : null;
  const cap = law('va529Cap');
  const college = collegeAccts.map(a => {
    const entry = vaPlans ? vaPlans[a.id] : null;
    const contribYtd = sum(inflows([a]).map(t => t.amount));
    const eligible = !!entry && entry.virginiaPlan === true && entry.ownerAge70Plus !== true;
    const deduction = eligible ? Math.min(cap, cents(contribYtd + num(entry.carryforward))) : 0;
    return { account: a, entry, contribYtd, eligible, deduction, age70: !!entry && entry.virginiaPlan === true && entry.ownerAge70Plus === true };
  });
  out.info.va529 = {
    accounts: college.length,
    missing: college.filter(c => !c.entry).map(c => c.account.name),
    age70: college.filter(c => c.age70).map(c => c.account.name),
    eligible: college.filter(c => c.eligible).length,
  };

  const itemized = typeof owner['tax.itemizedEstimate'] === 'number' ? owner['tax.itemizedEstimate'] : 0;
  const vaItemized = typeof owner['tax.vaItemizedEstimate'] === 'number' ? owner['tax.vaItemizedEstimate'] : null;
  const vaBlocked = isVa && itemized > stdDeduction(f) && vaItemized == null ? 'va_itemized_missing' : null;
  const ages = Array.isArray(facts['household.dependentAges']) ? facts['household.dependentAges'] : [];
  const parts = {
    f, state: facts['household.state'] ?? null, persons, w2, biz, hsaPersonal,
    itemized, vaItemized: itemized > stdDeduction(f) ? vaItemized : null,
    va529Deduction: isVa ? sum(college.filter(c => c.eligible).map(c => c.deduction)) : 0,
    children: ages.filter(a => typeof a === 'number' && a < 17).length,
    vaBlocked,
  };
  const hasIncome = biz.length > 0 || w2.length > 0;
  out.info.blocked = [...new Set(blocked)];
  out.info.vaBlocked = vaBlocked;
  out.info.persons = persons;
  out.info.f = f;

  let hh = null;
  if (hasIncome && !blocked.length) {
    hh = out.safe('householdTax', () => householdTax(parts));
    if (hh) for (const w of hh.warnings) out.warn(w);
  }
  if (hh) writeTax(data, out, { hh, parts, records, owner, f, isVa, fedPay, vaPay });
  out.info.taxComputed = !!hh;

  // Retirement room (R5, R6, S5, S6).
  const retireMissing = ['retirement.planTermsConfirmed', 'retirement.aggregationConfirmed'].filter(k => owner[k] !== true);
  const conf = { planConfirmed: true, aggregationConfirmed: true };
  const assumptions = [ASSUMES_CONFIRMED];
  const corpInUnit = corps.find(c => inUnit(c.person) && c.gross > 0) || null;
  const soleByPerson = p => sum(biz.filter(b => b.kind === 'sole' && b.person === p).map(b => b.seInput));
  if (hasIncome && !blocked.length) {
    const soloPerson = corpInUnit ? corpInUnit.person : persons.find(p => soleByPerson(p) > 0);
    if (soloPerson) {
      const missing = [...retireMissing, ...(ageOf(soloPerson) == null ? [ageKey(soloPerson)] : [])];
      if (missing.length) out.info.confirm.retirement = missing;
      else {
        const c = contrib[soloPerson];
        const compensation = corpInUnit ? corpInUnit.gross : Math.max(0, cents(soleByPerson(soloPerson) - (hh && hh.se[soloPerson] ? hh.se[soloPerson].deductibleHalf : 0)));
        const inputs = {
          compensation, kind: corpInUnit ? 'w2' : 'self-employed', age: ageOf(soloPerson), allPlanDeferrals: c.all401k,
          thisPlanDeferrals: c.thisPlan, thisPlanCatchUp: c.thisCatchUp, employerContributions: c.employer, ...conf,
        };
        const env = out.safe('solo401kRoom', () => solo401kRoom(inputs));
        if (env) {
          const loc = { calc: 'solo401kRoom', inputs: env.inputs, steps: env.steps, assumptions };
          out.put('room.solo401k', env.value.total, 'm', 'Solo 401(k) room left this year', 'calc:retirement', loc);
          out.put('room.solo401k.employee', cents(env.value.employee + env.value.catchUp), 'm', 'Employee deferral room left', 'calc:retirement', loc);
          out.put('room.solo401k.employer', env.value.employer, 'm', 'Employer contribution room left', 'calc:retirement', loc);
        }
      }
    }
    if (!retireMissing.length) {
      const seps = persons.filter(p => soleByPerson(p) > 0).map(p => out.safe('sepRoom', () => sepRoom({
        kind: 'self-employed', netProfit: soleByPerson(p), filingStatus: f, employerContributions: contrib[p].sep, ...conf,
      }))).filter(Boolean);
      if (!seps.length && corpInUnit) {
        const env = out.safe('sepRoom', () => sepRoom({ kind: 'w2', compensation: corpInUnit.gross, employerContributions: contrib[corpInUnit.person].sep, ...conf }));
        if (env) seps.push(env);
      }
      if (seps.length) {
        out.put('room.sep', sum(seps.map(e => e.value)), 'm', 'SEP IRA room left this year', 'calc:retirement',
          { calc: 'sepRoom', inputs: seps.map(e => e.inputs), steps: seps.flatMap(e => e.steps), assumptions });
      }
    } else if (!out.info.confirm.retirement) {
      out.info.confirm.retirement = retireMissing;
    }
  }
  if (hh) iraRoom(out, { hh, persons, w2, biz, contrib, ageOf, f });
  hsaRoom(out, { facts, owner, records, hsaPersonal, hsaAccts, ageOf, ageKey, inUnit });
  if (hh && isVa && out.info.va529.eligible > 0) va529Figures(out, { hh, parts, college });

  // War games.
  if (hh) {
    out.model = buildWargames(data, out, {
      clock, f, parts, hh, corp: corpInUnit, corps, entities: pnlEntities, owner, facts, contrib, ageOf, ageKey,
      retireMissing, accounts, householdTax,
    });
  }
  return finish(out);
}

function finish(out) {
  return { figures: out.figures, sources: out.sources, model: out.model, warnings: [...out.warnings].sort(), info: out.info };
}

// ---------------------------------------------------------------- pieces

function monthlyOutflow(data, out) {
  const ids = new Set(data.accounts.filter(a => PERSONAL_CASH.includes(a.kind)).map(a => a.id));
  const clockMonth = `${data.clock.slice(0, 7)}-01`;
  const start = addDays(clockMonth, -1).slice(0, 7);
  const months = [];
  let cursor = start;
  for (let i = 0; i < 3; i++) {
    months.unshift(cursor);
    cursor = addDays(`${cursor}-01`, -1).slice(0, 7);
  }
  const rows = data.transactions.filter(t => ids.has(t.account_id) && t.amount < 0 && months.includes(t.date.slice(0, 7)) && !/transfer|payment/i.test(t.category ?? ''));
  const total = -sum(rows.map(t => t.amount));
  if (!(total > 0)) return;
  const avg = cents(total / 3);
  out.put('cash.monthlyOut', avg, 'e', 'Average monthly spending from personal accounts', 'calc:cash',
    { calc: 'monthlyOutflow', ...rowsLoc('transactions', rows.map(t => t.id)), inputs: { months }, steps: [{ label: 'Monthly outflow', formula: 'outflows over the last three full months / three', value: avg }] });
  const personal = out.figures['cash.personal'];
  if (personal) {
    const runway = Math.round(personal.v / avg * 10) / 10;
    out.put('cash.runwayMonths', runway, 'e', 'Months of spending covered by personal cash', 'calc:cash',
      { calc: 'runway', inputs: { personal: personal.v, monthlyOut: avg }, steps: [{ label: 'Runway', formula: 'personal cash / monthly outflow', value: runway }] });
  }
}

function writeTax(data, out, { hh, parts, records, owner, f, isVa, fedPay, vaPay }) {
  const assumptions = ['va_exemptions_omitted', 'agi_as_magi_proxy', ASSUMES_CONFIRMED];
  if (parts.children > 0 && hh.ctc === 0) assumptions.push('ctc_phaseout_unsupported');
  const loc = { calc: 'householdTax', parts: summarizeParts(parts), steps: hh.steps, assumptions };
  out.put('agi.est', hh.agi, 'e', 'Estimated adjusted gross income', 'calc:tax', loc);
  out.put('tax.fed.qbi', hh.qbi, 'm', 'Qualified business income deduction', 'calc:tax', loc);
  out.put('tax.fed.taxable', hh.taxable, 'm', 'Federal taxable income', 'calc:tax', loc);
  out.put('tax.fed.income', hh.fedIncome, 'm', 'Federal income tax before credits', 'calc:tax', loc);
  if (hh.seTotal > 0) out.put('tax.fed.se', hh.seTotal, 'm', 'Self-employment tax', 'calc:tax', loc);
  out.put('tax.fed.proj', hh.fedTotal, 'm', 'Projected federal tax for the year', 'calc:tax', loc);
  if (hh.va != null) out.put('tax.va.proj', hh.va, 'm', 'Projected Virginia tax for the year', 'calc:tax', loc);

  // Withholding (R3, T2): owner facts replace document sums.
  const docRows = records.map(r => r.docId);
  const withheld = (factKey, pick) => {
    if (typeof owner[factKey] === 'number') return { v: owner[factKey], loc: rowsLoc('facts', [factKey]) };
    return { v: sum(records.map(pick)), loc: rowsLoc('documents', docRows) };
  };
  const fedW = withheld('tax.withholding.federal', r => r.fedWithheld + r.addlWithheld);
  if (fedW.v > 0) out.put('tax.fed.withheld', fedW.v, 'a', 'Federal tax withheld from wages', 'docs', fedW.loc);
  const vaW = isVa ? withheld('tax.withholding.virginia', r => r.stateWithheld) : { v: 0 };
  if (vaW.v > 0) out.put('tax.va.withheld', vaW.v, 'a', 'Virginia tax withheld from wages', 'docs', vaW.loc);
  if (out.figures['tax.fed.withheld'] || out.figures['tax.va.withheld']) out.source('docs', SOURCES.docs.label, dateLabel(data.clock), SOURCES.docs.kind);

  // Safe harbor.
  const prior = priorYear(data, owner);
  const fedPaid = sum(fedPay.map(t => t.amount));
  if (prior.federalTax != null && prior.agi != null) {
    const env = out.safe('estimatedPaymentSafeHarbor', () => estimatedPaymentSafeHarbor({
      currentYearTax: hh.fedTotal, priorYearTax: prior.federalTax, priorYearAgi: prior.agi, filingStatus: f,
      withholding: fedW.v, paymentsMade: fedPaid, priorReturnFullYear: true, specialRulesAbsent: true,
    }));
    if (env) {
      const l = { calc: 'estimatedPaymentSafeHarbor', inputs: env.inputs, steps: [...env.steps, ...hh.steps.filter(s => /Federal total/.test(s.label))], assumptions };
      out.put('sh.fed.required', env.value.requiredAnnualPayment, 'm', 'Federal safe-harbor target for the year', 'calc:tax', l);
      out.put('sh.fed.remaining', env.value.remaining, 'm', 'Federal safe harbor still to pay', 'calc:tax', l);
      out.info.priorHigh = prior.agi > (f === 'mfs' ? 75000 : 150000);
    }
  } else {
    out.warn('prior_year_missing');
    const required = cents(0.9 * hh.fedTotal);
    const remaining = Math.max(0, cents(required - fedW.v - fedPaid));
    const l = { calc: 'currentYearSafeHarbor', inputs: { currentYearTax: hh.fedTotal, withholding: fedW.v, paymentsMade: fedPaid },
      steps: [{ label: 'Current-year target', formula: 'projected tax * current-year percentage', value: required }, { label: 'Remaining', formula: 'target - withholding - payments', value: remaining }], assumptions };
    out.put('sh.fed.required', required, 'e', 'Federal safe-harbor target for the year', 'calc:tax', l);
    out.put('sh.fed.remaining', remaining, 'e', 'Federal safe harbor still to pay', 'calc:tax', l);
  }
  out.info.priorYear = prior.federalTax != null && prior.agi != null;
  if (hh.va != null) {
    const vaPaid = sum(vaPay.map(t => t.amount));
    const hasPrior = prior.virginiaTax != null;
    let required = 0;
    if (cents(hh.va - vaW.v) >= law('vaEstimateThreshold')) required = hasPrior ? cents(Math.min(0.9 * hh.va, prior.virginiaTax)) : cents(0.9 * hh.va);
    const remaining = Math.max(0, cents(required - vaW.v - vaPaid));
    const kind = hasPrior ? 'm' : 'e';
    const l = { calc: 'virginiaSafeHarbor', inputs: { currentYearTax: hh.va, priorYearTax: prior.virginiaTax ?? null, withholding: vaW.v, paymentsMade: vaPaid },
      steps: [...hh.steps.filter(s => /^Virginia/.test(s.label)), { label: 'Virginia target', formula: 'lesser of current-year percentage of projected tax and prior-year tax, zero under the threshold', value: required },
        { label: 'Remaining', formula: 'target - withholding - payments', value: remaining }], assumptions };
    out.put('sh.va.required', required, kind, 'Virginia safe-harbor target for the year', 'calc:tax', l);
    out.put('sh.va.remaining', remaining, kind, 'Virginia estimate still to pay', 'calc:tax', l);
  }
}

function summarizeParts(parts) {
  return {
    filingStatus: parts.f, state: parts.state,
    wages: parts.w2.map(w => ({ person: w.person, source: w.src.startsWith('corp:') ? 'own S corp' : 'outside employer', gross: w.gross, agi: w.agi })),
    businesses: parts.biz.map(b => ({ id: b.id, kind: b.kind, person: b.person, income: b.agi, qbi: b.qbi, seInput: b.seInput })),
    hsaPersonal: parts.hsaPersonal, itemized: parts.itemized || null, va529Deduction: parts.va529Deduction, children: parts.children,
  };
}

function priorYear(data, owner) {
  const doc = data.documents.filter(d => d.docType === 'tax_return' && Number(d.taxYear) === data.taxYear - 1).at(-1);
  const pick = (field, factKey) => {
    const v = doc ? doc.fields[field] : undefined;
    if (Number.isFinite(Number(v)) && v !== null && v !== '') return Number(v);
    const fv = owner[factKey];
    return typeof fv === 'number' ? fv : null;
  };
  return { federalTax: pick('federalTax', 'tax.prior.federal'), virginiaTax: pick('virginiaTax', 'tax.prior.virginia'), agi: pick('agi', 'tax.prior.agi') };
}

function iraRoom(out, { hh, persons, w2, biz, contrib, ageOf, f }) {
  const comp = p => {
    const wages = sum(w2.filter(w => w.person === p).map(w => w.agi));
    const se = sum(biz.filter(b => b.person === p && b.seInput != null).map(b => b.seInput));
    const dh = hh.se[p] ? hh.se[p].deductibleHalf : 0;
    return cents(wages + Math.max(0, se - dh));
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
  if (env) out.put('room.hsa', env.value.remaining, 'm', 'HSA room left this year', 'calc:retirement', { calc: 'hsaLimit', inputs: env.inputs, steps: env.steps, assumptions: [ASSUMES_CONFIRMED] });
}

function va529Figures(out, { hh, parts, college }) {
  const cap = law('va529Cap');
  const eligible = college.filter(c => c.eligible);
  const left = sum(eligible.map(c => Math.max(0, cents(cap - c.deduction))));
  const steps = eligible.map((c, i) => ({ label: `Account ${i + 1} deduction`, formula: 'min(cap, contributions this year + carryforward)', value: c.deduction }));
  steps.push({ label: 'Deduction left', formula: 'cap - deduction, summed over Virginia plan accounts', value: left });
  out.put('va529.deductionLeft', left, 'm', 'Virginia 529 deduction left this year', 'calc:tax', { calc: 'va529Deduction', inputs: { cap, accounts: eligible.length }, steps });
  if (hh.va == null) return;
  const full = householdTax({ ...parts, va529Deduction: cents(eligible.length * cap) });
  const saved = cents(hh.va - full.va);
  out.put('va529.taxSaved', saved, 'm', 'Virginia tax saved by using the deduction in full', 'calc:tax', {
    calc: 'virginiaIncomeTax',
    inputs: { current: hh.vaTaxable, full: full.vaTaxable },
    steps: [...hh.steps.filter(s => /^Virginia/.test(s.label)).map(s => ({ ...s, label: `Current: ${s.label}` })),
      ...full.steps.filter(s => /^Virginia/.test(s.label)).map(s => ({ ...s, label: `Full deduction: ${s.label}` })),
      { label: 'Tax saved', formula: 'Virginia tax now - Virginia tax with the full deduction', value: saved }],
  });
}
