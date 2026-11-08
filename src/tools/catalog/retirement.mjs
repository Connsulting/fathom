import { envelope } from '../../calc/figure.mjs';
import { bindFigures } from '../../calc/aggregate.mjs';
import { futureValue, requiredMonthly } from '../../calc/growth.mjs';
import { ACCOUNT_TREATMENT, ACCESS_RULES } from '../../calc/treatment.mjs';
import { TARGET_PARAMETERS, INVESTMENT_KINDS, independenceProjection, spendingInputs, holdingsTotal, monthsToReach } from '../../calc/targets.mjs';
import { accountHistory } from '../../pace/build.mjs';
import { ownerOf } from '../../jobs/planner/data.mjs';
import { tokenScope } from '../../scenario/build.mjs';
import { accountLabel } from '../../shared/account-label.mjs';
import { plainDeep } from './figures.mjs';
import { readInput } from './spending.mjs';
import { selectedAccounts, uniqueGaps, bounded, accountIds } from './balances.mjs';
import { resolveRef } from '../refs.mjs';
import { checkAssumption } from '../assumption-evidence.mjs';
import { evaluate } from './calculate.mjs';
import { ToolError } from '../errors.mjs';
import { mapSeries } from '../../shared/series.mjs';

const bad = message => { throw new ToolError('bad_input', message); };
const gap = (message, fact) => ({ code:'missing_fact', message, ...(fact ? { fact } : {}) });
const latest = dates => dates.filter(Boolean).sort().at(-1) ?? null;
const isoDate = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0,10) === d;
const packRef = r => ({ packId:r.pack,entryId:r.entry });
const assumption = { type:'object',properties:{ value:{},source:{},evidence:{},factKey:{},preferenceId:{},note:{} },required:['value','source'],additionalProperties:false };
const operand = { type:'object',properties:{ ref:{},assumption:{},expr:{} },additionalProperties:false };
const inputSchema = { type:'object',properties:{ ...assumption.properties,...operand.properties },additionalProperties:false };
const choice = values => ({type:'string',enum:values});
const treatments = ['pretax','roth','roth_ira','roth_401k','taxable','hsa','cash'];

async function input(value, name, unit, ctx, options = {}) {
  if (value === undefined && options.default !== undefined) value = {value:options.default,source:'default'};
  if (value === undefined) bad(`${name} is required`);
  let term;
  if (value && typeof value === 'object' && ['ref','assumption','expr'].some(k => Object.hasOwn(value,k))) {
    term = await evaluate({operation:'sum',operands:[value]},ctx,name);
    if (term.unit !== unit) bad(`${name} needs ${unit}, got ${term.unit}`);
  } else {
    const record = await checkAssumption(value,{ name,unit,...options },ctx);
    const fact = record.factKey ? await ctx.db.prepare('SELECT as_of,updated_at FROM facts WHERE key=?').get(record.factKey) : null;
    term = {value:record.value,unit,asOf:fact?.as_of ?? fact?.updated_at ?? null,assumptions:[record],inputs:[],gaps:[],steps:[]};
  }
  if (term.value !== null && ((options.min !== undefined && term.value < options.min) || (options.max !== undefined && term.value > options.max))) bad(`${name} is outside its allowed range`);
  return term;
}

