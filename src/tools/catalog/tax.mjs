import { fromStored } from '../../calc/figure.mjs';
import { TAX_2026, LAW_REFS, solo401kRoom, hsaLimit, sepRoom } from '../../calc/index.mjs';
import { law } from '../../jobs/planner/law.mjs';
import { householdTax } from '../../jobs/planner/household.mjs';
import { computeFigures } from '../../jobs/planner/figures.mjs';
import { loadPlanningData, resolveEntities, planningYear } from '../../jobs/planner/data.mjs';
import { deriveFacts, mergeFacts, ownerFactsOf } from '../../jobs/planner/facts.mjs';
import { parseJson } from '../../store/db.mjs';
import { clockOf } from './figures.mjs';
import { householdDataThrough } from '../../ingest/freshness.mjs';
import { checkAssumption } from '../assumption-evidence.mjs';
import { makeFigure, uniqueGaps, bounded } from './balances.mjs';

const yearParam = { type: 'integer', enum: [2026] };
const assumption = { type: 'object', properties: { value: { type: 'number' }, source: { type: 'string', enum: ['owner','preference','fact','default'] }, evidence: { type: 'string' }, factKey: { type: 'string' }, preferenceId: { type: 'string' }, note: { type: 'string', maxLength: 200 } }, required: ['value','source'], additionalProperties: false };
const TYPES = ['employee_deferral','solo401k_pretax','solo401k_employer','sep','traditional_ira','roth_ira','hsa','dependent_care','plan529_state_deduction'];
const missing = message => ({ code: 'missing_fact', message });
const pack = (packId, entryId) => ({ packId, entryId });
const iraRef = pack('advanced-retirement','ira-eligibility');
const retirementRef = pack('advanced-retirement','contribution-limits-2026');
const hsaRef = pack('w2-benefits','hsa-limits');
const stateRef = pack('virginia-resident','virginia529-deduction');

function storedRows(db) {
  return new Map(db.prepare('SELECT g.*,s.as_of AS src_as_of FROM figures g LEFT JOIN sources s ON s.id=g.src').all().map(r => [r.key, { ...r, locator: parseJson(r.locator, {}) || {} }]));
}
function factsOf(db) {
  return Object.fromEntries(db.prepare('SELECT key,value,src,confirmed FROM facts').all().map(r => [r.key, { ...r, value: parseJson(r.value, null) }]));
}
function compute(db, clock) {
  const data = loadPlanningData(db, clock), stored = factsOf(db);
  const values = Object.fromEntries(Object.entries(stored).map(([k,r]) => [k,r.value]));
  const entities = resolveEntities(data, values);
  const facts = mergeFacts(stored, deriveFacts(data, { entities })).values;
  const out = computeFigures(data, facts, { clock, entities, owner: ownerFactsOf(stored) });
  if (out.tax) {
    const factDates = Object.values(stored).map(r => r.as_of).filter(d => typeof d === 'string' && d <= clock);
    out.tax.asOf = [householdDataThrough(db,clock), ...factDates].filter(Boolean).sort().at(-1) || null;
    out.tax.sources = [['pnl_lines',data.pnl.map(r => r.id)],['documents',data.documents.map(r => r.id)],['facts',Object.keys(stored)]].map(([table,ids]) => ({ table, ids: ids.slice(0,50), count: ids.length }));
  }
  return out;
}
function current(row, year, clock) {
  return row && planningYear(clock) === year && typeof row.locator?.computedOn === 'string' && planningYear(row.locator.computedOn) === year;
}
function storedFigure(row, tool, args, path) {
  return fromStored(row, { ref: { tool, args, path } });
}
function collectGaps(value) {
  if (!value || typeof value !== 'object') return [];
  if (value.unit && value.provenance) return value.gaps;
  return Object.values(value).flatMap(collectGaps);
}

