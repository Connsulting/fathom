import { OBLIGATION_RULES } from '../../calc/classes.mjs';
import { addMonths, mortgagePayoff, dependentChanges } from '../../calc/obligations.mjs';
import { envelope } from '../../calc/figure.mjs';
import { bindFigures } from '../../calc/aggregate.mjs';
import { readInput } from './spending.mjs';
import { bounded, uniqueGaps } from './balances.mjs';
import { checkAssumption } from '../assumption-evidence.mjs';
import { resolveRef } from '../refs.mjs';
import { ToolError } from '../errors.mjs';

const bad = message => { throw new ToolError('bad_input',message); };
const gap = message => ({code:'missing_fact',message});
const choice = values => ({enum:values});
const kinds = ['mortgage','childcare','plan529'];
const obligations = {type:'array',maxItems:3,items:choice(kinds)};
const changes = {type:'array',maxItems:10,items:{type:'object',properties:{kind:choice(kinds),stage:choice(['school_age','after_care_end']),newMonthly:{type:'object'}},required:['kind','newMonthly']}};
const pack = kind => { const r=OBLIGATION_RULES[kind].packRef; return {packId:r.pack,entryId:r.entry}; };
const latest = dates => dates.filter(Boolean).sort().at(-1) ?? null;
const factSources = (ctx,keys) => keys.flatMap(key=>ctx.db.prepare('SELECT key,as_of FROM facts WHERE key=?').all(key));
const total = async (ctx,args) => (await import('../index.mjs')).callTool('spending',{operation:'total',...args},ctx);
const figure = (value,unit,label,asOf,provenance,gaps) => envelope(value,{unit,label,asOf,kind:'p',provenance,gaps,...(value===null ? {unavailable:'missing_fact'} : {})});

