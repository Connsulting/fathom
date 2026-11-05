// War-game models (S3, S13, R16, R17): the salary tradeoff over the owner-approved range and the
// December invoice deferral, each value written as a model figure (kind m, src wargame-model) whose
// locator holds the calculator inputs and steps. brief.mjs stores the returned content.
//
// buildWargames(data, out, ctx) -> {salary?, deferral?}

import { payrollTax, solo401kRoom } from '../../calc/index.mjs';
import { cents } from '../../store/db.mjs';
import { sameName, monthOf, yearOf, sum } from './data.mjs';
import { stepsOf } from './household.mjs';

const ASSUMES = 'assumes plan terms and eligibility are confirmed with your advisor';
const round1000 = v => Math.round(v / 1000) * 1000;
const pointId = s => (s % 1000 === 0 ? `s${s / 1000}` : `s${Math.round(s)}`);

export function buildWargames(data, out, ctx) {
  const model = {};
  const salary = salaryGame(data, out, ctx);
  if (salary) model.salary = salary;
  const deferral = deferralGame(data, out, ctx);
  if (deferral) model.deferral = deferral;
  return model;
}

const put = (out, key, v, label, locator) => out.put(key, v, 'm', label, 'wargame-model', locator);

// Figure key prefixes a stored war-game content value still references: wg.salary.<point>.,
// wg.deferral.base. and wg.deferral.<option>. (S11, T7).
export function wargameFigurePrefixes(wargameContent) {
  const wg = wargameContent || {};
  const prefixes = [];
  for (const p of (wg.salary && Array.isArray(wg.salary.points) ? wg.salary.points : [])) prefixes.push(`wg.salary.${p.id}.`);
  if (wg.deferral) {
    prefixes.push('wg.deferral.base.');
    for (const o of Array.isArray(wg.deferral.options) ? wg.deferral.options : []) prefixes.push(`wg.deferral.${o.id}.`);
  }
  return prefixes;
}

// ---------------------------------------------------------------- salary (S3, T3, R6)

