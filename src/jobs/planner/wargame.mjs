// War-game models (S3, S13, R16, R17): the salary tradeoff over the owner-approved range and the
// December invoice deferral, each value written as a model figure (kind m, src wargame-model) whose
// locator holds the calculator inputs and steps. brief.mjs stores the returned content.
//
// buildWargames(data, out, ctx) -> {salary?, deferral?}; a game whose inputs fail, or any of whose
// tax runs is blocked (K2: every householdTax run validates retirement contributions at its own
// income), records out.info.wargameInvalid[name] = code (R3-7) and is not offered. Validity runs
// before any season check (K3).

import { payrollTax, solo401kRoom, TAX_2026 } from '../../calc/index.mjs';
import { cents } from '../../store/db.mjs';
import { sameName, monthOf, yearOf, sum } from './data.mjs';
import { stepsOf, planInputs, RETIREMENT_BLOCKS } from './household.mjs';

const PLAN_TERMS = 'plan_terms_confirmed';
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
  const { corp, parts, f, owner, contrib, ageOf, ageKey, retireMissing, householdTax, priorWages } = ctx;
  const invalid = code => { out.info.wargameInvalid.salary = code; return null; };
  if (parts.vaBlocked) return invalid(parts.vaBlocked);
  if (!corp || !(corp.P > 0)) return invalid('inputs_changed');
  const c = contrib[corp.person];
  const range = owner['business.salaryRange'];
  const valid = range && typeof range === 'object' && Number.isFinite(range.min) && Number.isFinite(range.max) && range.min > 0 && range.max > 0;
  // R3-3: unknown outside deferrals leave every point's room unknown (IRC 402(g)(1)).
  const missing = [...(valid ? [] : ['business.salaryRange']), ...retireMissing, ...(ageOf(corp.person) == null ? [ageKey(corp.person)] : []),
    ...(c.outsideKnown ? [] : ['retirement.otherPlanDeferrals'])];
  if (missing.length) { out.info.confirm.salary = missing; return invalid(missing[0]); }
  // E7: each point carries three bases. The axis is cash salary (Medicare wages: payroll tax and
  // Additional Medicare); plan compensation adds this year's non-FICA compensation (box 1 plus
  // elective deferrals less box 5, nothing for a P&L salary); taxable wages are that less the pretax
  // deferrals. Unknown compensation (box 12 unread) leaves every point unknown.
  if (corp.comp == null) return invalid('w2_plan_compensation_unknown');
  const nonFica = corp.fromPnl ? 0 : Math.max(0, cents(corp.comp - corp.gross));
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
  const plan = c.byPlan[slug];
  const otherMedicare = f === 'mfj' ? sum(parts.w2.filter(w => w.person !== corp.person).map(w => w.gross)) : 0;
  // MG6, R2-5, R3-5: x is pre-tax room. An affected participant (prior-year sponsor Social Security
  // wages over the threshold) makes catch-ups only as Roth, and none without a confirmed Roth feature.
  const R = TAX_2026.retirement;
  const affected = priorWages != null && priorWages > R.rothCatchUpPriorWages;
  const rothFact = owner['retirement.planOffersRoth'];
  const catchOff = affected && rothFact !== true;
  const rothCodes = catchOff ? [rothFact === false ? 'roth_catch_up_unavailable' : 'roth_catch_up_unconfirmed'] : [];

  // K2: a point whose tax run is blocked (a contribution over its limit at that salary, IRC
  // 404(a)(3), 402(g), 415(c)) returns {blocked} and makes the game invalid; it is never dropped.
  const evaluate = s => out.safe('salaryPoint', () => {
    const pay = payrollTax({ wages: s, filingStatus: f, spouseMedicareWages: otherMedicare });
    const K = cents(P - s - pay.value.employerTotal);
    if (K < 0) return null;
    const comp = cents(s + nonFica);
    const agi = Math.max(0, cents(comp - (corp.pretax || 0)));
    const w2 = parts.w2.some(w => w.src === `corp:${slug}`)
      ? parts.w2.map(w => (w.src === `corp:${slug}` ? { ...w, gross: s, comp, agi } : w))
      : [...parts.w2, { person: corp.person, src: `corp:${slug}`, gross: s, comp, agi }];
    const biz = parts.biz.map(b => (b.id === slug && b.kind === 'scorp' ? { ...b, agi: K, qbi: K, w2Wages: comp } : b));
    const hh = householdTax({ ...parts, w2, biz });
    if (hh.blocked) return { s, blocked: hh.blocked };
    const payrollNet = cents(pay.value.total - pay.value.additionalMedicare);
    const total = cents(hh.fedTotal + (hh.va ?? 0) + payrollNet);
    const room = solo401kRoom({
      compensation: comp, kind: 'w2', age, ...planInputs(c, plan), planConfirmed: true, aggregationConfirmed: true,
      ...(priorWages != null ? { priorYearSponsorWages: priorWages } : {}), ...(catchOff ? { catchUpAllowed: false } : {}),
    });
    const roth = affected && !catchOff ? room.value.catchUp : 0;
    const steps = [...stepsOf('Payroll tax', pay), { label: 'Distributions', formula: 'profit before salary - salary - employer payroll tax', value: K },
      ...hh.steps, { label: 'Total tax', formula: 'federal + Virginia + payroll tax (Additional Medicare counted once)', value: total }];
    return { s, pay, payrollNet, K, total, x: cents(room.value.total - roth), roth, room, steps };
  });

  const blockedCode = code => (RETIREMENT_BLOCKS.has(code) ? 'wargame_salary_contribution_over_limit' : code);
  const evaluated = salaries.map(evaluate);
  const blockedPoint = evaluated.find(p => p && p.blocked);
  if (blockedPoint) return invalid(blockedCode(blockedPoint.blocked));
  const points = evaluated.filter(Boolean);
  // MG6: catch-up treatment unknown until last year's Social Security wages from the business are known.
  if (priorWages == null && points.some(p => p.room.value.catchUp > 0)) {
    out.info.confirm.salary = ['retirement.priorYearFicaWages'];
    return invalid('retirement.priorYearFicaWages');
  }
  if (points.length < 2) return invalid('inputs_changed');
  let ref = inRange ? points.find(p => p.s === current) : null;
  if (!ref) ref = evaluate(clamp(round1000((lo + hi) / 2)));
  if (!ref) return invalid('inputs_changed');
  if (ref.blocked) return invalid(blockedCode(ref.blocked));

  const content = [];
  for (const p of points) {
    const id = pointId(p.s);
    const y = cents(p.total - ref.total);
    const inputs = { salary: p.s, profitBeforeSalary: P, filingStatus: f, age };
    const loc = steps => ({ calc: 'salaryPoint', inputs, steps, assumptions: [PLAN_TERMS] });
    put(out, `wg.salary.${id}.salary`, p.s, 'Salary point: salary', loc([{ label: 'Salary', formula: 'grid point inside the approved range', value: p.s }]));
    put(out, `wg.salary.${id}.payroll`, p.payrollNet, 'Salary point: payroll tax', loc(stepsOf('Payroll tax', p.pay)));
    put(out, `wg.salary.${id}.dist`, p.K, 'Salary point: distributions', loc(p.steps.slice(0, p.pay.steps.length + 1)));
    put(out, `wg.salary.${id}.tax`, p.total, 'Salary point: total tax', loc(p.steps));
    const roomSteps = [...stepsOf('Solo 401(k) room', p.room), ...(p.roth > 0 ? [{ label: 'Roth catch-up room left out', formula: 'catch-up that must be Roth', value: p.roth }] : [])];
    put(out, `wg.salary.${id}.x`, p.x, 'Salary point: pre-tax retirement room', { ...loc(roomSteps), calc: 'solo401kRoom', assumptions: [PLAN_TERMS, ...rothCodes] });
    if (p.roth > 0) put(out, `wg.salary.${id}.roth`, p.roth, 'Salary point: Roth catch-up room', { ...loc(stepsOf('Solo 401(k) room', p.room)), calc: 'solo401kRoom' });
    put(out, `wg.salary.${id}.y`, y, 'Salary point: tax change', loc([...p.steps.map(s => ({ ...s, label: `Point: ${s.label}` })),
      ...ref.steps.map(s => ({ ...s, label: `Reference: ${s.label}` })), { label: 'Tax change', formula: 'total tax at the point - total tax at the reference salary', value: y }]));
    const point = {
      id, label: `Salary {fk:wg.salary.${id}.salary}`, x: p.x, y, frontier: false,
      note: `Distributions {f:wg.salary.${id}.dist}, payroll tax {f:wg.salary.${id}.payroll}${p.roth > 0 ? `, plus {f:wg.salary.${id}.roth} of Roth catch-up room` : ''}.`,
    };
    if (inRange && p.s === current) point.current = true;
    content.push(point);
  }
  for (const p of content) {
    p.frontier = !content.some(q => q !== p && q.x >= p.x && q.y <= p.y && (q.x > p.x || q.y < p.y));
  }
  const takeaway = {
    in: 'A higher salary buys more pre-tax retirement room and costs more payroll tax. Points on the frontier give the most room for the tax.',
    out: 'Your current salary is outside the range your advisor approved. Pick a point inside it with your advisor before the last payroll.',
    none: 'An S corp owner who works in the business needs a reasonable salary. Pick a point inside the approved range with your advisor before the last payroll.',
  }[outside];
  const rothNote = catchOff && rothFact == null && age >= R.catchUpAge ? ' Catch-up room is left out until you confirm your plan offers Roth deferrals.' : '';
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
    takeaway: takeaway + rothNote,
  };
}