function estimate(args, ctx) {
  const clock = clockOf(ctx), year = args.year || 2026, rows = storedRows(ctx.db), refArgs = { operation: 'estimate', ...args };
  const make = (path,value,label,asOf,provenance,gaps = [],unit = 'usd',kind = 'm') => makeFigure('tax', refArgs, path,value,unit,label,asOf,provenance,gaps,kind);
  const stored = (key,path,label) => {
    const row = rows.get(key);
    return current(row,year,clock) ? storedFigure(row,'tax',refArgs,path)
      : make(path,null,label,null,{ calc: 'storedTax', sources: [{ table: 'figures', ids: [key], count: row ? 1 : 0 }] },[missing(`No current planning figure for ${key}.`)]);
  };
  const out = { federal: {}, state: {}, safeHarbor: { federal: {}, state: {} }, marginal: {} };
  for (const [part,prefix] of [['federal','fed'],['state','va']]) {
    for (const [field,suffix] of [['projected','proj'],['paid','paid'],['withheld','withheld']]) out[part][field] = stored(`tax.${prefix}.${suffix}`,`${part}.${field}`,`${part} ${field}`);
    if (part === 'federal') out.federal.selfEmployment = stored('tax.fed.se','federal.selfEmployment','Self employment tax');
    for (const field of ['required','remaining']) out.safeHarbor[part][field] = stored(`sh.${prefix}.${field}`,`safeHarbor.${part}.${field}`,`Safe harbor ${field}`);
    const combine = (path,figures,formula,fn,label) => {
      const gaps = uniqueGaps(figures.flatMap(f => f.gaps));
      return make(path, figures.some(f => f.value === null) ? null : fn(...figures.map(f => f.value)),label,
        figures.map(f => f.asOf).filter(Boolean).sort().at(-1) || null,
        { calc: 'taxBalance', formula, inputs: figures },gaps);
    };
    out[part].remaining = combine(`${part}.remaining`,[out[part].projected,out[part].paid,out[part].withheld],'max(projected - paid - withheld, zero)',(a,b,c) => Math.max(0,a-b-c),`${part} tax remaining`);
    out.safeHarbor[part].paid = combine(`safeHarbor.${part}.paid`,[out[part].paid,out[part].withheld],'paid + withheld',(a,b) => a+b,'Safe harbor payments and withholding');
  }
  const due = ctx.db.prepare("SELECT date FROM deadlines WHERE date>=? AND date<=? AND (rec_id IN ('fed-q4-estimate','va-q4-estimate') OR lower(title) LIKE '%estimated tax%' OR lower(label) LIKE '%estimated tax%') ORDER BY date LIMIT 1").get(clock,`${year+1}-04-15`);
  out.safeHarbor.nextDueDate = make('safeHarbor.nextDueDate',due?.date || null,'Next estimated tax due date',rows.get('tax.fed.proj')?.locator.computedOn || null,
    { calc: 'taxDeadlines', sources: [{ table: 'deadlines', ids: due ? [due.date] : [], count: due ? 1 : 0 }] },due ? [] : [missing('No next estimated tax deadline is stored.')],'date');

  let computed;
  const taxRun = () => (computed ??= compute(ctx.db,clock));
  const taxable = rows.get('tax.fed.taxable'), plan = rows.get('tax.fed.proj');
  const filing = plan?.locator.parts?.filingStatus;
  const valid = current(taxable,year,clock) && !taxable.unavailable_reason && Object.hasOwn(TAX_2026.federal.ceilings,filing);
  const rate = (income,ceilings,rates) => rates[ceilings.findIndex(c => income < c) < 0 ? rates.length-1 : ceilings.findIndex(c => income < c)];
  const fedRate = valid ? rate(taxable.v,TAX_2026.federal.ceilings[filing],TAX_2026.federal.rates) : null;
  const federalRefs = [pack('self-employed-partnership','estimated-tax')];
  out.marginal.federal = make('marginal.federal',fedRate,'Federal ordinary marginal rate',valid ? taxable.locator.computedOn : null,
    { calc: 'federalIncomeTax', formula: 'rate of the next taxable dollar', inputs: valid ? [{ value: taxable.v, unit: 'usd', label: 'Federal taxable income' }] : [], lawRefs: [LAW_REFS.federal], packRefs: federalRefs },valid ? [] : [missing('Current taxable income and filing status are needed.')],'ratio');
  const stateRow = rows.get('tax.va.proj');
  const stateTaxable = current(stateRow,year,clock) && !stateRow.unavailable_reason ? stateRow.locator.taxableIncome : null;
  out.marginal.state = make('marginal.state',stateTaxable == null ? null : rate(stateTaxable,TAX_2026.virginia.ceilings,TAX_2026.virginia.rates),'State ordinary marginal rate',stateTaxable == null ? null : stateRow.locator.computedOn,
    { calc: 'virginiaIncomeTax', formula: 'rate of the next taxable dollar', lawRefs: [LAW_REFS.virginia], packRefs: [pack('virginia-resident','income-tax-rates')] },stateTaxable == null ? [missing('A supported state tax projection is needed.')] : [],'ratio');
  // IRS Rev. Proc. 2025-32 section 4.03, maximum capital gains rate thresholds for 2026.
  const gainsCeilings = { single: [49450,545500], mfj: [98900,613700], mfs: [49450,306850], hoh: [66200,579600], qss: [98900,613700] };
  out.marginal.capitalGains = make('marginal.capitalGains',valid ? rate(taxable.v,gainsCeilings[filing],[0,0.15,0.20]) : null,'Long term capital gains marginal rate',valid ? taxable.locator.computedOn : null,
    { calc: 'capitalGainsBracket', formula: 'long term rate at current taxable income; excludes net investment income tax and special gains', inputs: valid ? [{ value: taxable.v, unit: 'usd', label: 'Federal taxable income' }] : [],
      lawRefs: [{ ...LAW_REFS.federal, section: '4.03 maximum capital gains rate' }], packRefs: [pack('account-tax-treatment','basis-and-capital-gains')] },valid ? [] : [missing('Current taxable income and filing status are needed.')],'ratio');
  if (args.whatIf) out.whatIf = whatIf(args.whatIf,ctx,taxRun(),make);
  out.gaps = uniqueGaps(collectGaps(out));
  return out;
}