function provenance(calc, terms = [], extra = {}) {
  return { calc,inputs:terms.flatMap(t => t.inputs ?? []),assumptions:terms.flatMap(t => t.assumptions ?? []),
    steps:terms.flatMap(t => t.steps ?? []),...extra };
}
function figure(value, unit, label, asOf, prov, gaps = [], kind = 'm') {
  return envelope(value,{ unit,label,kind,asOf,provenance:prov,gaps:uniqueGaps(gaps),
    ...(value === null ? {unavailable:gaps[0]?.code ?? 'missing_fact'} : {}) });
}
const termOf = f => ({...f,inputs:[f],assumptions:[]});
async function rateInput(value,name,ctx,defaultValue) {
  return input(value,name,'ratio',ctx,{ ...(defaultValue === undefined ? {} : {default:defaultValue}),
    min:name === 'withdrawalRate' ? 0.02 : name === 'realReturn' ? -0.05 : 0,
    max:name === 'withdrawalRate' ? 0.06 : name === 'realReturn' ? 0.1 : 0.6 });
}
function typeOf(a,facts) {
  const plan = facts['accounts.planType']?.[a.id];
  return (Object.hasOwn(ACCOUNT_TREATMENT.byPlanType,plan) ? ACCOUNT_TREATMENT.byPlanType[plan] : null)
    ?? (Object.hasOwn(ACCOUNT_TREATMENT.byKind,a.kind) ? ACCOUNT_TREATMENT.byKind[a.kind] : a.kind === 'savings' ? ACCOUNT_TREATMENT.byKind.cash : null);
}
function isBusiness(a) { return a.business || a.kind === 'business' || ownerOf(a.owner) === 'business'; }
async function accountValue(a,ctx,clock) {
  const snapshot = (await accountHistory(ctx.db,a.id,clock)).at(-1);
  const sources = (snapshot?.value?.locator?.sources ?? []).map(s => s.rows);
  const label = a.parser === 'demo-seed' ? plainDeep(await tokenScope(ctx.db),accountLabel(a)) : accountLabel(a);
  const gaps = snapshot?.value ? [] : [gap(`${label} has no complete stored balance or positions.`)];
  return { account:a,label,value:snapshot?.value?.v ?? null,asOf:snapshot?.date ?? null,sources,gaps };
}

async function target(args,ctx) {
  if (args.spending !== undefined && args.definition !== undefined) bad('target takes spending or definition, not both');
  const data = await readInput(ctx), clock = data.clock;
  const spend = args.spending ? await resolveRef(args.spending,ctx,'spending') : (await (await import('../index.mjs')).callTool('spending',{ operation:'total',definition:args.definition ?? 'household_spending',annualize:true },ctx)).total;
  if (Array.isArray(spend) || spend.unit !== 'usd_per_year') bad('spending must reference one usd_per_year figure');
  const wr = await rateInput(args.withdrawalRate,'withdrawalRate',ctx,TARGET_PARAMETERS.withdrawalRate);
  const rr = await rateInput(args.realReturn,'realReturn',ctx,TARGET_PARAMETERS.realReturn);
  const sp = spendingInputs(data);
  const savingsRows = new Set(sp.windowTransactionIds);
  const savings = args.monthlySavings === undefined ? {
    value:sp.monthlySavings ?? null,unit:'usd_per_month',asOf:latest(data.transactions.filter(t => savingsRows.has(t.id)).map(t => t.date)),
    inputs:[],assumptions:[],steps:[],gaps:sp.monthlySavings === undefined ? [gap('Monthly savings needs a complete spending window.')] : [],
  } : await input(args.monthlySavings,'monthlySavings','usd_per_month',ctx);
  const selector = args.invested ?? {};
  const ids = selector.accounts;
  if (ids) await selectedAccounts(ctx.db,ids);
  const accounts = data.accounts.filter(a => !isBusiness(a) && (ids ? ids.includes(a.id) : (selector.kinds ?? INVESTMENT_KINDS).includes(a.kind))
    && (!selector.kinds || selector.kinds.includes(a.kind)) && (!selector.treatments || selector.treatments.includes(typeOf(a,data.facts)?.id)));
  const holdings = await mapSeries(accounts, async a => await accountValue(a,ctx,clock));
  const total = holdingsTotal(holdings.map(h => ({...h.account,value:h.value === null ? null : {v:h.value,locator:{sources:h.sources.map(rows => ({rows}))},dataThrough:h.asOf}})));
  const invested = holdings.length === 0 ? 0 : total.total;
  const hgaps = holdings.flatMap(h => h.gaps);
  if (!holdings.length) hgaps.push(gap('No investment accounts match this selection; only tracked selected accounts count as invested.'));
  for (const a of data.accounts.filter(a => ids?.includes(a.id) && isBusiness(a))) hgaps.push({code:'outside_household_ledger',message:'A selected business account was excluded from household investments.'});
  const gaps = uniqueGaps([...(spend.gaps ?? []),...savings.gaps,...hgaps]);
  const annual = spend.value;
  const rounding = args.roundTo ?? 1000;
  const plan = annual === null || wr.value === null ? null : independenceProjection({
    spending:{...sp,annualSpend:annual,monthlySavings:savings.value}, invested:{...total,total:invested},
    horizon:'now', clock, withdrawalRate:wr.value, parameters:{...TARGET_PARAMETERS,realReturn:rr.value}, roundTo:rounding,
  });
  const amount = plan?.target ?? null;
  const need = amount === null || invested === null ? null : Math.max(0,amount - invested);
  const status = need === 0 ? 'covered' : !(savings.value > 0) ? 'no_savings'
    : need === null || rr.value === null || plan?.dateSource !== 'projected' ? 'too_long' : 'projected';
  const months = status === 'covered' ? 0 : status === 'projected' ? plan.months : null;
  const date = months === null ? null : months === 0 ? clock : plan.targetDate;
  const holdingProv = {calc:'holdingsTotal',sources:holdings.flatMap(h => h.sources),accounts:holdings.map(h => ({id:h.account.id,label:h.label}))};
  const investedNow = figure(invested,'usd','Invested now',latest(holdings.map(h => h.asOf)),holdingProv,hgaps,'a');
  const monthlySavings = figure(savings.value,'usd_per_month','Monthly savings',savings.asOf,provenance('spendingInputs',[savings],{
    sources:args.monthlySavings === undefined ? [{table:'transactions',ids:sp.windowTransactionIds.slice(0,50),count:sp.windowTransactionIds.length}] : [],formula:'monthly income less household spending' }),savings.gaps,'e');
  if (args.monthlySavings === undefined && sp.window) monthlySavings.window = sp.window;
  const terms = [termOf(spend),wr,rr,termOf(investedNow),termOf(monthlySavings)];
  const asOf = latest(terms.map(t => t.asOf));
  const prov = provenance('independencePlan',terms,{formula:'annual spending divided by withdrawal rate, rounded up; monthly compound growth plus savings',steps:[{label:'Target',formula:'ceil(annual spending / withdrawal rate / roundTo) * roundTo',value:amount},{label:'Projection months',formula:'ln((target * r + savings) / (invested * r + savings)) / ln(1 + r)',value:months}]});
  return {target:figure(amount,'usd','Independence target',spend.asOf,prov,spend.gaps,'t'),investedNow,
    gap:figure(need,'usd','Investment gap',asOf,prov,gaps),months:months === null ? null : figure(months,'months','Months to target',asOf,prov,gaps),
    projectedDate:date === null ? null : figure(date,'date','Projected target date',asOf,prov,gaps),monthlySavings,status,gaps};
}