// ---------------------------------------------------------------- deferral (S13, R16)

// K3: validity (inputs and every tax run, always executed in every season, writing
// wargameInvalid) is separate from offering (season, balance year, months left), which is checked
// only after validity passes.
function deferralGame(data, out, ctx) {
  const invalid = code => { out.info.wargameInvalid.deferral = code; return null; };
  const valid = deferralValidity(data, ctx);
  if (valid.invalid) {
    if (valid.confirm) out.info.confirm.deferral = valid.confirm;
    return invalid(valid.invalid);
  }
  if (!deferralOffered(data, ctx.clock, valid.cashAccts)) return null;
  return deferralModel(data, out, ctx, valid);
}

// Inputs and all runs: the current-year base, next-year base and both runs of each option. Every
// run goes through householdTax, which validates the retirement contributions at that run's income
// (this year shifted down, next year shifted up with the same contributions under
// parameters_2026_proxy); any blocked run makes the game invalid.
function deferralValidity(data, ctx) {
  const { owner, parts, entities, accounts, householdTax } = ctx;
  if (parts.vaBlocked) return { invalid: parts.vaBlocked };
  const corpBiz = parts.biz.find(b => b.kind === 'scorp');
  const soles = parts.biz.filter(b => b.kind === 'sole').sort((a, b) => b.agi - a.agi);
  const b = corpBiz || soles[0];
  if (!b) return { invalid: 'inputs_changed' };
  const e = entities.find(x => x.slug === b.id);
  if (!e || !(e.sums.income > 0)) return { invalid: 'inputs_changed' };
  if (owner['business.cashBasis'] !== true) {
    if (owner['business.cashBasis'] == null) {
      return { invalid: 'business.cashBasis', ...(deferralSeason(data, ctx.clock) ? { confirm: ['business.cashBasis'] } : {}) };
    }
    return { invalid: 'inputs_changed' };
  }
  const bizAccts = accounts.filter(a => a.kind === 'business' && a.latest);
  const named = bizAccts.filter(a => a.entity && sameName(a.entity, e.name));
  const businesses = entities.filter(x => x.classified && x.lines.length);
  const cashAccts = named.length ? named : businesses.length === 1 ? bizAccts : [];
  if (!cashAccts.length) return { invalid: 'inputs_changed' };

  const A = cents(e.sums.income / e.months);
  const shift = (base, delta) => ({
    ...parts,
    biz: parts.biz.map(x => (x.id === b.id && x.kind === b.kind
      ? { ...x, agi: cents(base + delta), qbi: cents(base + delta), ...(x.seInput != null ? { seInput: cents(base + delta) } : {}) }
      : x)),
  });
  const T = p => {
    const h = householdTax(p);
    return h.blocked ? { blocked: h.blocked } : { total: cents(h.fedTotal + (h.va ?? 0)), steps: h.steps };
  };
  const next = owner['plan.nextYearBusinessIncome'];
  const base27 = typeof next === 'number' && Number.isFinite(next) ? next : b.agi;
  const OPTIONS = [
    { id: 'd0', label: 'Bill it all now', amount: 0 },
    { id: 'd50', label: 'Move half to January', amount: cents(A / 2) },
    { id: 'd100', label: 'Move it all to January', amount: A },
  ];
  // MG3, K2: every one of the seven tax runs must be complete and valid, or no option is shown.
  const t26Base = T(shift(b.agi, 0));
  const t27Base = T(shift(base27, 0));
  const runs = OPTIONS.map(o => ({ o, t26: T(shift(b.agi, -o.amount)), t27: T(shift(base27, o.amount)) }));
  const blockedRun = [t26Base, t27Base, ...runs.flatMap(r => [r.t26, r.t27])].find(t => t.blocked);
  if (blockedRun) return { invalid: RETIREMENT_BLOCKS.has(blockedRun.blocked) ? 'wargame_contribution_over_limit' : blockedRun.blocked };
  return { b, e, A, cashAccts, next, base27, t26Base, t27Base, runs };
}