async function schedule(args,ctx) {
  const {clock,facts,accounts}=readInput(ctx), horizon=addMonths(clock,(args.horizonYears ?? 30)*12);
  for(const change of args.changes ?? [])if(Object.keys(change).some(k=>!['kind','stage','newMonthly'].includes(k)))bad('Unknown change field');
  const assumptions=(args.changes ?? []).map(c=>({...c,record:checkAssumption(c.newMonthly,{name:`${c.kind} ${c.stage ?? 'change'}`,unit:'usd_per_month',min:0},ctx)}));
  const seen=new Set();
  for (const a of assumptions) { const key=`${a.kind}:${a.stage ?? ''}`; if(seen.has(key))bad('Duplicate change assumption');seen.add(key); }
  const rows=[];
  for (const kind of [...new Set(args.obligations ?? kinds)]) {
    const key=`obligations.${kind}`, missing=[], gaps=[], keys=[key], balanceInputs=[];
    let observed;
    if(kind==='plan529') observed=await total(ctx,{measure:'inflow',scope:'all',include:{accounts:accounts.filter(a=>a.kind==='529'&&!a.archived_at).map(a=>a.id)}});
    else observed=await total(ctx,{include:{classes:[kind==='mortgage'?'debt_service':'childcare']}});
    const stored=facts[key];
    const monthly=kind==='mortgage'&&stored ? stored.monthlyPayment : observed.perMonth.value;
    let events=[];
    if(kind==='mortgage') {
      let date=stored?.payoffDate ?? null,derivedFrom='fact';
      if(!date && stored) {
        let balance=stored.balance;
        const loans=accounts.filter(a=>a.kind==='loan'&&!a.archived_at && /mortgage/i.test(a.name));
        if(loans.length===1) {
          const row=ctx.db.prepare('SELECT id,amount,date FROM balances WHERE account_id=? AND date<=? ORDER BY date DESC LIMIT 1').get(loans[0].id,clock);
          if(row) {balance=Math.abs(row.amount); balanceInputs.push({value:balance,unit:'usd',label:'Mirrored mortgage balance',asOf:row.date,provenance:{sources:[{table:'balances',ids:[row.id],count:1}]}});}
        }
        date=mortgagePayoff({...stored,balance},clock,(args.horizonYears ?? 30)*12);derivedFrom='amortization';
      }
      if(!date || !stored) {missing.push(key);gaps.push(gap('Mortgage payoff needs obligations.mortgage with balance, rate, payment, escrow and a payoff date or an amortizing payment within the horizon.'));}
      if(date)events=[{stage:'payoff',date,newValue:stored?.escrowMonthly ?? null,derivedFrom,reason:'Mortgage principal and interest end; stated escrow continues as housing.'}];
    } else {
      const birthDates=facts['household.dependentBirthDates'];
      const ages=facts['household.dependentAges'] ?? facts['household.birthYears']?.dependents?.map(y=>Number(clock.slice(0,4))-y);
      keys.push(birthDates ? 'household.dependentBirthDates' : facts['household.dependentAges'] ? 'household.dependentAges' : 'household.birthYears');
      events=dependentChanges({birthDates,ages,clock,kind});
      if(!events.length && kind==='childcare' && facts['obligations.childcareChangeDate']) {
        events=[{stage:'school_age',date:facts['obligations.childcareChangeDate'],derivedFrom:'fact',precise:true}];keys.push('obligations.childcareChangeDate');
      }
      if(!events.length) {missing.push('household.dependentBirthDates');gaps.push(gap(`${kind} needs household.dependentBirthDates or household.dependentAges${kind==='childcare'?' or obligations.childcareChangeDate':''}.`));}
      if(events.some(e=>e.precise===false))gaps.push(gap('Dependent ages give year precision only; dates use year end.'));
      events=events.map(e=>({...e,unattributed:kind==='childcare'&&events.some(later=>later.stage===e.stage&&later.date>e.date)}));
      events=events.filter(e=>e.date>clock&&e.date<=horizon).map(e=>{
        const field=e.stage==='school_age'?'schoolAgeMonthly':'afterCareEndMonthly';
        const override=assumptions.find(a=>a.kind===kind && (a.stage===e.stage || a.stage===undefined));
        const newValue=kind==='plan529'?0 : stored?.[field] ?? override?.record.value ?? (e.stage==='after_care_end'?0:null);
        if(newValue===null){missing.push(key);gaps.push(gap(`Missing ${key}.${field}; this change is unavailable and is not applied.`));}
        return {...e,newValue,amountSource:kind==='plan529'?'pack_default':stored?.[field]!==undefined?'fact':override?'assumption':newValue===0?'pack_default':null,
          assumption:stored?.[field]===undefined?override?.record:null,reason:kind==='plan529'?'Contributions stop at the default college age.':e.stage==='school_age'?'School begins at the pack entry age and cutoff.':'After-school care ends at the pack age.'};
      });
    }
    const sources=factSources(ctx,keys),asOf=latest([observed.perMonth.asOf,...sources.map(s=>s.as_of),...balanceInputs.map(b=>b.asOf)]);
    const prov={calc:'obligationSchedule',formula:'Stored obligation amounts and dates, amortization or dependent age rules',inputs:[observed.perMonth,...balanceInputs],sources:sources.map(s=>({table:'facts',ids:[s.key],count:1})),packRefs:[pack(kind)]};
    const f=(value,unit,label,extra={})=>figure(value,unit,label,asOf,{...prov,...extra},gaps);
    const eventRows=events.map(e=>({stage:e.stage,...(e.dependent===undefined?{}:{dependent:e.dependent}),unattributed:e.unattributed ?? false,date:f(e.date,'date','Obligation change date'),
      newMonthly:f(e.newValue,'usd_per_month','New monthly obligation',{assumptions:e.assumption?[e.assumption]:[]}),reason:e.reason,derivedFrom:e.derivedFrom,amountSource:e.amountSource ?? 'fact'}));
    rows.push({kind,label:kind==='plan529'?'Education contributions':kind==='mortgage'?'Mortgage':'Childcare',monthly:f(monthly,'usd_per_month','Current monthly obligation'),
      observedMonthly:observed.perMonth,changes:eventRows,endDate:f(events.at(-1)?.date ?? null,'date','Obligation end date'),missing:[...new Set(missing)],gaps});
  }
  return {obligations:rows,gaps:uniqueGaps(rows.flatMap(r=>[...r.gaps,...r.observedMonthly.gaps]))};
}

