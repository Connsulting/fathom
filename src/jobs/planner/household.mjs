// Household liability and payroll inputs: the tax computation every figure, war game and safe
// harbor uses (base plan, R2, R3, R7, S1, S2, S6, T1, MG3, MG4, MG5), the payroll records and
// contributions by person it reads from documents and facts, and the self-employed retirement
// deduction worksheet.
//
// householdTax(parts) -> {agi, deduction, pre, qbi, qbiCarryforward, taxable, fedIncome, ctc, se,
//   seTotal, addlMedicare, retire, retireByBiz, fedTotal, va, vaTaxable, blocked, steps, warnings};
//   a run whose retirement contributions fail validation returns only {blocked, steps, warnings}
// parts: {f, state, persons, w2: [{person, src, gross, agi}], biz: [{id, kind, person, agi, qbi,
//   seInput, w2Wages, sstb}], retirement: {person: {byPlan, allRegular, allCatchUp, outsideKnown,
//   catchUpLimit}}, hsaPersonal, itemized, vaItemized, va529Deduction, children, vaBlocked,
//   qbiLossCarryforward?}
// RETIREMENT_BLOCKS: the blocked codes householdTax reports for retirement contributions
// seTaxByPerson(parts) -> {se: {person: selfEmploymentTax value}, dhByBiz: {bizId: deductible half}, steps}
// seRetirementWorksheet(inputs) -> {over: false, deduction, s3, steps} | {over: true, failed, steps}
// employerPaid(plan) -> employer plus SEP contributions already made to one sponsor's plans
// planInputs(person, plan) -> the room calculators' plan aggregate inputs for one sponsor
// attributeContributions(owner, businesses) -> {entries: [{...entry, sponsor: {kind, slug}}], unattributed}
// recordedTypes(sources, person, slug) -> Set of contribution types records already carry
// contributions(records, corps, attributed, owner) -> {owner|spouse: {allRegular, allCatchUp, all401k,
//   outsideKnown, byPlan: {slug: {deferral, catchUp, roth, employer, sep}}, ira}}

import { federalIncomeTax, payrollTax, selfEmploymentTax, qbiDeduction, virginiaIncomeTax, employerLimit, TAX_2026 } from '../../calc/index.mjs';
import { cents } from '../../store/db.mjs';
import { sameName, monthOf, yearOf, sum } from './data.mjs';
import { law, stdDeduction, vaStdDeduction } from './law.mjs';

export const stepsOf = (prefix, env) => (env && Array.isArray(env.steps) ? env.steps.map(s => ({ ...s, label: `${prefix}: ${s.label}` })) : []);
export const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));

// ---------------------------------------------------------------- self-employment tax (R3-6)

// SE tax per person and the deductible half apportioned to each business by its SE input. Computed
// on net earnings before any plan contribution (Schedule SE), so retirement sizing can use it even
// when household tax is blocked.
export function seTaxByPerson(parts) {
  const { f, persons } = parts;
  const mfj = f === 'mfj';
  const steps = [];
  const wagesOf = p => sum(parts.w2.filter(w => w.person === p).map(w => w.gross));
  const se = {};
  const dhByBiz = {};
  let priorSe = 0;
  for (const p of persons) {
    const bizs = parts.biz.filter(b => b.person === p && b.kind !== 'scorp' && b.seInput != null);
    const input = cents(Math.max(0, sum(bizs.map(b => b.seInput))));
    if (!(input > 0)) continue;
    const other = persons.filter(q => q !== p).reduce((s, q) => s + wagesOf(q), 0);
    const env = selfEmploymentTax({
      netProfit: input, filingStatus: f, w2SocialSecurityWages: wagesOf(p), w2MedicareWages: wagesOf(p),
      spouseMedicareWages: mfj ? cents(other + priorSe) : 0,
    });
    se[p] = env.value;
    priorSe += env.value.taxableEarnings;
    steps.push(...stepsOf(`Self-employment tax (${p})`, env));
    const positive = bizs.filter(b => b.seInput > 0);
    const total = positive.reduce((s, b) => s + b.seInput, 0);
    let left = env.value.deductibleHalf;
    positive.forEach((b, i) => {
      const share = i === positive.length - 1 ? left : cents(env.value.deductibleHalf * b.seInput / total);
      dhByBiz[b.id] = share;
      left = cents(left - share);
    });
  }
  return { se, dhByBiz, steps };
}