function salaryGame(data, out, ctx) {
  const { corp, parts, f, owner, contrib, ageOf, ageKey, retireMissing, householdTax } = ctx;
  if (!corp || !(corp.P > 0) || parts.vaBlocked) return null;
  const range = owner['business.salaryRange'];
  const valid = range && typeof range === 'object' && Number.isFinite(range.min) && Number.isFinite(range.max) && range.min > 0 && range.max > 0;
  const missing = [...(valid ? [] : ['business.salaryRange']), ...retireMissing, ...(ageOf(corp.person) == null ? [ageKey(corp.person)] : [])];
  if (missing.length) { out.info.confirm.salary = missing; return null; }
  const lo = Math.min(range.min, range.max);
  const hi = Math.max(range.min, range.max);
  const current = corp.gross;
  const inRange = current > 0 && current >= lo && current <= hi;
  const outside = inRange ? 'in' : current > 0 ? 'out' : 'none';
  // Grid points rounded to the thousand, then clamped into the approved range (G3).
  const clamp = v => Math.min(hi, Math.max(lo, v));
  const grid = [0, 1, 2, 3, 4].map(i => clamp(round1000(lo + (hi - lo) * i / 4)));
  const salaries = [...new Set([...grid, ...(inRange ? [current] : [])])].sort((a, b) => a - b);
  const P = corp.P;
  const slug = corp.entity.slug;
  const age = ageOf(corp.person);
  const c = contrib[corp.person];
  const otherMedicare = f === 'mfj' ? sum(parts.w2.filter(w => w.person !== corp.person).map(w => w.gross)) : 0;

  const evaluate = s => out.safe('salaryPoint', () => {
    const pay = payrollTax({ wages: s, filingStatus: f, spouseMedicareWages: otherMedicare });
    const K = cents(P - s - pay.value.employerTotal);
    if (K < 0) return null;
    const w2 = parts.w2.some(w => w.src === `corp:${slug}`)
      ? parts.w2.map(w => (w.src === `corp:${slug}` ? { ...w, gross: s, agi: Math.max(0, cents(s - (corp.pretax || 0))) } : w))
      : [...parts.w2, { person: corp.person, src: `corp:${slug}`, gross: s, agi: s }];
    const biz = parts.biz.map(b => (b.id === slug && b.kind === 'scorp' ? { ...b, agi: K, qbi: K, w2Wages: s } : b));
    const hh = householdTax({ ...parts, w2, biz });
    const payrollNet = cents(pay.value.total - pay.value.additionalMedicare);
    const total = cents(hh.fedTotal + (hh.va ?? 0) + payrollNet);
    const room = solo401kRoom({
      compensation: s, kind: 'w2', age, allPlanDeferrals: c.all401k, thisPlanDeferrals: c.thisPlan,
      thisPlanCatchUp: c.thisCatchUp, employerContributions: c.employer, planConfirmed: true, aggregationConfirmed: true,
    });
    const steps = [...stepsOf('Payroll tax', pay), { label: 'Distributions', formula: 'profit before salary - salary - employer payroll tax', value: K },
      ...hh.steps, { label: 'Total tax', formula: 'federal + Virginia + payroll tax (Additional Medicare counted once)', value: total }];
    return { s, pay, payrollNet, K, total, x: room.value.total, room, steps };
  });

  const points = salaries.map(evaluate).filter(Boolean);
  if (points.length < 2) return null;
  let ref = inRange ? points.find(p => p.s === current) : null;
  if (!ref) ref = evaluate(clamp(round1000((lo + hi) / 2)));
  if (!ref) return null;

  const content = [];
  for (const p of points) {
    const id = pointId(p.s);
    const y = cents(p.total - ref.total);
    const inputs = { salary: p.s, profitBeforeSalary: P, filingStatus: f, age };
    const loc = steps => ({ calc: 'salaryPoint', inputs, steps, assumptions: [ASSUMES] });
    put(out, `wg.salary.${id}.salary`, p.s, 'Salary point: salary', loc([{ label: 'Salary', formula: 'grid point inside the approved range', value: p.s }]));
    put(out, `wg.salary.${id}.payroll`, p.payrollNet, 'Salary point: payroll tax', loc(stepsOf('Payroll tax', p.pay)));
    put(out, `wg.salary.${id}.dist`, p.K, 'Salary point: distributions', loc(p.steps.slice(0, p.pay.steps.length + 1)));
    put(out, `wg.salary.${id}.tax`, p.total, 'Salary point: total tax', loc(p.steps));
    put(out, `wg.salary.${id}.x`, p.x, 'Salary point: pre-tax retirement room', { ...loc(stepsOf('Solo 401(k) room', p.room)), calc: 'solo401kRoom' });
    put(out, `wg.salary.${id}.y`, y, 'Salary point: tax change', loc([...p.steps.map(s => ({ ...s, label: `Point: ${s.label}` })),
      ...ref.steps.map(s => ({ ...s, label: `Reference: ${s.label}` })), { label: 'Tax change', formula: 'total tax at the point - total tax at the reference salary', value: y }]));
    const point = {
      id, label: `Salary {fk:wg.salary.${id}.salary}`, x: p.x, y, frontier: false,
      note: `Distributions {f:wg.salary.${id}.dist}, payroll tax {f:wg.salary.${id}.payroll}.`,
    };
    if (inRange && p.s === current) point.current = true;
    content.push(point);
  }
  for (const p of content) {
    p.frontier = !content.some(q => q !== p && q.x >= p.x && q.y <= p.y && (q.x > p.x || q.y < p.y));
  }
  return {
    title: `What should you pay yourself in ${data.taxYear}?`,
    question: {
      in: 'Each point trades payroll tax against retirement room. The current salary is marked.',
      out: 'Each point trades payroll tax against retirement room. Your current salary is outside the approved range, so changes are measured against the middle of the range.',
      none: 'Each point trades payroll tax against retirement room. You have no officer salary yet this year, so changes are measured against the middle of the range.',
    }[outside],
    xLabel: 'Pre-tax retirement room',
    yLabel: inRange ? 'Tax change vs your current salary' : 'Tax change vs the middle of the range',
    points: content,
    takeaway: {
      in: 'A higher salary buys more pre-tax retirement room and costs more payroll tax. Points on the frontier give the most room for the tax.',
      out: 'Your current salary is outside the range your advisor approved. Pick a point inside it with your advisor before the last payroll.',
      none: 'An S corp owner who works in the business needs a reasonable salary. Pick a point inside the approved range with your advisor before the last payroll.',
    }[outside],
  };
}