const deferralSeason = (data, clock) => yearOf(clock) === data.taxYear && monthOf(clock) >= 10;

// Offering: outside the last quarter of the tax year, or without a balance from this year with a
// month left, the game is simply not offered.
function deferralOffered(data, clock, cashAccts) {
  if (!deferralSeason(data, clock)) return false;
  const balDate = cashAccts.map(a => a.latest.date).sort().at(-1);
  return yearOf(balDate) === data.taxYear && 12 - monthOf(balDate) >= 1;
}

function deferralModel(data, out, ctx, valid) {
  const { b, e, A, cashAccts, next, base27, t26Base, t27Base, runs } = valid;
  const TY = data.taxYear;
  const cash = sum(cashAccts.map(a => a.latest.amount));
  const balDate = cashAccts.map(a => a.latest.date).sort().at(-1);
  const monthsLeft = 12 - monthOf(balDate);
  const isCorp = b.kind === 'scorp';
  const m = e.months;
  const avgPre = (e.sums.net + (isCorp ? e.sums.salary + e.sums.payrollTax : 0)) / m;
  const monthlyPayroll = isCorp ? cents((e.proj(e.sums.salary) + e.proj(e.sums.payrollTax)) / 12) : 0;
  const monthlyOut = out.figures['cash.monthlyOut'] ? out.figures['cash.monthlyOut'].v : 0;
  const need = isCorp ? monthlyPayroll : monthlyOut;
  const codes26 = ['agi_as_magi_proxy'];
  const codes27 = ['parameters_2026_proxy', ...(base27 === b.agi && typeof next !== 'number' ? ['next_year_flat'] : [])];

  put(out, 'wg.deferral.base.income', A, 'Invoice deferral: monthly invoices', {
    calc: 'deferralBase', inputs: { incomeYtd: e.sums.income, months: m },
    steps: [{ label: 'Monthly invoices', formula: 'business income this year / months of data', value: A }],
  });
  const options = runs.map(({ o, t26, t27 }) => {
    const tax2026 = cents(t26.total - t26Base.total);
    const tax2027 = cents(t27.total - t27Base.total);
    const net = cents(tax2026 + tax2027);
    const decCash = cents(cash + monthsLeft * avgPre - (monthsLeft - 1) * monthlyPayroll - o.amount);
    const gap = cents(need - decCash);
    const inputs = { amount: o.amount, businessIncome: b.agi, nextYearIncome: base27 };
    const taxLoc = (a, z, what, assumptions) => ({
      calc: 'householdTax', inputs, assumptions,
      steps: [...a.steps.map(s => ({ ...s, label: `With deferral: ${s.label}` })), ...z.steps.map(s => ({ ...s, label: `Without: ${s.label}` })),
        { label: what, formula: 'tax with the deferral - tax without it', value: cents(a.total - z.total) }],
    });
    const cashLoc = {
      calc: 'decemberCash', inputs: { cash, monthsLeft, avgMonthlyPrePayroll: cents(avgPre), monthlyPayroll, amount: o.amount },
      steps: [{ label: 'December cash', formula: 'cash + months left * average monthly receipts before payroll - (months left - one) * monthly payroll - amount moved', value: decCash }],
    };
    const needLoc = { calc: 'payrollNeed', inputs: { monthlyPayroll, monthlyOut }, steps: [{ label: 'December need', formula: isCorp ? 'projected salary and employer payroll tax / twelve' : 'average monthly spending', value: need }] };
    const k = `wg.deferral.${o.id}`;
    put(out, `${k}.amount`, o.amount, `${o.label}: amount moved to January`, { calc: 'deferralBase', inputs: { monthly: A }, steps: [{ label: 'Amount moved', formula: 'share of a month of invoices', value: o.amount }] });
    put(out, `${k}.tax2026`, tax2026, `${o.label}: ${TY} tax change`, taxLoc(t26, t26Base, 'This year tax change', codes26));
    put(out, `${k}.tax2027`, tax2027, `${o.label}: ${TY + 1} tax change`, taxLoc(t27, t27Base, 'Next year tax change', codes27));
    put(out, `${k}.net`, net, `${o.label}: net tax change`, { ...taxLoc(t26, t26Base, 'This year tax change', [...codes26, ...codes27]), steps: [...taxLoc(t26, t26Base, 'This year tax change').steps, ...taxLoc(t27, t27Base, 'Next year tax change').steps, { label: 'Net', formula: 'this year change + next year change', value: net }] });
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