function whatIf(args,ctx,computed,make) {
  const assumptions = Object.entries(args).filter(([key]) => key !== 'incomeType').map(([name,value]) => checkAssumption(value,{ name, unit: 'usd', min: 0, max: Number.MAX_SAFE_INTEGER / 100, path: `whatIf.${name}` },ctx));
  const parts = computed.tax?.parts, before = computed.tax?.result;
  const changed = parts && structuredClone(parts);
  let gap = !before ? missing(`Household tax inputs are unavailable${computed.info.blocked.length ? ': ' + computed.info.blocked.join(', ') : '.'}`) : null;
  const extraIncome = assumptions.find(a => a.name === 'extraIncome')?.value || 0;
  const extraDeduction = assumptions.find(a => a.name === 'extraDeduction')?.value || 0;
  if (!gap && extraIncome) {
    const type = args.incomeType || 'business';
    if (type === 'business') {
      const eligible = changed.biz.filter(b => b.kind !== 'scorp' && b.seInput != null);
      const choices = eligible.length ? eligible : changed.biz;
      const biz = choices.length === 1 ? choices[0] : null;
      if (!biz) gap = missing('One unambiguous business tax line is needed for extra income.');
      else {
        biz.agi += extraIncome;
        if (biz.qbi !== null) biz.qbi += extraIncome;
        if (biz.seInput !== null) biz.seInput += extraIncome;
      }
    } else if (type === 'wages') {
      const wages = changed.w2.length === 1 ? changed.w2[0] : null;
      if (!wages) gap = missing('One unambiguous wage tax line is needed for extra income.');
      else { wages.agi += extraIncome; wages.gross += extraIncome; if (wages.comp != null) wages.comp += extraIncome; }
    } else changed.otherIncome = (changed.otherIncome || 0) + extraIncome;
  }
  if (changed && extraDeduction) changed.itemized += extraDeduction;
  const after = gap ? null : householdTax(changed);
  if (after?.blocked) gap = missing(`The what-if tax computation is blocked: ${after.blocked}.`);
  const stateGap = !gap && (before.va == null || after.va == null) ? missing('State tax cannot be computed for this household.') : null;
  const provenance = { calc: 'householdTax', formula: 'changed household tax minus base household tax', assumptions, sources: computed.tax?.sources || [], parameters: { incomeType: args.incomeType || 'business' },
    steps: [...(before?.steps || []).map(s => ({ ...s, label: `Base: ${s.label}` })), ...(after?.steps || []).map(s => ({ ...s, label: `What if: ${s.label}` }))] };
  return Object.fromEntries([
    ['federalDelta','Federal tax change',() => (after.fedTotal-after.seTotal)-(before.fedTotal-before.seTotal),false],
    ['stateDelta','State tax change',() => after.va-before.va,true],
    ['selfEmploymentDelta','Self employment tax change',() => after.seTotal-before.seTotal,false],
    ['totalDelta','Total tax change',() => after.fedTotal-before.fedTotal+after.va-before.va,true],
  ].map(([key,label,value,needsState]) => {
    const fgaps = [gap,needsState && stateGap].filter(Boolean);
    return [key,make(`whatIf.${key}`,fgaps.length ? null : value(),label,computed.tax?.asOf || null,provenance,fgaps)];
  }));
}