// ---------------------------------------------------------------- deferral (S13, R16)

function deferralGame(data, out, ctx) {
  const { clock, owner, parts, entities, accounts, householdTax } = ctx;
  const TY = data.taxYear;
  if (yearOf(clock) !== TY || monthOf(clock) < 10 || parts.vaBlocked) return null;
  const corpBiz = parts.biz.find(b => b.kind === 'scorp');
  const soles = parts.biz.filter(b => b.kind === 'sole').sort((a, b) => b.agi - a.agi);
  const b = corpBiz || soles[0];
  if (!b) return null;
  const e = entities.find(x => x.slug === b.id);
  if (!e || !(e.sums.income > 0)) return null;
  if (owner['business.cashBasis'] !== true) {
    if (owner['business.cashBasis'] == null) out.info.confirm.deferral = ['business.cashBasis'];
    return null;
  }
  const bizAccts = accounts.filter(a => a.kind === 'business' && a.latest);
  const named = bizAccts.filter(a => a.entity && sameName(a.entity, e.name));
  const businesses = entities.filter(x => x.classified && x.lines.length);
  const cashAccts = named.length ? named : businesses.length === 1 ? bizAccts : [];
  if (!cashAccts.length) return null;
  const cash = sum(cashAccts.map(a => a.latest.amount));
  const balDate = cashAccts.map(a => a.latest.date).sort().at(-1);
  if (yearOf(balDate) !== TY) return null;
  const monthsLeft = 12 - monthOf(balDate);
  if (monthsLeft < 1) return null;

  const isCorp = b.kind === 'scorp';
  const m = e.months;
  const A = cents(e.sums.income / m);
  const avgPre = (e.sums.net + (isCorp ? e.sums.salary + e.sums.payrollTax : 0)) / m;
  const monthlyPayroll = isCorp ? cents((e.proj(e.sums.salary) + e.proj(e.sums.payrollTax)) / 12) : 0;
  const monthlyOut = out.figures['cash.monthlyOut'] ? out.figures['cash.monthlyOut'].v : 0;
  const need = isCorp ? monthlyPayroll : monthlyOut;

  const shift = (base, delta) => ({
    ...parts,
    biz: parts.biz.map(x => (x.id === b.id && x.kind === b.kind
      ? { ...x, agi: cents(base + delta), qbi: cents(base + delta), ...(x.seInput != null ? { seInput: cents(base + delta) } : {}) }
      : x)),
  });
  const T = p => {
    const h = householdTax(p);
    return { total: cents(h.fedTotal + (h.va ?? 0)), steps: h.steps };
  };
  const next = owner['plan.nextYearBusinessIncome'];
  const base27 = typeof next === 'number' && Number.isFinite(next) ? next : b.agi;
  const assumptions = [ASSUMES, 'parameters_2026_proxy', ...(base27 === b.agi && typeof next !== 'number' ? ['next_year_flat'] : [])];
  const t26Base = T(shift(b.agi, 0));
  const t27Base = T(shift(base27, 0));

  put(out, 'wg.deferral.base.income', A, 'Invoice deferral: monthly invoices', {
    calc: 'deferralBase', inputs: { incomeYtd: e.sums.income, months: m },
    steps: [{ label: 'Monthly invoices', formula: 'business income this year / months of data', value: A }],
  });
  const options = [
    { id: 'd0', label: 'Bill it all now', amount: 0 },
    { id: 'd50', label: 'Move half to January', amount: cents(A / 2) },
    { id: 'd100', label: 'Move it all to January', amount: A },
  ].map(o => {
    const t26 = T(shift(b.agi, -o.amount));
    const t27 = T(shift(base27, o.amount));
    const tax2026 = cents(t26.total - t26Base.total);
    const tax2027 = cents(t27.total - t27Base.total);
    const net = cents(tax2026 + tax2027);
    const decCash = cents(cash + monthsLeft * avgPre - (monthsLeft - 1) * monthlyPayroll - o.amount);
    const gap = cents(need - decCash);
    const inputs = { amount: o.amount, businessIncome: b.agi, nextYearIncome: base27 };
    const taxLoc = (a, z, what) => ({
      calc: 'householdTax', inputs, assumptions,
      steps: [...a.steps.map(s => ({ ...s, label: `With deferral: ${s.label}` })), ...z.steps.map(s => ({ ...s, label: `Without: ${s.label}` })),
        { label: what, formula: 'tax with the deferral - tax without it', value: cents(a.total - z.total) }],
    });
    const cashLoc = {
      calc: 'decemberCash', inputs: { cash, monthsLeft, avgMonthlyPrePayroll: cents(avgPre), monthlyPayroll, amount: o.amount }, assumptions,
      steps: [{ label: 'December cash', formula: 'cash + months left * average monthly receipts before payroll - (months left - one) * monthly payroll - amount moved', value: decCash }],
    };
    const needLoc = { calc: 'payrollNeed', inputs: { monthlyPayroll, monthlyOut }, steps: [{ label: 'December need', formula: isCorp ? 'projected salary and employer payroll tax / twelve' : 'average monthly spending', value: need }] };
    const k = `wg.deferral.${o.id}`;
    put(out, `${k}.amount`, o.amount, `${o.label}: amount moved to January`, { calc: 'deferralBase', inputs: { monthly: A }, steps: [{ label: 'Amount moved', formula: 'share of a month of invoices', value: o.amount }] });
    put(out, `${k}.tax2026`, tax2026, `${o.label}: ${TY} tax change`, taxLoc(t26, t26Base, 'This year tax change'));
    put(out, `${k}.tax2027`, tax2027, `${o.label}: ${TY + 1} tax change`, taxLoc(t27, t27Base, 'Next year tax change'));
    put(out, `${k}.net`, net, `${o.label}: net tax change`, { ...taxLoc(t26, t26Base, 'This year tax change'), steps: [...taxLoc(t26, t26Base, 'This year tax change').steps, ...taxLoc(t27, t27Base, 'Next year tax change').steps, { label: 'Net', formula: 'this year change + next year change', value: net }] });
    put(out, `${k}.decCash`, decCash, `${o.label}: December business cash`, cashLoc);
    put(out, `${k}.need`, need, `${o.label}: December payroll need`, needLoc);
    put(out, `${k}.gap`, gap, `${o.label}: December need less cash`, { ...cashLoc, steps: [...cashLoc.steps, ...needLoc.steps, { label: 'Gap', formula: 'need - December cash', value: gap }] });
    return {
      id: o.id, label: o.label, amount: o.amount, tax2026, tax2027, net, decCash, need,
      note: `This year's tax changes by {f:${k}.tax2026} and next year's by {f:${k}.tax2027}; December cash is {f:${k}.decCash}.`,
    };
  });
  return {
    title: 'Invoice now or in January?',
    question: 'Moving December invoices into January shifts tax a year and leaves less business cash for December.',
    options,
    takeaway: 'Deferring income moves tax into next year rather than removing it. Keep enough business cash to cover the December payroll.',
  };
}