// ---------------------------------------------------------------- household liability

export function householdTax(parts) {
  const { f, persons } = parts;
  const mfj = f === 'mfj';
  const steps = [];
  const warnings = [];
  const wagesOf = p => sum(parts.w2.filter(w => w.person === p).map(w => w.gross));

  const seInfo = seTaxByPerson(parts);
  const { se, dhByBiz } = seInfo;
  steps.push(...seInfo.steps);

  let addlMedicare = 0;
  const wagePeople = persons.filter(p => wagesOf(p) > 0);
  if (wagePeople.length) {
    let before = 0;
    for (const p of wagePeople) {
      const env = payrollTax({ wages: wagesOf(p), filingStatus: f, spouseMedicareWages: mfj ? before : 0 });
      addlMedicare = cents(addlMedicare + env.value.additionalMedicare);
      before = cents(before + wagesOf(p));
    }
    if (addlMedicare > 0) steps.push({ label: 'Additional Medicare on wages', formula: 'household wages above the filing threshold * rate', value: addlMedicare });
  }

  // K2: every run validates the retirement contributions against its own income and blocks when
  // any is over its limit or depends on unknown inputs; the deduction comes from that validation.
  const plans = retirementPlans(parts, dhByBiz);
  steps.push(...plans.steps);
  if (plans.blocked) return { blocked: plans.blocked, steps, warnings };
  const retireByBiz = plans.byBiz;
  const biz = parts.biz.map(b => ({ ...b, retire: retireByBiz[b.id] || 0 }));

  // MG5: the self-employed plan deduction (IRC 62(a)(6), 404) is above the line, once.
  const dhTotal = cents(Object.values(se).reduce((s, v) => s + v.deductibleHalf, 0));
  const retire = cents(sum(biz.map(b => b.retire)));
  if (retire > 0) steps.push({ label: 'Self-employed retirement deduction', formula: 'deductible plan contributions for self-employed businesses', value: retire });
  const agi = cents(sum(parts.w2.map(w => w.agi)) + sum(biz.map(b => b.agi)) - dhTotal - retire - (parts.hsaPersonal || 0));
  steps.push({ label: 'Adjusted gross income', formula: 'wages + business income - deductible half of SE tax - self-employed retirement deduction - personal HSA contributions', value: agi });
  const deduction = Math.max(stdDeduction(f), parts.itemized || 0);
  const pre = Math.max(0, cents(agi - deduction));
  steps.push({ label: 'Deduction', formula: 'greater of the standard deduction and your itemized estimate', value: deduction });

  const q = qbiComponent({ ...parts, biz }, { pre, dhByBiz });
  steps.push(...q.steps);
  if (q.carryforward > 0) warnings.push('qbi_loss_carryforward');
  const qbi = q.qbi;
  const taxable = cents(Math.max(0, pre - qbi));
  const fedEnv = federalIncomeTax({ taxableIncome: taxable, filingStatus: f });
  const fedIncome = fedEnv.value;
  steps.push(...stepsOf('Federal income tax', fedEnv));

  // MG3: IRC 24(b)(1), (h)(3): 50 per 1,000 (or fraction) of MAGI over the threshold, not below
  // zero. MAGI is taken as AGI. The refundable part (24(d)) is not modeled, so a credit above income
  // tax blocks the result.
  let ctc = 0;
  let blocked = null;
  if (parts.children > 0) {
    const threshold = mfj ? law('ctcThresholdMfj') : law('ctcThresholdOther');
    const tentative = cents(parts.children * law('ctcPerChild'));
    const excessCents = Math.round((agi - threshold) * 100);
    const stepCents = Math.round(law('ctcPhaseOutStep') * 100);
    const count = excessCents > 0 ? Math.ceil(excessCents / stepCents) : 0;
    const reduction = cents(count * law('ctcPhaseOutReduction'));
    const allowed = Math.max(0, cents(tentative - reduction));
    if (allowed > fedIncome) { blocked = 'ctc_refundable_unsupported'; ctc = fedIncome; } else ctc = allowed;
    steps.push({ label: 'Child tax credit before phase-out', formula: 'credit per child under seventeen * children', value: tentative });
    steps.push({ label: 'Phase-out reduction', formula: 'fifty per thousand, or part of a thousand, of income over the threshold', value: reduction });
    steps.push({ label: 'Child tax credit', formula: 'credit before phase-out - reduction, not below zero, limited to income tax', value: ctc });
  }
  const seTotal = cents(Object.values(se).reduce((s, v) => s + v.total, 0));
  const fedTotal = cents(fedIncome - ctc + seTotal + addlMedicare);
  steps.push({ label: 'Federal total', formula: 'income tax - child credit + SE tax + Additional Medicare on wages', value: fedTotal });

  let va = null;
  let vaTaxable = null;
  if (parts.state === 'VA' && !parts.vaBlocked) {
    const vaDeduction = parts.vaItemized != null ? parts.vaItemized : vaStdDeduction(f);
    vaTaxable = Math.max(0, cents(agi - vaDeduction - (parts.va529Deduction || 0)));
    const vaEnv = virginiaIncomeTax({ taxableIncome: vaTaxable });
    va = vaEnv.value;
    steps.push(...stepsOf('Virginia income tax', vaEnv));
  }
  return {
    agi, deduction, pre, qbi, qbiCarryforward: q.carryforward, taxable, fedIncome, ctc, se, seTotal, addlMedicare, retire, retireByBiz,
    fedTotal, va, vaTaxable, blocked, steps, warnings,
  };
}

