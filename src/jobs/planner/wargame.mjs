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
import { notesFor } from './assumptions.mjs';
import { stepsOf, planInputs, RETIREMENT_BLOCKS } from './household.mjs';
import { TAX_GAP_RULES } from '../../shared/tax-gaps.mjs';
import { fixForCode } from '../triggers/missing-data.mjs';
import { advisorWait } from '../../shared/advisor-waits.mjs';

const PLAN_TERMS = 'plan_terms_confirmed';
const OVER_LIMIT = 'retirement_contribution_over_limit';
const OVER_LIMIT_TEXT = Object.freeze({
  salary: 'A retirement contribution would be over its plan limit at this salary, so this point is left out.',
  deferral: 'A retirement contribution would be over its plan limit with this much moved, so this option is left out.',
});
const round1000 = v => Math.round(v / 1000) * 1000;
const pointId = s => (s % 1000 === 0 ? `s${s / 1000}` : `s${Math.round(s)}`);

export function buildWargames(data, out, ctx) {
  const model = {};
  const salary = salaryGame(data, out, ctx);
  if (salary) model.salary = salary;
  else if (out.info.wargameInvalid.salary === 'scorp_missing' && ctx.facts?.['income.sCorp'] === true && !ctx.entities.some(e => e.type === 's_corp') && data.pnl.length) out.info.wargameInvalid.salary = 'scorp_identity_missing';
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
  for (const p of (wg.salary && Array.isArray(wg.salary.excluded) ? wg.salary.excluded : [])) prefixes.push(`wg.salary.${p.id}.salary`);
  if (wg.deferral) {
    prefixes.push('wg.deferral.base.');
    for (const o of Array.isArray(wg.deferral.options) ? wg.deferral.options : []) prefixes.push(`wg.deferral.${o.id}.`);
  }
  return prefixes;
}

// Why a war game could not be built, in plain language with no figures, and the one control that
// unlocks it (H3): `fix` opens the specific answer in Ask (an answer.fact shape) or the upload kind,
// in TAX1's fix shape; `unlock` ('answers' or 'files') follows it. brief.mjs stores one per game that
// has no model and no kept history under content wargame.notBuilt (Decide shows it), and the same
// reason and fix for a game kept only for reference. Tax codes a household run blocks on pass
// through fixForCode. inputs_changed is left only for a game no plan has explained yet.
const GAME_NAME = Object.freeze({ salary: 'Salary war game', deferral: 'Invoice deferral war game' });
const ask = (key, label, prompt) => ({ screen: 'ask', key, label, prompt });
const upload = (kind, label) => ({ screen: 'upload', kind, label });
const PNL = upload('pnl', 'Upload the business profit and loss');
const CONTRIBUTIONS = { ...TAX_GAP_RULES.retirement_contribution_over_limit.fix };
const CLASSIFY = ask('business.entities', 'Classify the businesses', 'Record how my imported businesses are taxed. Ask me for the missing classifications, preserving existing entries and account links.');
export const WARGAME_UNLOCKS = Object.freeze({
  salary: Object.freeze({
    inputs_changed: ['needs an S corp with profit on file.', upload('pnl', 'Upload the S corp profit and loss')],
    scorp_missing: ['needs an S corp with profit on file.', upload('pnl', 'Upload the S corp profit and loss')],
    scorp_profit_missing: ['needs a profit and loss that shows profit for your S corp this year.', upload('pnl', 'Upload the latest S corp profit and loss')],
    'business.salaryRange': ["needs your advisor's reasonable salary range.", ask('business.salaryRange', 'Enter salary range',
      'Record the annual salary range my advisor considers reasonable. Ask me for its minimum and maximum.')],
    salary_points_unavailable: ['needs a salary range your business profit can pay, with room for payroll tax at two or more salaries.', ask('business.salaryRange', 'Correct the salary range',
      'Record the annual salary range my advisor considers reasonable. Ask me for its minimum and maximum.')],
    'household.birthYears': ['needs your birth year to size catch-up room.', ask('household.birthYears', 'Enter birth years', 'Record the years my spouse and I were born. Ask me for them.')],
    'retirement.otherPlanDeferrals': ['needs your deferrals to other workplace plans this year.', { ...TAX_GAP_RULES.deferral_split_unknown.fix }],
    'retirement.priorYearFicaWages': ["needs last year's Social Security wages from your business.", ask('retirement.priorYearFicaWages', "Enter last year's Social Security wages",
      "Record last year's Social Security wages my business paid me, from last year's W-2. Ask me for the amount.")],
    w2_plan_compensation_unknown: ['needs the deferrals from the wage form your business issued.', upload('taxforms', 'Upload a clearer tax form')],
    wargame_salary_contribution_over_limit: ['needs retirement contributions within the plan limits at your current salary.', CONTRIBUTIONS],
    scorp_identity_missing: ['needs you to identify the S corp among the imported ledgers.', ask('business.entities', 'Identify the S corp', CLASSIFY.prompt)],
  }),
  deferral: Object.freeze({
    inputs_changed: ['needs a business with income and its business bank account on file.', PNL],
    business_income_missing: ['needs a business with income this year on file.', PNL],
    'business.cashBasis': ['needs to know whether your business uses cash basis accounting.', ask('business.cashBasis', 'Answer the accounting method',
      'Record whether my business keeps its books on a cash basis.')],
    accrual_basis: ['applies only to cash basis books, and your answer says the business uses accrual.', ask('business.cashBasis', 'Correct the accounting method',
      'Record whether my business keeps its books on a cash basis.')],
    business_account_missing: ['needs a current balance for the business bank account.', upload('bank', 'Upload the business bank statement')],
    business_account_unlinked: ['needs to know which bank account belongs to the business.', ask('accounts.businessEntity', 'Link the business account',
      'Record which business each business bank account belongs to. Ask me for the business name for each account.')],
    wargame_contribution_over_limit: ['needs retirement contributions within the plan limits at the incomes it compares.', CONTRIBUTIONS],
  }),
});