async function projection(args,ctx) {
  if(args.base && args.definition!==undefined)bad('projection takes base or definition, not both');
  if(args.base && (args.base.tool!=='spending'||args.base.args?.operation!=='total'))bad('base must reference spending.total');
  const baseArgs=args.base ? {...args.base.args} : {definition:args.definition ?? 'household_spending',annualize:true};
  delete baseArgs.operation;
  const base=args.base ? await resolveRef(args.base,ctx,'base') : (await total(ctx,baseArgs)).total;
  if(Array.isArray(base)||base.unit!=='usd_per_year'||(args.base&&args.base.path!=='total'))bad('base must be the annualized spending.total total figure');
  if((baseArgs.measure ?? 'spending')!=='spending')bad('base must measure spending');
  const {clock}=readInput(ctx),years=args.years ?? 10;
  const sched=await schedule({...args,horizonYears:years},ctx);
  const selected=await total(ctx,{...baseArgs,groupBy:'class',annualize:true,limit:200});
  const gaps=uniqueGaps([...base.gaps,...sched.gaps]);
  const states=sched.obligations.map(row=>({row,remaining:row.kind==='plan529'?0:(selected.groups.find(g=>g.key===(row.kind==='mortgage'?'debt_service':'childcare'))?.figure.value ?? (base.value===null?null:0))/12}));
  const events=states.flatMap(state=>state.row.changes.filter(c=>c.date.value>clock).map(change=>({state,change}))).sort((a,b)=>a.change.date.value.localeCompare(b.change.date.value));
  const output=[];let annual=base.value;
  for(let i=0;i<years;i++) {
    const year=Number(clock.slice(0,4))+i,end=`${year+1}-01-01`;
    let value=annual,adjustment=0;
    const applied=[];
    for(const {state,change} of events.filter(e=>Number(e.change.date.value.slice(0,4))===year)) {
      const amount=change.newMonthly.value,old=state.remaining;
      const unattributed=change.unattributed;
      if(unattributed)gaps.push(gap('Childcare is a household total with no per-dependent allocation; an earlier child changing care stages cannot replace the remaining household amount.'));
      const available=amount!==null&&old!==null&&annual!==null&&!unattributed;
      const next=available&&old>0?(state.row.kind==='mortgage'?Math.min(old,amount):amount):old;
      const delta=available?(next-old)*12:null;
      const span=(Date.parse(end)-Date.parse(change.date.value))/(Date.parse(end)-Date.parse(`${year}-01-01`));
      if(available){state.remaining=next;annual+=delta;adjustment+=delta*span;}
      applied.push({kind:state.row.kind,stage:change.stage,...(change.dependent===undefined?{}:{dependent:change.dependent}),date:change.date,delta:figure(delta,'usd_per_year','Annual spending change',base.asOf,{calc:'spendingProjection',inputs:[base,change.newMonthly],packRefs:[pack(state.row.kind)]},gaps),applied:available&&delta!==0,
        note:old===0?'This obligation is outside the base selection; no spending drop.':change.reason});
    }
    if(value!==null)value+=adjustment;
    output.push({year,spending:figure(value,'usd_per_year','Projected annual spending',latest([base.asOf,...sched.obligations.map(r=>r.monthly.asOf)]),{calc:'spendingProjection',formula:'Base spending plus dated changes, prorated by days in the calendar year; removals capped to the selected obligation amount',inputs:[base,...sched.obligations.map(r=>r.monthly)]},gaps),changes:applied});
  }
  return {years:output,notes:["Today's dollars; no inflation. Changes apply on their dates and remove only the obligation portion inside the base."],gaps};
}

export const operations=[
  {name:'obligations',params:{obligations,horizonYears:{type:'integer',minimum:1,maximum:40},changes},handler:schedule,route:'Obligation dates',summary:'Dates and amounts.'},
  {name:'projection',params:{base:{type:'object'},definition:{type:'string'},years:{type:'integer',minimum:1,maximum:40},obligations,changes},handler:projection,route:'Future spending',summary:'Annual projection.'},
].map(op=>({...op,tool:'spending',scope:'read',required:[],routes:[],referenceable:true,handler:async(args,ctx)=>bounded(bindFigures(await op.handler(args,ctx),'spending',{operation:op.name,...args}))}));
