import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openReadOnlyHousehold } from '../src/platform/ready.mjs';
import { householdArg } from '../src/platform/cli.mjs';
import { parseJson } from '../src/store/db.mjs';
import { createJev, categoryQuestions } from '../src/categories/jev.mjs';
import { sourceBucket } from '../src/categories/resolve.mjs';

export function sampleRows(rows,size) {
  const hash=r=>createHash('sha256').update(`category-eval-v1:${r.id}`).digest('hex');
  return rows.toSorted((a,b)=>hash(a).localeCompare(hash(b))).slice(0,size);
}
export function calibration(scores) {
  const threshold=target=>[...new Set(scores.map(s=>s.confidence))].sort((a,b)=>a-b).find(c=>{
    const tail=scores.filter(s=>s.confidence>=c); return tail.filter(s=>s.correct).length/tail.length>=target;
  })??null;
  const buckets=Array.from({length:10},(_,i)=>{
    const rows=scores.filter(s=>Math.min(9,Math.floor(s.confidence*10))===i), correct=rows.filter(s=>s.correct).length;
    return {from:i/10,to:(i+1)/10,rows:rows.length,correct,accuracy:rows.length?correct/rows.length:null};
  });
  return {buckets,thresholds:{autoApply:threshold(.97),review:threshold(.85)}};
}
const percentile=(values,p)=>values.length?values.toSorted((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]:null;
export async function evaluateCategories(db,jev,{sampleSize=1000}={}) {
  const accounts=db.prepare('SELECT id,kind,mask FROM accounts').all();
  const rows=db.prepare(`SELECT t.id,t.account_id,t.date,t.amount,t.description,coalesce(i.category,t.category) AS truth,
    coalesce(i.parser,t.parser) AS parser FROM transactions t LEFT JOIN transaction_category_imports i ON i.transaction_id=t.id`).all()
    .filter(t=>t.parser==='aggregator' && sourceBucket(t.parser,t.truth));
  const names=[...new Set(rows.map(t=>t.truth))].sort(), sample=sampleRows(rows,sampleSize), scores=[];
  const householdNames=parseJson(db.prepare("SELECT value FROM facts WHERE key='household.names'").get()?.value,{});
  let stopped;
  if(names.length>=2) for(let i=0;i<sample.length;i+=10) {
    const batch=sample.slice(i,i+10);
    try {
      const answers=await jev.choose(categoryQuestions(batch,{accounts,householdNames,categories:names}));
      for(const [j,a] of answers.entries()) scores.push({confidence:a.confidence,correct:a.choice===batch[j].truth,
        top3:Object.entries(a.probabilities).sort((a,b)=>b[1]-a[1]).slice(0,3).some(([c])=>c===batch[j].truth)});
    } catch(error) {stopped=['jev_budget','jev_unavailable','jev_bad_response'].includes(error.code)?error.code:'eval_failed';break;}
  }
  const stats=jev.stats();
  return {rows:sample.length,evaluated:scores.length,top1:scores.length?scores.filter(s=>s.correct).length/scores.length:null,
    top3:scores.length?scores.filter(s=>s.top3).length/scores.length:null,...calibration(scores),costUsd:stats.costUsd,
    latencyMs:{p50:percentile(stats.latenciesMs,.5),p95:percentile(stats.latenciesMs,.95)},...(stopped?{stopped}:{})};
}
export async function main(argv=process.argv.slice(2)) {
  let store;
  try {
    const {householdId,rest}=householdArg(argv);
    const path=rest[0]??process.env.FATHOM_DATA;
    const sampleSize=Number(rest[1]??1000), maxCostUsd=Number(rest[2]??1);
    if(!path || !Number.isInteger(sampleSize) || sampleSize<1 || sampleSize>10000 || !Number.isFinite(maxCostUsd) || maxCostUsd<0 || maxCostUsd>1) throw new Error();
    store=openReadOnlyHousehold({dataDir:resolve(path)},householdId);
    const jev=await createJev({maxCostUsd,maxTokens:Math.floor(maxCostUsd/(.042/1_000_000))});
    if(!jev.isOn()) throw new Error();
    const result=await evaluateCategories(store.db,jev,{sampleSize});
    console.log(JSON.stringify(result)); return result.stopped?1:0;
  } catch {console.error('category_eval_failed');return 1;}
  finally {store?.db.close();store?.platform.close();}
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href) process.exitCode=await main();