const lowerFirst = s => s.charAt(0).toLowerCase() + s.slice(1);
const unlockOf = fix => (fix.screen === 'upload' ? 'files' : 'answers');
const reason = (code, text, fix) => ({ code, text, unlock: unlockOf(fix), fix: { ...fix } });

export function notBuiltReason(name, code, entities = []) {
  code = String(code);
  const game = GAME_NAME[name] || 'This war game';
  if (code.startsWith('entity_unclassified:')) {
    const entity = entities.find(e => e.slug === code.slice('entity_unclassified:'.length));
    if (entity?.needsName) return reason(code, `${game} needs the business name for ${entity.displayName}.`,
      ask('accounts.businessEntity', 'Enter the business name', `Record the business name for ${entity.displayName}. Ask me for it.`));
    return reason(code, `${game} needs you to classify ${entity?.displayName || entity?.name || 'the imported business'} as an S corp, sole proprietorship, partnership, personal spending, or not yours.`, CLASSIFY);
  }
  if (name === 'salary' && code === 'scorp_identity_missing') {
    const names = [...new Set(entities.map(e => e.displayName || e.name).filter(Boolean))];
    if (names.length) return reason(code, `Salary war game needs you to identify the S corp among ${names.join(', ')}.`, WARGAME_UNLOCKS.salary.scorp_identity_missing[1]);
  }
  const known = (WARGAME_UNLOCKS[name] || {})[code];
  if (known) return reason(code, `${game} ${known[0]}`, known[1]);
  // A tax code the household run blocked on: TAX1's fix for it, named in the sentence.
  let fix;
  try { fix = fixForCode(code); } catch { fix = null; }
  if (fix) return reason(code, `${game} is on hold until you ${lowerFirst(fix.label)}.`, fix);
  const [text, fallback] = WARGAME_UNLOCKS[name]?.inputs_changed || WARGAME_UNLOCKS.salary.inputs_changed;
  return reason(code, `${game} ${text}`, fallback);
}

// ---------------------------------------------------------------- salary (S3, T3, R6)

