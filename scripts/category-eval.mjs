import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve,basename,dirname } from 'node:path';
import { openServedStore } from '../src/platform/ready.mjs';
import { DB_FILE, parseJson, getSetting } from '../src/store/db.mjs';
import { createJev, categoryQuestions } from '../src/categories/jev.mjs';
import { sourceBucket, resolveCategories, createHistoryIndex, historyExamples, CATEGORY_TABLES } from '../src/categories/resolve.mjs';
import { loadCategoryInputs } from '../src/categories/store.mjs';

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
  return {buckets,thresholds:{autoApply:threshold(.95),review:threshold(.85)}};
}
const percentile=(values,p)=>values.length?values.toSorted((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*p)-1)]:null;
export async function evaluateCategories(db,jev,{sampleSize=1000}={}) {
  const input=loadCategoryInputs(db);
  const rows=input.transactions.map(t=>({...t,truth:t.imported_category??t.category,truthParser:t.category_parser??t.parser}))
    .filter(t=>t.truthParser==='aggregator' && sourceBucket(t.truthParser,t.truth));
  const sample=sampleRows(rows,sampleSize), scores=[], stages={history:[],rules:[],model:[]};
  const names=Object.keys(CATEGORY_TABLES.aggregator).filter(c=>sourceBucket('aggregator',c));
  const householdNames=parseJson(db.prepare("SELECT value FROM facts WHERE key='household.names'").get()?.value,{});
  const pending=[];
  for(const row of sample) {
    const target={...row,category:null,imported_category:null,category_declined:0,truth:undefined,truthParser:undefined};
    const historical={...input,transactions:[...input.transactions.filter(t=>t.date<row.date),target],
      corrections:input.corrections.filter(c=>c.transaction_id!==row.id && c.updated_at<row.date),
      merchantRules:input.merchantRules.filter(r=>r.updated_at<row.date),sourceRules:input.sourceRules.filter(r=>r.updated_at<row.date),
      guesses:[]};
    const resolved=resolveCategories(historical).get(row.id);
    if(['merchant','structural'].includes(resolved.layer)) {
      const stage=resolved.layer==='merchant'?'history':'rules';
      // Transfer aliases all exclude the same cash flow from spending; retain exact-label precision too.
      const exact=resolved.category===row.truth;
      stages[stage].push({correct:exact || (stage==='rules' && resolved.bucket==='transfer' && sourceBucket(row.truthParser,row.truth)==='transfer'),exact});
    } else {
      pending.push({row,question:categoryQuestions([target],{accounts:input.accounts,householdNames,categories:names,
        examples:[historyExamples(target,historical,createHistoryIndex(historical))]})[0]});
    }
  }
  let stopped;
  if(jev?.isOn?.()!==false) for(let i=0;i<pending.length;i+=10) {
    const batch=pending.slice(i,i+10);
    try {
      const answers=await jev.choose(batch.map(b=>b.question));
      for(const [j,a] of answers.entries()) {
        const score={confidence:a.confidence,correct:a.choice===batch[j].row.truth,
          top3:Object.entries(a.probabilities).sort((a,b)=>b[1]-a[1]).slice(0,3).some(([c])=>c===batch[j].row.truth)};
        scores.push(score);stages.model.push(score);
      }
    } catch(error) {stopped=['jev_budget','jev_unavailable','jev_bad_response','outbound_paused'].includes(error.code)?error.code:'eval_failed';break;}
  }
  const calibrated=calibration(scores), accepted=scores.filter(s=>calibrated.thresholds.autoApply!=null && s.confidence>=calibrated.thresholds.autoApply);
  const summarize=rows=>({rows:rows.length,correct:rows.filter(s=>s.correct).length,
    precision:rows.length?rows.filter(s=>s.correct).length/rows.length:null,coverage:sample.length?rows.length/sample.length:0});
  const stats=jev.stats();
  return {rows:sample.length,evaluated:Object.values(stages).reduce((n,s)=>n+s.length,0),
    stages:Object.fromEntries(Object.entries(stages).map(([k,v])=>[k,{...summarize(v),
      ...(k==='rules'?{comparison:'category or equivalent transfer category',exactCategoryPrecision:v.length?v.filter(s=>s.exact).length/v.length:null}:{})}])),modelAuto:summarize(accepted),
    top1:scores.length?scores.filter(s=>s.correct).length/scores.length:null,
    top3:scores.length?scores.filter(s=>s.top3).length/scores.length:null,...calibrated,costUsd:stats.costUsd,
    latencyMs:{p50:percentile(stats.latenciesMs,.5),p95:percentile(stats.latenciesMs,.95)},...(stopped?{stopped}:{})};
}
export async function main(argv=process.argv.slice(2)) {
  let store;
  try {
    const path=argv[0]??process.env.FATHOM_DATA;
    const sampleSize=Number(argv[1]??1000), maxCostUsd=Number(argv[2]??.05);
    if(!path || !Number.isInteger(sampleSize) || sampleSize<1 || sampleSize>10000 || !Number.isFinite(maxCostUsd) || maxCostUsd<0 || maxCostUsd>1) throw new Error();
    const absolute=resolve(path);
    store=openServedStore({dataDir:basename(absolute)===DB_FILE?dirname(absolute):absolute},{readOnly:true});
    const jev=await createJev({maxCostUsd,canSend:()=>getSetting(store.db,'engine',{on:true})?.on!==false});
    if(!jev.isOn()) throw new Error();
    const result=await evaluateCategories(store.db,jev,{sampleSize});
    console.log(JSON.stringify(result)); return result.stopped?1:0;
  } catch {console.error('category_eval_failed');return 1;}
  finally {store?.db.close();store?.platform.close();}
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href) process.exitCode=await main();