function contributionLimit(type,person,facts,row) {
  const inputs = row?.locator.inputs || {};
  const age = facts[person === 'owner' ? 'household.ownerAge' : 'household.spouseAge'];
  const f = facts['household.filingStatus'];
  if (type === 'employee_deferral') return TAX_2026.retirement.employeeDeferral;
  if (type === 'traditional_ira' || type === 'roth_ira') return law('iraLimit') + (typeof age === 'number' && age >= 50 ? law('iraCatchUp') : 0);
  if (type === 'hsa') {
    if (row?.locator.calc === 'hsaLimit') return hsaLimit(inputs).value.limit;
    const coverage = facts['benefits.hsaCoverage'];
    if (!['self','family'].includes(coverage) || typeof age !== 'number' || facts['benefits.hsaEligible'] !== true) return null;
    return hsaLimit({ coverage, age, eligibleMonths: facts['benefits.hsaEligibleMonths'] ?? 12, eligibilityConfirmed: true }).value.limit;
  }
  if (type === 'dependent_care') return Object.hasOwn(TAX_2026.federal.ceilings,f) ? (f === 'mfs' ? TAX_2026.dependentCare.mfs : TAX_2026.dependentCare.annual) : null;
  if (type === 'plan529_state_deduction') return row ? inputs.cap * inputs.accounts : null;
  if (type === 'sep') return Array.isArray(inputs) ? inputs.reduce((sum,i) => sum + sepRoom({ ...i, employerContributions: 0 }).value,0) : null;
  if (row?.locator.calc === 'solo401kRoom') {
    const reset = { ...inputs, allPlanDeferrals: 0, thisPlanDeferrals: 0, thisPlanCatchUp: 0, employerContributions: 0 };
    const room = solo401kRoom(reset).value;
    return type === 'solo401k_employer' ? room.employer : room.employee+room.employer+room.catchUp-room.rothCatchUp;
  }
  return null;
}