// MG4, R2-1: Treas. Reg. 1.199A-1(d)(2) in order: the SSTB applicable percentage first (QBI and
// wages), then netting (negative QBI, including a prior-year carryforward, apportioned to positive
// businesses by their QBI; loss businesses' wages ignored), then the per-business deduction and its
// limits, the 20 percent of taxable income cap, and the 199A(i) minimum once per return.
function qbiComponent(parts, { pre, dhByBiz }) {
  const Q = TAX_2026.qbi;
  const f = parts.f;
  const steps = [];
  const phase = Math.min(1, Math.max(0, pre - Q.threshold[f]) / Q.phaseIn[f]);
  const items = parts.biz.filter(b => b.qbi != null).map(b => {
    const q = cents(b.qbi - (dhByBiz[b.id] || 0) - b.retire);
    const applicable = b.sstb ? 1 - phase : 1;
    const e = cents(q * applicable) || 0;
    steps.push({ label: `QBI (${b.id}): applicable percentage`, formula: b.sstb ? 'specified service business: one - phase-in share' : 'not a specified service business: all of it', value: cents(applicable * 100) });
    steps.push({ label: `QBI (${b.id}): qualified amount`, formula: '(business income - deductible half of SE tax - SE retirement deduction) * applicable percentage', value: e });
    return { b, e, wages: cents((b.w2Wages || 0) * applicable) };
  });
  const carry = Math.max(0, num(parts.qbiLossCarryforward));
  const pos = items.filter(i => i.e > 0);
  const posSum = cents(sum(pos.map(i => i.e)));
  const negSum = cents(sum(items.filter(i => i.e < 0).map(i => i.e)) - carry);
  const total = cents(posSum + negSum);
  if (carry > 0) steps.push({ label: 'QBI loss carried from last year', formula: 'prior-year qualified business loss carryforward', value: carry });
  let qbiSum = 0;
  let carryforward = 0;
  if (total <= 0) {
    carryforward = cents(-total);
    if (carryforward > 0) steps.push({ label: 'Net qualified business income is a loss; it carries to next year', formula: 'positive QBI + negative QBI', value: total });
  } else {
    let used = 0;
    pos.forEach((i, idx) => {
      const share = idx === pos.length - 1 ? cents(total - used) : cents(i.e + negSum * i.e / posSum);
      used = cents(used + share);
      const env = qbiDeduction({ qbi: share, taxableIncome: pre, filingStatus: f, w2Wages: i.wages, isSstb: false, activeBusiness: false });
      qbiSum = cents(qbiSum + env.value);
      steps.push({ label: `QBI (${i.b.id}): after netting losses`, formula: 'qualified amount + share of negative QBI in proportion to positive QBI', value: share });
      steps.push(...stepsOf(`QBI (${i.b.id})`, env));
    });
  }
  let qbi = cents(Math.min(qbiSum, Q.rate * pre));
  if (total >= Q.activeMinimumIncome) qbi = Math.max(qbi, Q.activeMinimumDeduction);
  steps.push({ label: 'QBI deduction', formula: 'sum of business deductions, capped at the rate times taxable income before QBI, with the active-business minimum when qualified QBI meets its threshold', value: qbi });
  return { qbi, carryforward, steps };
}

