import { ACCOUNT_TREATMENT, EMPLOYER_PLAN_TYPES, ACCESS_RULES, rmdStartAge } from '../../calc/treatment.mjs';
import { addMonths } from '../../calc/obligations.mjs';
import { envelope } from '../../calc/figure.mjs';
import { bindFigures } from '../../calc/aggregate.mjs';
import { accountHistory } from '../../pace/build.mjs';
import { ownerOf } from '../../jobs/planner/data.mjs';
import { readInput } from './spending.mjs';
import { selectedAccounts, uniqueGaps, bounded } from './balances.mjs';
import { plainDeep } from './figures.mjs';
import { tokenScope } from '../../scenario/build.mjs';
import { accountLabel } from '../../shared/account-label.mjs';
import { checkAssumption } from '../assumption-evidence.mjs';
import { resolveRef } from '../refs.mjs';
import { ToolError } from '../errors.mjs';

const bad = message => {throw new ToolError('bad_input',message);};
const gap = message => ({code:'missing_fact',message});
const latest = dates => dates.filter(Boolean).sort().at(-1) ?? null;
const pack = r => ({packId:r.pack,entryId:r.entry});
const ageAccess = ACCESS_RULES.penaltyFreeAge.years+ACCESS_RULES.penaltyFreeAge.months/12;
const assumption = { type:'object',properties:{ value:{},source:{},evidence:{},factKey:{},preferenceId:{},note:{} },required:['value','source'],additionalProperties:false };
const figure = (value,unit,label,asOf,provenance,gaps=[]) => envelope(value,{unit,label,asOf,kind:'m',provenance,gaps:uniqueGaps(gaps),...(value===null?{unavailable:'missing_fact'}:{})});

function birthOf(facts,person) {
  const key=`household.${person}BirthDate`,born=facts[key];
  if(typeof born==='string')return {born,precise:true,keys:[key],gaps:[]};
  const year=facts['household.birthYears']?.[person];
  if(Number.isInteger(year))return {born:`${year}-12-31`,precise:false,keys:['household.birthYears'],gaps:[gap(`${person} has year precision only; a birth date is missing and dates use year end.`)]};
  return {born:null,precise:false,keys:[key],gaps:[gap(`${person} needs ${key} or household.birthYears.`)]};
}
function dateAt(birth,age) {
  if(!birth.born)return null;
  if(!birth.precise)return `${Number(birth.born.slice(0,4))+Math.ceil(age)}-12-31`;
  return addMonths(birth.born,age*12);
}
function accountRecords(ctx,data) {
  const scope=tokenScope(ctx.db);
  return selectedAccounts(ctx.db).filter(a=>ownerOf(a.owner)!=='business'&&a.kind!=='business').map(a=>{
    const plan=data.facts['accounts.planType']?.[a.id];
    const treatment=ACCOUNT_TREATMENT.byPlanType[plan]?.id ?? ACCOUNT_TREATMENT.byKind[a.kind]?.id ?? (a.kind==='savings'?'cash':'unknown');
    const label=a.parser==='demo-seed'?plainDeep(scope,accountLabel(a)):accountLabel(a);
    return {a,plan,treatment,label,person:ownerOf(a.owner),ref:{id:a.id,label},separation:data.facts['accounts.separationDate']?.[a.id]};
  });
}
function qualifying(r,birth,gaps) {
  if(!r.plan&&['retirement','ira','roth'].includes(r.a.kind))gaps.push(gap(`${r.label} needs accounts.planType; employer-plan access cannot be inferred.`));
  if(!EMPLOYER_PLAN_TYPES.includes(r.plan))return false;
  if(!r.separation){gaps.push(gap(`${r.label} needs accounts.separationDate; retirement age does not establish separation.`));return false;}
  return !!birth.born&&Number(r.separation.slice(0,4))>=Number(birth.born.slice(0,4))+ACCESS_RULES.ruleOf55.years;
}

