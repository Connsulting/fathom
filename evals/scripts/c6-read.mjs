import { callTool } from '../../src/tools/index.mjs';
import { isoFromLabel } from '../../demo/ledger.mjs';

export async function script({ turn,db,clock }) {
  const ctx = {db,clock,channel:'ask',ownerStatements:()=>[turn.question]};
  const calls = [];
  const results = [];
  const call = async (name,args) => {
    calls.push({name,args});
    const result = await callTool(name,args,ctx);
    results.push(result);
    return result;
  };
  const owner = value => ({value,source:'owner',evidence:turn.question});
  const targetArgs = {};
  for (const req of turn.required.filter(r=>r.name==='retirement' && r.operation==='target')) {
    for (const p of req.predicates) {
      if (p.path==='withdrawalRate.value') targetArgs.withdrawalRate=owner(p.value);
      else if (p.path==='realReturn.value') targetArgs.realReturn=owner(p.value);
      else if (['definition','roundTo'].includes(p.path)) targetArgs[p.path]=p.value;
    }
  }
  let primary;
  if (turn.required.some(r=>r.operation==='after_tax')) {
    const tax = await call('tax',{operation:'estimate'});
    const args = {operation:'after_tax',ordinaryRate:{ref:tax.marginal.federal.ref},capitalGainsRate:{ref:tax.marginal.capitalGains.ref},stateRate:{ref:tax.marginal.state.ref}};
    if (turn.required.some(r=>r.predicates.some(p=>p.path==='hypothetical'))) {
      args.hypothetical=[{treatment:'pretax',value:owner(15000000)},{treatment:'taxable',value:owner(15000000)}];
    } else args.kinds=['taxable','brokerage'];
    const out=await call('retirement',args);
    primary=out.rows.find(r=>r.afterTax.value!==null)?.afterTax;
  } else if (turn.required.some(r=>r.operation==='growth')) {
    const base=await call('retirement',{operation:'target'});
    const monthly=turn.required.some(r=>r.predicates.some(p=>p.path==='solve' && p.value==='monthly'));
    const args={operation:'growth',solve:monthly ? 'monthly' : 'balance',balance:{ref:base.investedNow.ref}};
    if (monthly) {args.target={ref:base.target.ref};args.byAge={person:'owner',age:55};}
    else {args.years=10;args.monthlyContribution={ref:base.monthlySavings.ref};}
    primary=(await call('retirement',args)).figure;
  } else if (turn.required.some(r=>r.name==='calculate')) {
    const base=await call('retirement',{operation:'target'});
    const changed=await call('retirement',{operation:'target',monthlySavings:{expr:{operation:'add',operands:[{ref:base.monthlySavings.ref},{assumption:{...owner(1000),name:'extraMonthlySavings',unit:'usd_per_month'}}]}}});
    if (base.months && changed.months) primary=(await call('calculate',{operation:'subtract',operands:[{ref:base.months.ref},{ref:changed.months.ref}],label:'Months saved'})).figure;
    else primary=(await call('calculate',{operation:'subtract',operands:[{ref:base.gap.ref},{ref:changed.gap.ref}],label:'Change in investment gap'})).figure;
  } else {
    if (/excluding mortgage/i.test(turn.question)) targetArgs.definition='core_living';
    if (turn.expected.some(e=>e.kind==='portfolio')) targetArgs.roundTo=1;
    if (turn.expected.some(e=>e.kind==='portfolio')) {
      if (turn.required.some(r=>r.predicates.some(p=>p.path==='definition'))) await call('retirement',{operation:'target',...targetArgs});
      const meta=JSON.parse(db.prepare("SELECT value FROM content WHERE key='meta'").get().value);
      const through=isoFromLabel(meta.dataThrough),date=new Date(through);
      const complete=date.getUTCDate()===new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();
      const to=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+(complete ? 1 : 0),0)).toISOString().slice(0,7);
      const spending=await call('spending',{operation:'total',definition:'core_living',annualize:true,window:'custom',from:`${date.getUTCFullYear()}-01`,to});
      delete targetArgs.definition;
      targetArgs.spending=spending.total.ref;
    }
    primary=(await call('retirement',{operation:'target',...targetArgs})).target;
  }
  const gaps=[];
  const collect=v=>{
    if (!v || typeof v!=='object') return;
    if (Array.isArray(v.gaps)) gaps.push(...v.gaps);
    if (v.unit && Object.hasOwn(v,'value')) return;
    for (const [key,child] of Object.entries(v)) if (key!=='provenance') collect(child);
  };
  for (const result of results) collect(result);
  const messages=[...new Set(gaps.map(g=>g.message))];
  const text=[primary?.value!==null && primary ? `The returned result is ${primary.quote}.` : 'The requested figure is unavailable.',
    ...messages.slice(0,2),...(/15 million/.test(turn.question) ? ['The brokerage tax depends on cost basis. What is the basis?'] : [])].join(' ');
  return [{toolCalls:calls,costUsd:0},{text,costUsd:0}];
}