function salaryGame(data, out, ctx) {
  const { corp, parts, f, owner, contrib, ageOf, ageKey, retireMissing, householdTax, priorWages } = ctx;
  const invalid = code => { out.info.wargameInvalid.salary = code; return null; };
  if (parts.vaBlocked) return invalid(parts.vaBlocked);
  if (!corp) {
    const unclassified = ctx.entities?.find(e => !e.classified);
    return invalid(unclassified ? `entity_unclassified:${unclassified.slug}` : 'scorp_missing');
  }
  if (!(corp.P > 0)) return invalid('scorp_profit_missing');
  const c = contrib[corp.person];
  const range = owner['business.salaryRange'];
  const valid = range && typeof range === 'object' && Number.isFinite(range.min) && Number.isFinite(range.max) && range.min > 0 && range.max > 0;
  // R3-3: unknown outside deferrals leave every point's room unknown (IRC 402(g)(1)).
  const missing = [...(valid ? [] : ['business.salaryRange']), ...(ageOf(corp.person) == null ? [ageKey(corp.person)] : []),
    ...(c.outsideKnown ? [] : ['retirement.otherPlanDeferrals'])];
  if (missing.length) { out.info.confirm.salary = missing; return invalid(missing[0]); }
  // E7, E8, E10: each point carries three bases. The axis is cash salary (Medicare wages: payroll
  // tax and Additional Medicare). Taxable wages and plan compensation keep this year's signed gaps
  // to Medicare wages (box 1 - box 5 and compensation - box 5 for a W-2; for a P&L salary, the
  // owner's stated pretax deferrals and nothing), never clamped. Unknown compensation (box 12 unread)
  // leaves every point unknown.
  if (corp.comp == null) return invalid('w2_plan_compensation_unknown');
  const taxGap = corp.w2 ? cents(corp.w2.agi - corp.gross) : 0;
  const compGap = cents(corp.comp - corp.gross);
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

  // K2: a point whose tax run is blocked returns {blocked}. A contribution over its limit at that
  // salary (IRC 404(a)(3), 402(g), 415(c)) drops that point alone, listed under excluded with its
  // reason (H3); over the limit at the current salary, or any other block, makes the game invalid.
  const evaluate = s => out.safe('salaryPoint', () => {
    const pay = payrollTax({ wages: s, filingStatus: f, spouseMedicareWages: otherMedicare });
    const K = cents(P - s - pay.value.employerTotal);
    if (K < 0) return null;
    const comp = cents(s + compGap);
    const agi = cents(s + taxGap);
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
  const hardBlock = evaluated.find(p => p && p.blocked && (p.blocked !== OVER_LIMIT || (inRange && p.s === current)));
  if (hardBlock) return invalid(blockedCode(hardBlock.blocked));
  const over = evaluated.filter(p => p && p.blocked);
  const points = evaluated.filter(p => p && !p.blocked);
  // MG6: catch-up treatment unknown until last year's Social Security wages from the business are known.
  if (priorWages == null && points.some(p => p.room.value.catchUp > 0)) {
    out.info.confirm.salary = ['retirement.priorYearFicaWages'];
    return invalid('retirement.priorYearFicaWages');
  }
  if (points.length < 2) return invalid(over.length ? 'wargame_salary_contribution_over_limit' : 'salary_points_unavailable');
  let ref = inRange ? points.find(p => p.s === current) : null;
  if (!ref) ref = evaluate(clamp(round1000((lo + hi) / 2)));
  if (!ref) return invalid('salary_points_unavailable');
  if (ref.blocked) return invalid(blockedCode(ref.blocked));

  const pending = [
    ...(retireMissing.includes('retirement.planTermsConfirmed') ? ['plan_terms_pending'] : []),
    ...(retireMissing.includes('retirement.aggregationConfirmed') ? ['plan_aggregation_pending'] : []),
  ];
  const otherAssumed = Object.hasOwn(owner['retirement.otherPlanDeferralsInferred'] || {}, corp.person);
  const assumptions = [...(pending.length ? pending : [PLAN_TERMS]), ...(otherAssumed ? ['other_plan_deferrals_zero'] : [])];
  const content = [];
  for (const p of points) {
    const id = pointId(p.s);
    const y = cents(p.total - ref.total);
    const inputs = { salary: p.s, profitBeforeSalary: P, filingStatus: f, age,
      priorYearSponsorWages: priorWages, otherPlanDeferrals: owner['retirement.otherPlanDeferrals']?.[corp.person] };
    const loc = steps => ({ calc: 'salaryPoint', inputs, steps, assumptions });
    put(out, `wg.salary.${id}.salary`, p.s, 'Salary point: salary', loc([{ label: 'Salary', formula: 'grid point inside the approved range', value: p.s }]));
    put(out, `wg.salary.${id}.payroll`, p.payrollNet, 'Salary point: payroll tax', loc(stepsOf('Payroll tax', p.pay)));
    put(out, `wg.salary.${id}.dist`, p.K, 'Salary point: distributions', loc(p.steps.slice(0, p.pay.steps.length + 1)));
    put(out, `wg.salary.${id}.tax`, p.total, 'Salary point: total tax', loc(p.steps));
    const roomSteps = [...stepsOf('Solo 401(k) room', p.room), ...(p.roth > 0 ? [{ label: 'Roth catch-up room left out', formula: 'catch-up that must be Roth', value: p.roth }] : [])];
    put(out, `wg.salary.${id}.x`, p.x, 'Salary point: pre-tax retirement room', { ...loc(roomSteps), calc: 'solo401kRoom', assumptions: [...assumptions, ...rothCodes] });
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
  const excluded = over.map(p => {
    const id = pointId(p.s);
    put(out, `wg.salary.${id}.salary`, p.s, 'Salary point: salary', { calc: 'salaryPoint', inputs: { salary: p.s, profitBeforeSalary: P, filingStatus: f, age },
      steps: [{ label: 'Salary', formula: 'grid point inside the approved range', value: p.s }], assumptions });
    return { id, label: `Salary {fk:wg.salary.${id}.salary}`, invalid: OVER_LIMIT_TEXT.salary, fix: { ...WARGAME_UNLOCKS.salary.wargame_salary_contribution_over_limit[1] } };
  });
  const advisorWaits = retireMissing.filter(k => ['retirement.planTermsConfirmed', 'retirement.aggregationConfirmed'].includes(k)).map(advisorWait);
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
    entity: slug,
    // The S corp owner whose salary this models ('owner' | 'spouse'): the rec's action owner.
    person: corp.person,
    title: `What should you pay yourself in ${data.taxYear}?`,
    question: {
      in: 'Each point trades payroll tax against retirement room. The current salary is marked.',
      out: 'Each point trades payroll tax against retirement room. Your current salary is outside the approved range, so changes are measured against the middle of the range.',
      none: 'Each point trades payroll tax against retirement room. You have no officer salary yet this year, so changes are measured against the middle of the range.',
    }[outside],
    xLabel: 'Pre-tax retirement room',
    yLabel: inRange ? 'Tax change vs your current salary' : 'Tax change vs the middle of the range',
    points: content,
    ...(excluded.length ? { excluded } : {}),
    ...(advisorWaits.length ? { advisorWaits } : {}),
    takeaway: [takeaway + rothNote, ...notesFor([...pending, ...(otherAssumed ? ['other_plan_deferrals_zero'] : [])])].join(' '),
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
  // Out of season a kept game is not rebuilt, so an option now over its limit marks it unavailable.
  if (!deferralOffered(data, ctx.clock, valid.cashAccts)) return valid.excluded.length ? invalid('wargame_contribution_over_limit') : null;
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
  if (!b) return { invalid: 'business_income_missing' };
  const e = entities.find(x => x.slug === b.id);
  if (!e || !(e.sums.income > 0)) return { invalid: 'business_income_missing' };
  if (owner['business.cashBasis'] !== true) {
    if (owner['business.cashBasis'] == null) {
      return { invalid: 'business.cashBasis', ...(deferralSeason(data, ctx.clock) ? { confirm: ['business.cashBasis'] } : {}) };
    }
    return { invalid: 'accrual_basis' };
  }
  const bizAccts = accounts.filter(a => a.kind === 'business' && a.latest);
  const named = bizAccts.filter(a => a.entity && sameName(a.entity, e.name));
  const businesses = entities.filter(x => x.classified && x.lines.length);
  const cashAccts = named.length ? named : businesses.length === 1 ? bizAccts : [];
  if (!cashAccts.length) return { invalid: bizAccts.length ? 'business_account_unlinked' : 'business_account_missing' };

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
  // MG3, K2: every one of the seven tax runs must be complete and valid. An option whose runs put a
  // contribution over its limit is dropped alone and listed under excluded with its reason (H3); a
  // blocked base run, any other block, or no option left beside billing it all now makes the game invalid.
  const t26Base = T(shift(b.agi, 0));
  const t27Base = T(shift(base27, 0));
  const all = OPTIONS.map(o => ({ o, t26: T(shift(b.agi, -o.amount)), t27: T(shift(base27, o.amount)) }));
  const blocks = r => [r.t26, r.t27].filter(t => t.blocked).map(t => t.blocked);
  const hard = [t26Base, t27Base].find(t => t.blocked)?.blocked || all.flatMap(blocks).find(c => c !== OVER_LIMIT);
  if (hard) return { invalid: RETIREMENT_BLOCKS.has(hard) ? 'wargame_contribution_over_limit' : hard };
  const runs = all.filter(r => !blocks(r).length);
  const excluded = all.filter(r => blocks(r).length).map(({ o }) => ({ id: o.id, label: o.label, invalid: OVER_LIMIT_TEXT.deferral,
    fix: { ...WARGAME_UNLOCKS.deferral.wargame_contribution_over_limit[1] } }));
  if (runs.length < 2) return { invalid: 'wargame_contribution_over_limit' };
  return { b, e, A, cashAccts, next, base27, t26Base, t27Base, runs, excluded };
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
  // A decided salary brings its own employer payroll tax; otherwise the P&L projections stand.
  const monthlyPayroll = isCorp
    ? cents(((e.salaryDecided ? e.salaryAssumed : e.proj(e.sums.salary)) + (e.salaryDecided ? e.decidedPayrollTax : e.proj(e.sums.payrollTax))) / 12) : 0;
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
    // The owner of the business whose invoices this models ('owner' | 'spouse'): the rec's action owner.
    person: b.person,
    title: 'Invoice now or in January?',
    question: 'Moving December invoices into January shifts tax a year and leaves less business cash for December.',
    options,
    ...(valid.excluded.length ? { excluded: valid.excluded } : {}),
    takeaway: 'Deferring income moves tax into next year rather than removing it. Keep enough business cash to cover the December payroll.',
  };
}