// ---------------------------------------------------------------- self-employed plan worksheet (R2-3, R3-2)

// IRS Publication 560 chapter 5, Deduction Worksheet for Self-Employed, applied to the actual mix:
// E employer (SEP included), D this plan's regular deferrals and K its catch-ups (Roth included),
// OD and OK the person's deferrals in other plans. IRC 402(g)(1), 414(v)(2)(A), 414(v)(3)(A),
// 415(c)(1). Plan rate assumed at the maximum (D6, plan_rate_max).
export function seRetirementWorksheet({
  netProfit, seDeduction, employer = 0, deferral = 0, catchUp = 0, roth = 0, otherDeferrals = 0, otherCatchUp = 0, catchUpLimit = 0,
}) {
  const R = TAX_2026.retirement;
  const E = num(employer);
  const D = num(deferral);
  const K = num(catchUp);
  const s3 = cents(num(netProfit) - num(seDeduction));
  // Steps 7, 10, 12 and 13 come from the shared employer worksheet (K1).
  const s9 = Math.min(D, R.employeeDeferral);
  const lim = employerLimit({ kind: 'self-employed', compensation: Math.max(0, s3), regular: s9, catchUp: K });
  const s13 = lim.s13;
  const s14 = cents(s3 - s13);
  const s15 = Math.min(s9, s14);
  const s16 = cents(s14 - s15);
  const s18 = Math.min(s16, K);
  const s19 = cents(s13 + s15 + s18);
  const s21 = cents(s19 - num(roth));
  const deduction = cents(E + D + K - num(roth));
  const steps = [
    { label: 'Worksheet step three: net profit less deductible half of SE tax', formula: 'net profit - deductible half of SE tax', value: s3 },
    { label: 'Worksheet step seven: employer limit', formula: 'min(step three * reduced plan rate, compensation limit * plan rate)', value: lim.s7 },
    { label: 'Worksheet step thirteen: employer maximum', formula: 'min(step seven, annual additions - deferrals, half of step three less deferrals)', value: s13 },
    { label: 'Worksheet step twenty-one: maximum deductible contribution', formula: 'employer maximum + deferrals + catch-ups that fit - Roth amounts', value: s21 },
  ];
  const tol = 0.005;
  const le = (x, y) => x <= y + tol;
  const checks = [
    ['employer within the employer maximum', le(E, s13)],
    ['employer within the annual additions limit', le(E, R.annualAdditions - D)],
    ['employer within half of compensation after deferrals', le(E, (s3 - D) / 2)],
    ['deferrals within compensation after the employer contribution', le(D, s3 - E)],
    ['catch-up within compensation after funding', le(K, s3 - E - D)],
    ['deferrals across plans within the deferral limit', le(D + num(otherDeferrals), R.employeeDeferral)],
    ['catch-up across plans within its limit', le(K + num(otherCatchUp), num(catchUpLimit))],
    ['deduction within the worksheet maximum', le(deduction, s21)],
  ];
  const failed = (E > 0 || D > 0 || K > 0) ? checks.find(([, ok]) => !ok) : null;
  if (failed) return { over: true, failed: failed[0], steps };
  steps.push({ label: 'Deductible contribution', formula: 'employer + deferrals + catch-ups - Roth amounts', value: deduction });
  return { over: false, deduction, s3, steps };
}

