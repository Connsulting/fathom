// Household liability and payroll inputs: the tax computation every figure, war game and safe
// harbor uses (base plan, R2, R3, R7, S1, S2, S6, T1), and the payroll records and contributions
// by person it reads from documents and facts.
//
// householdTax(parts) -> {agi, deduction, pre, qbi, taxable, fedIncome, ctc, se, seTotal, addlMedicare,
//   fedTotal, va, vaTaxable, steps, warnings}
// parts: {f, state, persons, w2: [{person, src, gross, agi}], biz: [{id, kind, person, agi, qbi,
//   seInput, w2Wages, sstb}], hsaPersonal, itemized, vaItemized, va529Deduction, children, vaBlocked}

import { federalIncomeTax, payrollTax, selfEmploymentTax, qbiDeduction, virginiaIncomeTax } from '../../calc/index.mjs';
import { cents } from '../../store/db.mjs';
import { sameName, monthOf, yearOf, sum } from './data.mjs';
import { law, stdDeduction, vaStdDeduction } from './law.mjs';

export const stepsOf = (prefix, env) => (env && Array.isArray(env.steps) ? env.steps.map(s => ({ ...s, label: `${prefix}: ${s.label}` })) : []);
export const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));

// ---------------------------------------------------------------- household liability

// parts: {f, state, persons, w2: [{person, src, gross, agi}], biz: [{id, kind, person, agi, qbi,
// seInput, w2Wages, sstb}], hsaPersonal, itemized, vaItemized, va529Deduction, children, vaBlocked}
export function householdTax(parts, ctx = {}) {
  const { f, persons } = parts;
  const mfj = f === 'mfj';
  const steps = [];
  const warnings = [];
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

  const dhTotal = cents(Object.values(se).reduce((s, v) => s + v.deductibleHalf, 0));
  const agi = cents(sum(parts.w2.map(w => w.agi)) + sum(parts.biz.map(b => b.agi)) - dhTotal - (parts.hsaPersonal || 0));
  steps.push({ label: 'Adjusted gross income', formula: 'wages + business income - deductible half of SE tax - personal HSA contributions', value: agi });
  const deduction = Math.max(stdDeduction(f), parts.itemized || 0);
  const pre = Math.max(0, cents(agi - deduction));
  steps.push({ label: 'Deduction', formula: 'greater of the standard deduction and your itemized estimate', value: deduction });

  let qbiSum = 0;
  for (const b of parts.biz) {
    if (b.qbi == null) continue;
    const q = Math.max(0, cents(b.qbi - (dhByBiz[b.id] || 0)));
    const env = qbiDeduction({ qbi: q, taxableIncome: pre, filingStatus: f, w2Wages: b.w2Wages || 0, isSstb: b.sstb, activeBusiness: true });
    qbiSum += env.value;
    steps.push(...stepsOf(`QBI (${b.id})`, env));
  }
  const qbi = cents(Math.min(qbiSum, 0.2 * pre));
  const taxable = cents(Math.max(0, pre - qbi));
  const fedEnv = federalIncomeTax({ taxableIncome: taxable, filingStatus: f });
  const fedIncome = fedEnv.value;
  steps.push(...stepsOf('Federal income tax', fedEnv));

  let ctc = 0;
  if (parts.children > 0) {
    const threshold = mfj ? law('ctcThresholdMfj') : law('ctcThresholdOther');
    if (agi <= threshold) ctc = Math.min(parts.children * law('ctcPerChild'), fedIncome);
    else warnings.push('ctc_phaseout_unsupported');
    steps.push({ label: 'Child tax credit', formula: 'credit per child under seventeen, limited to income tax', value: ctc });
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
  return { agi, deduction, pre, qbi, taxable, fedIncome, ctc, se, seTotal, addlMedicare, fedTotal, va, vaTaxable, steps, warnings };
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

export function contributions(persons, records, corps, owner) {
  const facts = Array.isArray(owner['retirement.contributions']) ? owner['retirement.contributions'] : [];
  const out = {};
  for (const p of ['owner', 'spouse']) {
    const mine = records.filter(r => r.person === p);
    const own = mine.filter(r => r.corp);
    const fx = facts.filter(c => c && c.person === p && Number.isFinite(Number(c.amount)));
    const fsum = test => sum(fx.filter(test).map(c => Number(c.amount)));
    const is401k = c => c.plan === 'own-corp-401k' || c.plan === 'outside-401k';
    const elective = c => c.type === 'deferral' || c.type === 'catchup';
    out[p] = {
      all401k: cents(sum(mine.map(r => r.deferral + r.catchUp)) + fsum(c => is401k(c) && elective(c))),
      thisPlan: cents(sum(own.map(r => r.deferral + r.catchUp)) + fsum(c => c.plan === 'own-corp-401k' && elective(c))),
      thisCatchUp: cents(sum(own.map(r => r.catchUp)) + fsum(c => c.plan === 'own-corp-401k' && c.type === 'catchup')),
      employer: cents(sum(corps.filter(c => c.person === p).map(c => c.sums.employer401k)) + fsum(c => c.plan === 'own-corp-401k' && c.type === 'employer')),
      sep: fsum(c => c.plan === 'sep' && c.type === 'employer'),
      ira: fsum(c => c.plan === 'ira'),
    };
  }
  return out;
}