function access(args,ctx) {
  const data=readInput(ctx),records=accountRecords(ctx,data),people=[];
  for(const person of args.people&&args.people!=='both'?[args.people]:['owner','spouse']) {
    const birth=birthOf(data.facts,person),gaps=[...birth.gaps];
    const rows=records.filter(r=>r.person===person);
    const unknown=records.filter(r=>!['owner','spouse'].includes(r.person)&&['retirement','ira','roth','hsa'].includes(r.a.kind));
    for(const r of unknown)gaps.push(gap(`${r.label} needs a known account owner before access dates can be assigned.`));
    const facts=ctx.db.prepare('SELECT key,as_of FROM facts').all(),sources=facts.filter(f=>birth.keys.includes(f.key)||f.key.startsWith('accounts.'));
    const asOf=latest(sources.map(f=>f.as_of));
    const prov={calc:'retirementAccess',sources:sources.map(f=>({table:'facts',ids:[f.key],count:1}))};
    const milestones=[];
    const event=(name,age,date,accounts,ref,extraGaps=[])=>{
      const p={...prov,packRefs:[pack(ref)],accounts:accounts.map(r=>r.ref)};
      milestones.push({event:name,age:figure(age,'age','Access age',asOf,p,[...gaps,...extraGaps]),date:figure(date,'date','Access date',asOf,p,[...gaps,...extraGaps]),accounts:p.accounts,packRef:pack(ref)});
    };
    const retirement=rows.filter(r=>r.treatment==='pretax'||r.treatment.startsWith('roth')||r.treatment==='needs plan type');
    event('penalty_free_59_half',ageAccess,dateAt(birth,ageAccess),retirement,ACCESS_RULES.penaltyFreeAge.packRef);
    for(const r of rows) {
      if(qualifying(r,birth,gaps))event('rule_of_55',ACCESS_RULES.ruleOf55.years,r.separation,[r],ACCESS_RULES.ruleOf55.packRef);
      if(r.treatment.startsWith('roth')) {
        const first=data.facts['accounts.rothFirstContributionYear']?.[r.a.id];
        const missing=Number.isInteger(first)?[]:[gap(`${r.label} needs accounts.rothFirstContributionYear.`)];gaps.push(...missing);
        const ageDate=dateAt(birth,ageAccess),five=Number.isInteger(first)?`${first+ACCESS_RULES.fiveYear.years}-01-01`:null;
        event('roth_earnings_qualified',ageAccess,ageDate&&five?latest([ageDate,five]):null,[r],ACCESS_RULES.fiveYear.packRef,missing);
      }
    }
    const hsa=rows.filter(r=>r.treatment==='hsa');
    if(hsa.length)event('hsa_nonmedical_no_penalty_65',ACCESS_RULES.hsaAnyUse.years,dateAt(birth,ACCESS_RULES.hsaAnyUse.years),hsa,ACCESS_RULES.hsaAnyUse.packRef);
    const rmd=rows.filter(r=>r.treatment==='pretax');
    if(rmd.length){const age=birth.born?rmdStartAge(birth.born):null;event('rmd_start',age,age===null?null:dateAt(birth,age),rmd,rmdStartAge.packRef);}
    const ageNow=birth.born?Number(data.clock.slice(0,4))-Number(birth.born.slice(0,4))-(birth.precise&&data.clock.slice(5)<birth.born.slice(5)?1:0):null;
    people.push({person,born:figure(birth.born,'date','Birth date',asOf,prov,birth.gaps),ageNow:figure(ageNow,'age','Age now',asOf,prov,birth.gaps),milestones,gaps:uniqueGaps(gaps)});
  }
  return {people,gaps:uniqueGaps(people.flatMap(p=>p.gaps))};
}