function personDate(facts,person,age) {
  const born = facts[`household.${person}BirthDate`];
  if (isoDate(born)) {
    const birth = new Date(born);
    const month = birth.getUTCMonth()+Math.round(age*12);
    const lastDay = new Date(Date.UTC(birth.getUTCFullYear(),month+1,0)).getUTCDate();
    const d = new Date(Date.UTC(birth.getUTCFullYear(),month,Math.min(birth.getUTCDate(),lastDay)));
    return {date:d.toISOString().slice(0,10),gaps:[],keys:[`household.${person}BirthDate`]};
  }
  const year = facts['household.birthYears']?.[person];
  if (Number.isInteger(year) && year >= 1900 && year <= 2100) return {date:`${year+Math.ceil(age)}-12-31`,gaps:[gap(`${person} has only a birth year; month precision is unavailable and the date uses the latest possible year end.`)],keys:['household.birthYears']};
  return {date:null,gaps:[gap(`${person} needs a birth date or birth year to calculate age and dates.`, `household.${person}BirthDate`)],keys:[]};
}
const monthSpan = (from,to) => Math.max(0,(Number(to.slice(0,4))-Number(from.slice(0,4)))*12 + Number(to.slice(5,7))-Number(from.slice(5,7)) + (to.slice(8,10)>from.slice(8,10) ? 1 : 0));