export const RETIREMENT_BLOCKS = Object.freeze(new Set(['retirement_contribution_over_limit', 'retirement_other_deferrals_missing']));

// K2: retirement contributions validated for one tax run. Each person's plan aggregate per sponsor:
// a sole proprietorship or partnership plan runs the Publication 560 worksheet on that business's
// net profit and deductible half of SE tax in this run (its deduction is above the line, IRC
// 62(a)(6), 404(a)(8)); an S corp plan (or any sponsor paying W-2 wages) is held to the shared
// employer maximum on the W-2 wages from that sponsor in this run (IRC 404(a)(3)(A)(i), 415(c)),
// deferrals within those wages, and, when the person's other deferrals are known, the 402(g) and
// catch-up limits across plans. Elective contributions to a self-employed plan with unknown other
// deferrals block the run, since the deduction depends on them.
function retirementPlans(parts, dhByBiz) {
  const R = TAX_2026.retirement;
  const byBiz = {};
  const steps = [];
  const tol = 0.005;
  const le = (x, y) => x <= y + tol;
  for (const p of parts.persons) {
    const c = parts.retirement && parts.retirement[p];
    if (!c) continue;
    for (const [slug, plan] of Object.entries(c.byPlan || {})) {
      const E = employerPaid(plan);
      const D = num(plan.deferral);
      const K = num(plan.catchUp);
      if (!(E > 0 || D > 0 || K > 0)) continue;
      const b = parts.biz.find(x => x.id === slug && x.person === p);
      if (b && b.kind !== 'scorp') {
        if ((D > 0 || K > 0) && !c.outsideKnown) return { blocked: 'retirement_other_deferrals_missing', steps };
        const ws = seRetirementWorksheet({
          netProfit: b.seInput ?? 0, seDeduction: dhByBiz[b.id] || 0, employer: E, deferral: D, catchUp: K, roth: plan.roth,
          otherDeferrals: cents(c.allRegular - D), otherCatchUp: cents(c.allCatchUp - K), catchUpLimit: c.catchUpLimit,
        });
        steps.push(...ws.steps.map(st => ({ ...st, label: `Self-employed plan (${b.id}): ${st.label}` })));
        if (ws.over) return { blocked: 'retirement_contribution_over_limit', steps };
        byBiz[b.id] = ws.deduction;
        continue;
      }
      const wages = cents(sum(parts.w2.filter(w => w.person === p && (w.src === `corp:${slug}` || w.src === `corp:${slug}:${p}`)).map(w => w.gross)));
      const lim = employerLimit({ kind: 'w2', compensation: wages, regular: D, catchUp: K });
      steps.push(...lim.steps.map(st => ({ ...st, label: `Employer plan (${slug}): ${st.label}`, formula: `${st.formula}, on this run's wages` })));
      const ok = le(E, lim.limit) && le(D + K, wages)
        && (!c.outsideKnown || (le(c.allRegular, R.employeeDeferral) && le(c.allCatchUp, c.catchUpLimit)));
      if (!ok) return { blocked: 'retirement_contribution_over_limit', steps };
    }
  }
  return { byBiz, steps };
}

