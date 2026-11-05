// Statutory constants the planner uses, each cited: `pack`/`entry` name the reviewed pack entry
// whose text states the amount, or `calc` names the TAX_2026 parameter path.
// lawContent() and pctContent() are the brief's `law` and `pct` content rows.

import { TAX_2026 } from '../../calc/index.mjs';
import { cents } from '../../store/db.mjs';

const pack = (v, label, packId, entry) => Object.freeze({ v, label, pack: packId, entry });
const calc = (v, label, path) => Object.freeze({ v, label, calc: path });

export const LAW = Object.freeze({
  stdDeductionMfj: pack(32200, 'Standard deduction, married filing jointly', 'charitable-giving', 'bunching'),
  stdDeductionSingle: pack(16100, 'Standard deduction, single', 'charitable-giving', 'bunching'),
  stdDeductionHoh: pack(24150, 'Standard deduction, head of household', 'charitable-giving', 'bunching'),
  vaStdDeductionMfj: pack(17500, 'Virginia standard deduction, married filing jointly', 'virginia-resident', 'standard-itemized'),
  vaStdDeductionSingle: pack(8750, 'Virginia standard deduction, single', 'virginia-resident', 'standard-itemized'),
  va529Cap: pack(4000, 'Virginia529 deduction per account', 'virginia-resident', 'virginia529-deduction'),
  iraLimit: pack(7500, 'IRA contribution limit', 'advanced-retirement', 'ira-eligibility'),
  iraCatchUp: pack(1100, 'IRA catch-up contribution', 'advanced-retirement', 'backdoor-roth'),
  rothPhaseOutStartMfj: pack(242000, 'Roth IRA phase-out start, married filing jointly', 'advanced-retirement', 'ira-eligibility'),
  rothPhaseOutEndMfj: pack(252000, 'Roth IRA phase-out end, married filing jointly', 'advanced-retirement', 'ira-eligibility'),
  rothPhaseOutStartSingle: pack(153000, 'Roth IRA phase-out start, single', 'advanced-retirement', 'ira-eligibility'),
  rothPhaseOutEndSingle: pack(168000, 'Roth IRA phase-out end, single', 'advanced-retirement', 'ira-eligibility'),
  rothPhaseOutEndMfs: pack(10000, 'Roth IRA phase-out end, married filing separately', 'advanced-retirement', 'ira-eligibility'),
  vaEstimateThreshold: pack(1000, 'Virginia estimated tax threshold', 'virginia-resident', 'estimated-tax'),
  ctcPerChild: pack(2200, 'Child tax credit per child', 'kids-dependents', 'child-tax-credit'),
  ctcThresholdMfj: pack(400000, 'Child tax credit phase-out threshold, married filing jointly', 'kids-dependents', 'child-tax-credit'),
  ctcThresholdOther: pack(200000, 'Child tax credit phase-out threshold, other filers', 'kids-dependents', 'child-tax-credit'),
  deferral: calc(TAX_2026.retirement.employeeDeferral, 'Employee 401(k) deferral limit', 'retirement.employeeDeferral'),
  hsaSelf: calc(TAX_2026.hsa.self, 'HSA limit, self-only coverage', 'hsa.self'),
  hsaFamily: calc(TAX_2026.hsa.family, 'HSA limit, family coverage', 'hsa.family'),
  dcfsaCap: calc(TAX_2026.dependentCare.annual, 'Dependent care FSA limit', 'dependentCare.annual'),
});

export const law = key => LAW[key].v;

export function lawContent() {
  return Object.fromEntries(Object.entries(LAW).map(([k, c]) => [k, c.v]));
}

export function pctContent() {
  const virginiaTop = TAX_2026.virginia.rates.at(-1) * 100;
  return {
    fedSafeHarborCurrent: Math.round(TAX_2026.estimated.currentRate * 100),
    fedSafeHarborPrior: Math.round(TAX_2026.estimated.priorRate * 100),
    fedSafeHarborPriorHigh: Math.round(TAX_2026.estimated.highIncomePriorRate * 100),
    vaSafeHarborCurrent: 90,
    vaSafeHarborPrior: 100,
    vaTopRate: cents(virginiaTop),
  };
}

// Filing status variants: mfj and qss use Mfj, hoh uses Hoh where defined else Single, single and
// mfs use Single (Virginia mfs uses half of Mfj).
export function stdDeduction(f) {
  if (f === 'mfj' || f === 'qss') return law('stdDeductionMfj');
  if (f === 'hoh') return law('stdDeductionHoh');
  return law('stdDeductionSingle');
}

export function vaStdDeduction(f) {
  if (f === 'mfj' || f === 'qss') return law('vaStdDeductionMfj');
  if (f === 'mfs') return law('vaStdDeductionMfj') / 2;
  return law('vaStdDeductionSingle');
}

export function rothPhaseOutEnd(f) {
  if (f === 'mfj' || f === 'qss') return law('rothPhaseOutEndMfj');
  if (f === 'mfs') return law('rothPhaseOutEndMfs');
  return law('rothPhaseOutEndSingle');
}