async function growth(args,ctx) {
  const {clock,facts} = await readInput(ctx);
  const allowed = {balance:['monthlyContribution','years'],months:['monthlyContribution','target'],monthly:['target','byDate','byAge']}[args.solve];
  for (const k of ['monthlyContribution','years','target','byDate','byAge']) if (args[k] !== undefined && !allowed.includes(k)) bad(`${k} does not apply to growth solve ${args.solve}`);
  const b = await input(args.balance,'balance','usd',ctx,{min:0}), rr = await rateInput(args.realReturn,'realReturn',ctx,0.04);
  const terms = [b,rr], gaps = [];
  let value,unit,formula;
  if (args.solve === 'balance') {
    if (args.years === undefined) bad('years is required to solve balance');
    const c = await input(args.monthlyContribution,'monthlyContribution','usd_per_month',ctx,{default:0,min:0});
    terms.push(c);
    value = terms.some(t=>t.value===null) ? null : futureValue({balance:b.value,monthly:c.value,annualRate:rr.value,months:args.years*12});
    unit = 'usd'; formula = 'B (1 + r)^n + C ((1 + r)^n - 1) / r, with monthly compounding';
  } else {
    const t = await input(args.target,'target','usd',ctx,{min:0}); terms.push(t);
    if (args.solve === 'months') {
      const c = await input(args.monthlyContribution,'monthlyContribution','usd_per_month',ctx,{default:0,min:0}); terms.push(c);
      const r = rr.value/12;
      value = terms.some(t=>t.value===null) ? null : b.value >= t.value ? 0 : c.value > 0 ? monthsToReach({target:t.value,invested:b.value,monthly:c.value,monthlyRate:r})
        : b.value > 0 && r > 0 ? Math.log(t.value/b.value)/Math.log(1+r) : null;
      if (value !== null && Number.isFinite(value)) value = Math.ceil(value-1e-9);
      unit = 'months'; formula = 'monthly compound balance and annuity solved for months';
    } else {
      if ((args.byDate === undefined) === (args.byAge === undefined)) bad('monthly needs exactly one of byDate or byAge');
      if (args.byDate && !isoDate(args.byDate)) bad('byDate must be a calendar date');
      const date = args.byAge ? personDate(facts,args.byAge.person,args.byAge.age) : {date:args.byDate,gaps:[],keys:[]};
      gaps.push(...date.gaps);
      const n = date.date ? monthSpan(clock,date.date) : null;
      if (n === 0) bad('monthly needs a future date');
      value = n === null || terms.some(t=>t.value===null) ? null : requiredMonthly({target:t.value,balance:b.value,annualRate:rr.value,months:n});
      unit = 'usd_per_month'; formula = 'monthly contribution required for compound balance and annuity to reach target';
      if (date.keys.length) terms.push({inputs:date.keys.map(key=>({label:key,value:facts[key]})),asOf:latest(await mapSeries(date.keys, async key=>(await ctx.db.prepare('SELECT as_of FROM facts WHERE key=?').get(key))?.as_of))});
    }
  }
  if (value !== null && (!Number.isFinite(value) || value < 0)) value = null;
  gaps.push(...terms.flatMap(t=>t.gaps ?? []));
  if (value === null && !gaps.length) gaps.push(gap('The target cannot be reached with these growth inputs.'));
  const prov = provenance('growth',terms,{formula,steps:[...terms.flatMap(t=>t.steps ?? []),{label:'Growth result',formula,value}]});
  return {figure:figure(value,unit,'Growth result',latest(terms.map(t=>t.asOf)),prov,gaps,'p')};
}