function room(args, ctx) {
  const clock = clockOf(ctx), year = args.year || 2026, refArgs = { operation: 'room', ...args }, stored = storedRows(ctx.db);
  const facts = Object.fromEntries(Object.entries(factsOf(ctx.db)).map(([k,r]) => [k,r.value]));
  const people = args.person && args.person !== 'both' ? [args.person] : ['owner','spouse'];
  const rows = [];
  for (const type of args.types || TYPES) for (const person of people) {
    if (['dependent_care','plan529_state_deduction','sep'].includes(type) && person !== people[0]) continue;
    if (type === 'hsa' && (!args.person || args.person === 'both')) {
      const holder = stored.get('room.hsa')?.locator.person;
      if (person !== (['owner','spouse'].includes(holder) ? holder : people[0])) continue;
    }
    const key = ({ solo401k_pretax: 'room.solo401k.pretax', solo401k_employer: 'room.solo401k.employer', employee_deferral: 'room.solo401k.employee', sep: 'room.sep', hsa: 'room.hsa', dependent_care: 'room.dependentCare', plan529_state_deduction: 'va529.deductionLeft' })[type] || `room.ira.${person}`;
    const candidate = stored.get(key);
    const individual = ['solo401k_pretax','solo401k_employer','employee_deferral'].includes(type);
    const belongs = individual || type === 'hsa' ? candidate?.locator.person === person : !['sep','dependent_care','plan529_state_deduction'].includes(type) || args.person === undefined || args.person === 'both';
    const row = current(candidate,year,clock) && belongs ? candidate : null;
    const provenance = { calc: type, sources: row ? [{ table: 'figures', ids: [key], count: 1 }] : [{ table: 'facts', ids: Object.keys(facts).slice(0,50), count: Object.keys(facts).length }], lawRefs: [type === 'hsa' ? LAW_REFS.hsa : type === 'dependent_care' ? LAW_REFS.dependentCare : LAW_REFS.retirement] };
    const packRefs = [type.includes('ira') ? iraRef : type === 'hsa' ? hsaRef : type === 'plan529_state_deduction' ? stateRef : type === 'dependent_care' ? pack('w2-benefits','dependent-care-fsa') : retirementRef, pack('advanced-retirement','contribution-deadlines')];
    provenance.packRefs = packRefs;
    const i = rows.length;
    const fig = (field,value,label,gaps = []) => makeFigure('tax',refArgs,`rows.${i}.${field}`,value,field === 'deadline' ? 'date' : 'usd',label,row?.locator.computedOn || null,provenance,gaps,'m');
    const usageGap = { code: ['employee_deferral','dependent_care'].includes(type) ? 'outside_household_ledger' : 'missing_fact', message: `Contribution usage and eligibility for ${person} ${type} need current records; payroll elections may be outside household transactions.` };
    const limit = contributionLimit(type,person,facts,row);
    let remaining = row ? storedFigure(row,'tax',refArgs,`rows.${i}.remaining`) : null;
    let used = null;
    const inputs = row?.locator.inputs;
    if (row && !row.unavailable_reason && inputs) {
      if (type === 'hsa') used = (inputs.employerContributions || 0) + (inputs.personalContributions || 0);
      else if (type.includes('ira')) used = inputs.contributions?.[person] ?? null;
      else if (type === 'employee_deferral' && typeof inputs.allPlanDeferrals === 'number') used = Math.min(TAX_2026.retirement.employeeDeferral,inputs.allPlanDeferrals);
      else if (type === 'solo401k_employer') used = inputs.employerContributions ?? null;
      else if (type === 'sep' && Array.isArray(inputs)) used = inputs.reduce((sum,i) => sum + (i.employerContributions || 0),0);
      else if (type === 'plan529_state_deduction' && limit !== null) used = Math.max(0,limit-row.v);
    }
    const extraGaps = [];
    if (type.includes('ira') && typeof facts[person === 'owner' ? 'household.ownerAge' : 'household.spouseAge'] !== 'number') extraGaps.push(missing('Age is unknown; the statutory IRA limit excludes catch up contributions.'));
    if (type === 'dependent_care') extraGaps.push(missing('The statutory dependent care ceiling may be reduced by earned income, qualifying expenses and employer plan eligibility.'));
    if (!row || used === null) extraGaps.push(usageGap);
    if (type === 'roth_ira') {
      const g = missing('IRA contribution room is shared; Roth income eligibility and traditional IRA deductibility require a separate eligibility check.');
      if (remaining) remaining = { ...remaining, label: 'Shared IRA room before Roth income eligibility', gaps: [...remaining.gaps,g] };
      extraGaps.push(g);
    }
    const due = ['employee_deferral','solo401k_pretax','dependent_care','plan529_state_deduction'].includes(type) ? `${year}-12-31`
      : ['solo401k_employer','sep'].includes(type) ? null : `${year+1}-04-15`;
    rows.push({ person: ['sep','dependent_care','plan529_state_deduction'].includes(type) && (args.person === undefined || args.person === 'both') ? 'both' : person, type, limit: fig('limit',limit,type === 'dependent_care' ? 'Statutory dependent care ceiling' : 'Contribution limit',limit === null ? [missing(`Eligibility and plan inputs are needed for ${type} limit.`)] : []),
      used: used === null ? null : fig('used',used,'Recorded contributions'), remaining,
      deadline: fig('deadline',due,'Contribution deadline',due === null ? [missing('Employer contribution deadline depends on entity return and extension status.')] : []), basis: row ? 'planner' : 'calculator', packRefs, gaps: extraGaps });
  }
  return { rows, gaps: uniqueGaps(rows.flatMap(r => [...r.gaps,...collectGaps(r)])) };
}

export const operations = [
  { tool: 'tax', name: 'estimate', scope: 'read', summary: 'Stored tax and safe harbor projections, marginal rates and sourced income or deduction what-ifs.', route: 'Tax owed, safe harbor, marginal rate, tax what-if', routes: [], referenceable: true, params: { year: yearParam,
    whatIf: { type: 'object', properties: { extraIncome: assumption, extraDeduction: assumption, incomeType: { type: 'string', enum: ['business','wages','other'] } }, additionalProperties: false } }, required: [], handler: (args,ctx) => bounded(estimate(args,ctx)) },
  { tool: 'tax', name: 'room', scope: 'read', summary: 'Contribution limits and recorded remaining room; reports missing payroll or eligibility inputs.', route: 'Contribution room and deadlines', routes: [], referenceable: true,
    params: { person: { type: 'string', enum: ['owner','spouse','both'] }, types: { type: 'array', items: { type: 'string', enum: TYPES }, maxItems: 9 }, year: yearParam }, required: [], handler: (args,ctx) => bounded(room(args,ctx)) },
];