// Employer contributions already made to a sponsor's plans (MG5, C1): a SEP and a 401(k) of the same
// business share one employer limit (Pub 560 deduction limit for multiple plans; IRC 404(a)(7),
// 415(f)), so every room and worksheet check counts both.
export const employerPaid = plan => cents(num(plan && plan.employer) + num(plan && plan.sep));

// K1: the whole plan aggregate for one sponsor, as every room calculator takes it: the person's
// deferrals across all plans, this sponsor's deferrals and catch-ups, and its employer and SEP
// contributions together.
export function planInputs(person, plan) {
  const pl = plan || {};
  return {
    allPlanDeferrals: person.all401k, thisPlanDeferrals: cents(num(pl.deferral) + num(pl.catchUp)),
    thisPlanCatchUp: num(pl.catchUp), employerContributions: employerPaid(pl),
  };
}

// Catch-up limit by age (IRC 414(v)(2)(B), Notice 2025-67); unknown age allows none.
export function catchUpLimitFor(age) {
  const R = TAX_2026.retirement;
  if (typeof age !== 'number' || !Number.isFinite(age) || age < R.catchUpAge) return 0;
  return age >= R.enhancedCatchUpStart && age <= R.enhancedCatchUpEnd ? R.enhancedCatchUp : R.catchUp;
}

// ---------------------------------------------------------------- payroll records (R3, S6)