async function afterTax(args,ctx) {
  if (args.accounts !== undefined && args.kinds !== undefined) bad('after_tax takes accounts or kinds, not both');
  if (args.hypothetical !== undefined && (args.accounts !== undefined || args.kinds !== undefined)) bad('hypothetical cannot be combined with stored accounts');
  const data = await readInput(ctx),clock=data.clock,facts=data.facts;
  const rates = await Promise.all(await mapSeries(['ordinaryRate','capitalGainsRate','stateRate'], async k=>await rateInput(args[k],k,ctx)));
  const [ordinary,capital,state] = rates;
  const selected = args.hypothetical ? [] : (await selectedAccounts(ctx.db,args.accounts)).filter(a=>args.accounts || (args.kinds ? args.kinds.includes(a.kind) : !isBusiness(a) && ['cash','checking','savings',...INVESTMENT_KINDS,'hsa'].includes(a.kind)));
  const records = args.hypothetical ? await Promise.all(await mapSeries(args.hypothetical, async (h,i)=>({treatment:h.treatment,
    valueInput:await input(h.value,`hypothetical ${i} value`,'usd',ctx,{min:0}),basisInput:h.basis === undefined ? null : await input(h.basis,`hypothetical ${i} basis`,'usd',ctx,{min:0}),
    contributionsInput:h.contributions === undefined ? null : await input(h.contributions,`hypothetical ${i} contributions`,'usd',ctx,{min:0})})))
    : await mapSeries(selected, async a=>({...await accountValue(a,ctx,clock),treatment:typeOf(a,facts)?.id ?? 'unknown',rule:typeOf(a,facts)}));
  const totals = { value:0, afterTax:0 };
  const rows = await mapSeries(records, async r=>{
    const value = r.valueInput?.value ?? r.value;
    const rowGaps = [...(r.gaps ?? []),...rates.flatMap(t=>t.gaps ?? [])];
    const terms = [...rates,...[r.valueInput,r.basisInput,r.contributionsInput].filter(Boolean)];
    const treatment = r.treatment, taxable=treatment==='taxable';
    let basis = null,unrealizedGain=null,tax=null,after=null,medical,nonmedical,qualified=null;
    let whenTaxed;
    const rule = r.rule?.packRef ?? ACCOUNT_TREATMENT.byKind[taxable ? 'taxable' : treatment.startsWith('roth') ? 'roth' : treatment === 'hsa' ? 'hsa' : 'cash'].packRef;
    if (r.account) terms.push({inputs:[{value,unit:'usd',label:r.label}],asOf:r.asOf});
    const rateMissing = rates.some(t=>t.value===null);
    if (treatment==='pretax') {
      whenTaxed='Ordinary income plus state tax on withdrawal; access rules apply separately.';
      if (value !== null && !rateMissing) tax=value*(ordinary.value+state.value);
    } else if (treatment.startsWith('roth')) {
      whenTaxed='Tax-free once qualified; the reported after-tax value applies only from the qualification date, which may be unknown.';
      tax=value===null ? null : 0;
      const person=r.account ? ownerOf(r.account.owner) : null;
      const ageDate=person==='owner' || person==='spouse' ? personDate(facts,person,ACCESS_RULES.penaltyFreeAge.years+ACCESS_RULES.penaltyFreeAge.months/12) : {date:null,gaps:[gap('Roth qualification needs the account owner birth date.')],keys:[]};
      rowGaps.push(...ageDate.gaps);
      const first=r.account ? facts['accounts.rothFirstContributionYear']?.[r.account.id] : null;
      if (!Number.isInteger(first) || first<1975 || first>Number(clock.slice(0,4))) rowGaps.push(gap('Roth qualification needs the year of the first Roth contribution.', 'accounts.rothFirstContributionYear'));
      else if (ageDate.date) qualified=latest([ageDate.date,`${first+ACCESS_RULES.fiveYear.years}-01-01`]);
    } else if (taxable) {
      whenTaxed='Capital gains plus state tax on gains when sold; basis returns untaxed. Annual distributions may also be taxed.';
      const positions = r.account && r.asOf ? await ctx.db.prepare('SELECT id,value,quantity,price,cost_basis FROM positions WHERE account_id=? AND as_of=?').all(r.account.id,r.asOf) : [];
      const missing=positions.filter(p=>!Number.isFinite(p.cost_basis));
      if (r.basisInput) basis=r.basisInput.value;
      else if (positions.length && !missing.length) basis=positions.reduce((sum,p)=>sum+p.cost_basis,0);
      if (basis===null) rowGaps.push({code:'no_cost_basis',message:'Cost basis is missing; no withdrawal tax or after-tax value can be calculated.',...(positions.length ? {count:missing.length} : {})});
      else if (value!==null) {
        unrealizedGain=value-basis;
        if (!rateMissing) tax=Math.max(0,unrealizedGain)*(capital.value+state.value);
      }
    } else if (treatment==='hsa') {
      whenTaxed='Qualified medical withdrawals are tax-free; nonmedical withdrawals face ordinary and state tax plus the additional tax before the statutory age.';
      medical=value;
      const person=r.account ? ownerOf(r.account.owner) : null;
      const birthday=person==='owner' || person==='spouse' ? personDate(facts,person,ACCESS_RULES.hsaAnyUse.years) : {date:null,gaps:[gap('HSA nonmedical tax needs the account owner age.')],keys:[]};
      rowGaps.push(...birthday.gaps,gap('Choose medical or nonmedical withdrawal purpose for the HSA after-tax value.'));
      nonmedical=value!==null && birthday.date && !rateMissing ? value*(1-ordinary.value-state.value-(clock<birthday.date ? ACCESS_RULES.hsaAdditionalTax.rate : 0)) : null;
    } else if (treatment==='cash') {whenTaxed='No tax on cash withdrawal; interest is taxed when earned.';tax=value===null ? null : 0;}
    else {whenTaxed='Tax treatment is unavailable.';rowGaps.push(gap(`${r.label ?? 'Account'} needs its plan type for a supported tax treatment.`, 'accounts.planType'));}
    if (tax!==null && value!==null) after=value-tax;
    totals.value = value === null || totals.value === null ? null : totals.value + value;
    totals.afterTax = after === null || totals.afterTax === null ? null : totals.afterTax + after;
    const asOf=latest([r.asOf,...terms.map(t=>t.asOf)]);
    const refs=[packRef(rule),...(treatment==='hsa' ? [packRef(ACCESS_RULES.hsaAdditionalTax.packRef)] : [])];
    const prov=provenance('afterTax',terms,{formula:whenTaxed,sources:r.sources ?? [],accounts:r.account ? [{id:r.account.id,label:r.label}] : [],packRefs:refs});
    const f=(v,unit,label)=>figure(v,unit,label,asOf,prov,rowGaps);
    return {treatment,accounts:prov.accounts,value:f(value,'usd','Account value'),basis:taxable ? f(basis,'usd','Cost basis') : null,unrealizedGain:taxable ? f(unrealizedGain,'usd','Unrealized gain') : null,
      taxOnWithdrawal:f(tax,'usd','Tax on withdrawal'),afterTax:f(after,'usd','After tax value'),qualifiedFrom:treatment.startsWith('roth') ? f(qualified,'date','Qualified withdrawal date') : null,
      ...(medical===undefined ? {} : {afterTaxMedical:f(medical,'usd','Medical withdrawal value'),afterTaxNonmedical:f(nonmedical,'usd','Nonmedical withdrawal value')}),whenTaxed,packRef:packRef(rule)};
  });
  const gaps=uniqueGaps(rows.flatMap(r=>r.afterTax.gaps));
  if (!rows.length) gaps.push(gap('No matching accounts or hypothetical values.'));
  const sum=key=>rows.length ? totals[key] : null;
  const asOf=latest(rows.map(r=>r.value.asOf));
  const total={value:figure(sum('value'),'usd','Total account value',asOf,provenance('afterTax',rows.map(r=>termOf(r.value))),gaps),
    afterTax:figure(sum('afterTax'),'usd','Total after tax value',asOf,provenance('afterTax',rows.map(r=>termOf(r.afterTax))),gaps)};
  return {rows,total,gaps};
}