async function bridge(args,ctx) {
  if(args.spending&&args.definition!==undefined)bad('bridge takes spending or definition, not both');
  const data=readInput(ctx),person=args.person ?? 'owner',birth=birthOf(data.facts,person),gaps=[...birth.gaps];
  const stored=data.facts['household.retireAge']?.[person];
  let age,assumptions=[];
  if(args.retireAge!==undefined){const a=checkAssumption(args.retireAge,{name:'retireAge',unit:'age',min:18,max:100},ctx);age=a.value;assumptions.push(a);}
  else if(stored!==undefined)age=stored;
  else {age=null;gaps.push(gap(`household.retireAge for ${person} is missing; provide a retirement age assumption.`));}
  const rr=checkAssumption(args.realReturn ?? {value:0,source:'default'},{name:'realReturn',unit:'ratio',default:0,min:-0.05,max:0.1},ctx);assumptions.push(rr);
  const spending=args.spending?await resolveRef(args.spending,ctx,'spending'):(await (await import('../index.mjs')).callTool('spending',{operation:'total',definition:args.definition ?? 'household_spending',annualize:true},ctx)).total;
  if(Array.isArray(spending)||spending.unit!=='usd_per_year')bad('spending needs a usd_per_year figure');
  gaps.push(...spending.gaps);
  const start=age===null?null:dateAt(birth,age),years=age===null?null:Math.max(0,ageAccess-age);
  const notes=['Taxable values are before the cost of selling; see retirement.after_tax.'];
  const sums={taxable:0,cash:0,rothContributions:0,ruleOf55:0},inputs={taxable:[],cash:[],rothContributions:[],ruleOf55:[]};
  const records=accountRecords(ctx,data);
  for(const r of records) {
    const belongs=r.person===person||r.person==='joint';
    if(!belongs)continue;
    const snapshot=accountHistory(ctx.db,r.a.id,data.clock).at(-1);
    const value=snapshot?.value?.v ?? null,asOf=snapshot?.date ?? null;
    const eligible=qualifying(r,birth,gaps);
    let key;
    if(r.treatment==='cash')key='cash';
    else if(r.treatment==='taxable')key='taxable';
    else if(r.treatment.startsWith('roth')) {
      const basis=data.facts['accounts.rothBasis']?.[r.a.id];
      if(!Number.isFinite(basis)){gaps.push(gap(`${r.label} needs accounts.rothBasis; no contribution basis is counted.`));}
      else if(r.plan==='roth_401k')notes.push(`${r.label}: workplace Roth contribution basis is not separately withdrawable and is excluded unless the whole plan qualifies for access.`);
      else {sums.rothContributions+=basis;inputs.rothContributions.push({value:basis,unit:'usd',label:r.label,asOf,account:r.ref,factKey:'accounts.rothBasis'});}
    }
    if(eligible) {
      if(start&&r.separation<=start)key='ruleOf55';
      else notes.push(`${r.label} is excluded at the bridge start; employer-plan access begins only on ${r.separation}.`);
    }
    if(key) {
      if(value===null){gaps.push(gap(`${r.label} has no stored balance; accessible money is unavailable.`));sums[key]=null;}
      else if(sums[key]!==null)sums[key]+=value;
      inputs[key].push({value,unit:'usd',label:r.label,asOf,account:r.ref});
    }
  }
  const n=years===null?null:years*12,r=rr.value/12;
  const needed=n===null||spending.value===null?null:r===0?spending.value/12*n:spending.value/12*(-Math.expm1(-n*Math.log1p(r)))/r;
  const accessibleTotal=Object.values(sums).some(v=>v===null)?null:Object.values(sums).reduce((a,b)=>a+b,0);
  const allInputs=[spending,...Object.values(inputs).flat()],factRows=ctx.db.prepare('SELECT key,as_of FROM facts').all();
  const asOf=latest([...allInputs.map(i=>i.asOf),...factRows.map(f=>f.as_of)]);
  const prov={calc:'retirementBridge',formula:'Present value of monthly spending until standard access age, compared with stored accessible assets at retirement',inputs:allInputs,assumptions,
    sources:factRows.map(f=>({table:'facts',ids:[f.key],count:1})),packRefs:[pack(ACCESS_RULES.penaltyFreeAge.packRef),pack(ACCESS_RULES.fiveYear.packRef)]};
  const f=(v,unit,label)=>figure(v,unit,label,asOf,prov,gaps);
  const labels={taxable:'Accessible taxable investments',cash:'Accessible cash',rothContributions:'Accessible Roth contributions',ruleOf55:'Accessible employer plan money'};
  const accessible=Object.fromEntries(Object.entries(sums).map(([key,value])=>[key,figure(value,'usd',labels[key],asOf,{...prov,inputs:inputs[key],accounts:inputs[key].map(i=>i.account)},gaps)]));
  return {yearsToAccess:f(years,'years','Years to standard access'),spendingUntilAccess:f(needed,'usd','Spending until standard access'),accessible,
    shortfall:f(needed===null||accessibleTotal===null?null:Math.max(0,needed-accessibleTotal),'usd','Bridge shortfall'),surplus:f(needed===null||accessibleTotal===null?null:Math.max(0,accessibleTotal-needed),'usd','Bridge surplus'),
    exceptions:[{rule:'substantially_equal_periodic_payments',note:'Not counted; a separate schedule and professional review are required.',packRef:pack(ACCESS_RULES.penaltyFreeAge.packRef)},
      {rule:'hsa_past_medical_reimbursement',note:'Not counted; past qualified expenses and receipts are required.',packRef:pack(ACCESS_RULES.hsaAnyUse.packRef)}],notes,gaps:uniqueGaps(gaps)};
}

export const operations=[
 {name:'access',params:{people:{type:'string',enum:['owner','spouse','both']}},handler:access,route:'Access and RMDs',summary:'Per-person access milestones, account eligibility and missing facts.'},
 {name:'bridge',params:{retireAge:assumption,person:{type:'string',enum:['owner','spouse']},spending:{type:'object'},definition:{type:'string'},realReturn:assumption},handler:bridge,route:'Early retirement',summary:'Spending until standard access against cash, taxable, Roth basis and eligible employer money.'},
].map(op=>({...op,tool:'retirement',scope:'read',required:[],routes:[],referenceable:true,handler:async(args,ctx)=>bounded(bindFigures(await op.handler(args,ctx),'retirement',{operation:op.name,...args}))}));