export function payrollRecords(data, entities, out) {
  const groups = new Map();
  for (const d of data.documents) {
    if (d.docType !== 'w2' && d.docType !== 'paystub') continue;
    const fl = d.fields;
    const docYear = d.docType === 'paystub' && fl.periodEnd ? yearOf(fl.periodEnd) : d.taxYear;
    if (docYear != null && Number(docYear) !== data.taxYear) continue;
    let person = fl.person;
    if (person !== 'owner' && person !== 'spouse') { person = 'owner'; out.warn('person_assumed'); }
    const employer = String(fl.employer ?? '').trim();
    const key = `${person}|${employer.toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...d, person, employer });
  }
  const records = [];
  for (const docs of groups.values()) {
    const w2 = docs.filter(d => d.docType === 'w2').at(-1);
    const auth = w2 || docs.filter(d => d.docType === 'paystub').sort((a, b) => String(a.fields.periodEnd ?? '').localeCompare(String(b.fields.periodEnd ?? '')) || a.id - b.id).at(-1);
    const fl = auth.fields;
    const isW2 = auth.docType === 'w2';
    const factor = isW2 ? 1 : 12 / (monthOf(fl.periodEnd || '') || 12);
    const proj = v => cents(num(v) * factor);
    const r = {
      docId: auth.id, fileId: auth.fileId, person: auth.person, employer: auth.employer, kind: auth.docType,
      wages: isW2 ? num(fl.wages) : proj(fl.wagesYtd), ytdWages: isW2 ? num(fl.wages) : num(fl.wagesYtd),
      deferral: isW2 ? num(fl.deferral401k) : proj(fl.deferral401kYtd),
      deferralKnown: isW2 ? isAmount(fl.deferral401k) : isAmount(fl.deferral401kYtd),
      catchUp: isW2 ? num(fl.catchUp401k) : proj(fl.catchUp401kYtd),
      roth: isW2 ? num(fl.roth401k) : proj(fl.roth401kYtd),
      fedWithheld: num(isW2 ? fl.federalWithheld : fl.federalWithheldYtd),
      stateWithheld: num(isW2 ? fl.stateWithheld : fl.stateWithheldYtd),
      addlWithheld: num(isW2 ? fl.additionalMedicareWithheld : fl.additionalMedicareWithheldYtd ?? fl.additionalMedicareWithheld),
      hsa: num(isW2 ? fl.hsaEmployer : fl.hsaYtd),
    };
    r.pretax = Math.max(0, cents(r.deferral + r.catchUp - r.roth));
    const corp = entities.find(e => e.classified && e.type === 's_corp' && sameName(e.name, r.employer));
    r.corp = corp ? corp.slug : null;
    r.household = !!corp || entities.some(e => sameName(e.name, r.employer));
    records.push(r);
  }
  return records;
}

// R3: a deferral field counts as known only when the document carries it as a number.
function isAmount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// ---------------------------------------------------------------- contributions (R2-2, R3-1)

const contributionEntries = owner => (Array.isArray(owner['retirement.contributions']) ? owner['retirement.contributions'] : [])
  .filter(c => c && typeof c === 'object' && (c.person === 'owner' || c.person === 'spouse') && isAmount(Number(c.amount)) && c.amount !== null && c.amount !== '');

// The only reader of retirement.contributions. businesses: [{kind: 'scorp' | 'sole' | 'partnership',
// slug, name, person}]. An own-plan or SEP entry belongs to the business its `entity` names (slug
// or name) among the person's businesses, else to the person's only business; otherwise it is
// unattributed.
export function attributeContributions(owner, businesses) {
  const entries = [];
  const unattributed = [];
  for (const c of contributionEntries(owner)) {
    if (c.plan === 'ira') { entries.push({ ...c, sponsor: { kind: 'ira', slug: null } }); continue; }
    if (c.plan === 'outside-401k') { entries.push({ ...c, sponsor: { kind: 'outside', slug: null } }); continue; }
    if (c.plan !== 'own-corp-401k' && c.plan !== 'sep') continue;
    const mine = businesses.filter(b => b.person === c.person);
    const entity = typeof c.entity === 'string' ? c.entity.trim() : '';
    const named = entity ? mine.filter(b => b.slug === entity || sameName(b.name, entity)) : null;
    const sponsor = named ? (named.length === 1 ? named[0] : null) : mine.length === 1 ? mine[0] : null;
    if (sponsor) entries.push({ ...c, sponsor: { kind: sponsor.kind, slug: sponsor.slug } });
    else unattributed.push(c);
  }
  return { entries, unattributed };
}

// K4, the one precedence table for fact-versus-record reads: documents and P&L records win. An
// owner fact of a contribution type already recorded for that person and sponsor is skipped:
//   deferral  payroll documents (W-2 or paystub) from the sponsor carrying deferrals or Roth deferrals
//   catchup   payroll documents from the sponsor carrying catch-ups
//   employer  P&L employer contribution lines of the sponsor; a SEP is the same type
// Prior-year Social Security wages follow the same rule (priorFicaWages in figures.mjs).
// sources: {records, corps}.
export function recordedTypes({ records, corps = [] }, person, slug) {
  const docs = records.filter(r => r.person === person && r.corp === slug);
  const types = new Set();
  if (docs.some(r => r.deferral > 0 || r.roth > 0)) types.add('deferral');
  if (docs.some(r => r.catchUp > 0)) types.add('catchup');
  if (corps.some(c => c.person === person && c.entity.slug === slug && c.sums.employer401k > 0)) types.add('employer');
  return types;
}

const elective = c => c.type === 'deferral' || c.type === 'catchup';
const factType = c => (c.plan === 'sep' || c.type === 'employer' ? 'employer' : c.type);

// Pre-tax owner-set deferrals to S corp `slug` that its payroll documents do not carry (I1). Roth
// records never lower wages.
export function factPretax(attributed, sources, person, slug) {
  const recorded = recordedTypes(sources, person, slug);
  return cents(sum(attributed.entries.filter(c => c.person === person && c.plan === 'own-corp-401k' && c.sponsor.kind === 'scorp'
    && c.sponsor.slug === slug && elective(c) && !recorded.has(c.type) && c.roth !== true).map(c => Number(c.amount))));
}

export function contributions(records, corps, attributed, owner) {
  const otherFact = owner['retirement.otherPlanDeferrals'];
  const out = {};
  for (const p of ['owner', 'spouse']) {
    const mine = records.filter(r => r.person === p);
    const household = mine.filter(r => r.household);
    const outside = mine.filter(r => !r.household);
    const facts = attributed.entries.filter(c => c.person === p);
    const amt = c => Number(c.amount);
    const byPlan = {};
    const plan = slug => (byPlan[slug] ||= { deferral: 0, catchUp: 0, roth: 0, employer: 0, sep: 0 });
    for (const r of household.filter(x => x.corp)) {
      const b = plan(r.corp);
      b.deferral += r.deferral; b.catchUp += r.catchUp; b.roth += r.roth;
    }
    for (const c of corps.filter(x => x.person === p)) plan(c.entity.slug).employer += c.sums.employer401k;
    for (const c of facts) {
      const s = c.sponsor;
      if (s.kind === 'ira' || s.kind === 'outside') continue;
      if (factType(c) !== 'employer' && !elective(c)) continue;
      if (recordedTypes({ records, corps }, p, s.slug).has(factType(c))) continue;
      const b = plan(s.slug);
      if (c.plan === 'sep') { b.sep += amt(c); continue; }
      if (c.type === 'employer') { b.employer += amt(c); continue; }
      if (c.type === 'deferral') b.deferral += amt(c); else b.catchUp += amt(c);
      if (c.roth === true) b.roth += amt(c);
    }
    for (const b of Object.values(byPlan)) for (const k of Object.keys(b)) b[k] = cents(b[k]);

    // Other-plan deferrals (R2-3 item 3, R3-1 item 2, D8): known only from a numeric document field,
    // a fact naming the employer, or the retirement.otherPlanDeferrals fact (which replaces them).
    // C4: a fact that is present but fails validation leaves them unknown; it never falls through
    // to the documents as if nothing had been stated.
    let outsideKnown = true;
    let outRegular = 0;
    let outCatch = 0;
    const factObject = otherFact && typeof otherFact === 'object' && !Array.isArray(otherFact);
    const of = factObject ? otherFact[p] : undefined;
    if (otherFact != null && (!factObject || of != null)) {
      if (of && typeof of === 'object' && isAmount(of.deferral) && (of.catchUp == null || isAmount(of.catchUp))) {
        outRegular = of.deferral;
        outCatch = of.catchUp || 0;
      } else {
        outsideKnown = false;
      }
    } else {
      const oFacts = facts.filter(c => c.sponsor.kind === 'outside' && elective(c));
      const employerOf = c => (typeof c.employer === 'string' ? c.employer.trim() : '');
      for (const r of outside) {
        if (r.deferralKnown) { outRegular += r.deferral; outCatch += r.catchUp; } else if (!oFacts.some(c => employerOf(c) && sameName(employerOf(c), r.employer))) outsideKnown = false;
      }
      for (const c of oFacts) {
        if (employerOf(c)) {
          const rec = outside.find(r => sameName(employerOf(c), r.employer));
          if (rec && rec.deferralKnown) continue;
        } else if (outside.length) { outsideKnown = false; continue; }
        if (c.type === 'deferral') outRegular += amt(c); else outCatch += amt(c);
      }
    }
    const plans = Object.values(byPlan);
    const loose = household.filter(r => !r.corp);
    const allRegular = cents(sum(plans.map(b => b.deferral)) + sum(loose.map(r => r.deferral)) + outRegular);
    const allCatchUp = cents(sum(plans.map(b => b.catchUp)) + sum(loose.map(r => r.catchUp)) + outCatch);
    out[p] = {
      allRegular, allCatchUp, all401k: cents(allRegular + allCatchUp), outsideKnown, byPlan,
      ira: cents(sum(facts.filter(c => c.sponsor.kind === 'ira').map(amt))),
    };
  }
  return out;
}