const params = {
  target:{spending:{type:'object'},definition:{type:'string'},withdrawalRate:assumption,invested:{type:'object',properties:{kinds:accountIds,treatments:{...accountIds,items:choice(treatments)},accounts:accountIds},additionalProperties:false},monthlySavings:inputSchema,realReturn:assumption,roundTo:{type:'integer',enum:[1,1000]}},
  growth:{solve:choice(['balance','months','monthly']),balance:inputSchema,monthlyContribution:inputSchema,realReturn:assumption,years:{type:'number',minimum:0,maximum:60},target:inputSchema,byDate:{type:'string',pattern:'^\\d{4}-\\d{2}-\\d{2}$'},byAge:{type:'object',properties:{person:choice(['owner','spouse']),age:{type:'number',minimum:18,maximum:100}},required:['person','age'],additionalProperties:false}},
  after_tax:{accounts:accountIds,kinds:accountIds,hypothetical:{type:'array',minItems:1,maxItems:10,items:{type:'object',properties:{treatment:choice(treatments),value:assumption,basis:assumption,contributions:assumption},required:['treatment','value'],additionalProperties:false}},ordinaryRate:inputSchema,capitalGainsRate:inputSchema,stateRate:inputSchema},
};
export const operations = [
  ['target',target,[],'Target and date','Independence target, gap and date.'],
  ['growth',growth,['solve','balance'],'Growth','Future balance, months or required savings.'],
  ['after_tax',afterTax,['ordinaryRate','capitalGainsRate','stateRate'],'After-tax value','After-tax values by treatment; unknown basis stays unavailable.'],
].map(([name,handler,required,route,summary])=>({tool:'retirement',name,scope:'read',referenceable:true,params:params[name],required,route,summary,routes:[],
  async handler(args,ctx) { return bounded(bindFigures(await handler(args,ctx),'retirement',{operation:name,...args})); } }));

export const rules = ['Compare tax and access, never which to choose.'];
