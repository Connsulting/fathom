import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance } from '../src/platform/db.mjs';
import { openReadOnlyHousehold } from '../src/platform/ready.mjs';
import { evaluateCategories, calibration, sampleRows, evalAdmission, main } from '../scripts/category-eval.mjs';
import { setOutbound } from '../src/platform/outbound.mjs';
import { FUNDING_SETTING } from '../src/platform/runtime.mjs';

test('deterministic holdout and aggregate calibration never return per-row values',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'category-eval-')); const s=await createInstance(dir,{mode:'real'});
  t.after(async ()=>{await s.db.close();await s.platform.close();rmSync(dir,{recursive:true,force:true});});
  await s.db.applySchema("INSERT INTO accounts (id,kind,name,mask) VALUES ('a','checking','Private label','3456')");
  for(let i=0;i<5;i++) await s.db.prepare("INSERT INTO transactions (account_id,date,description,amount,category,parser) VALUES ('a','2032-01-01',?,-25,?,'aggregator')").run('Secret payee '+i,i%2?'Business':'Groceries');
  const before=readFileSync(join(s.root,'fathom.sqlite')); const ro=await openReadOnlyHousehold({dataDir:dir},s.householdId);
  t.after(async ()=>{await ro.db.close();await ro.platform.close();});
  await assert.rejects(async ()=>await ro.db.applySchema("UPDATE settings SET value='true' WHERE key='mode'"),/readonly/i);
  const jev={stats:()=>({costUsd:.001,latenciesMs:[10,20]}),choose:async qs=>qs.map(q=>{
    assert.equal(q.state.category,undefined); assert.equal(q.state.mask,undefined);
    return {choice:'Groceries',confidence:.9,probabilities:{Groceries:.8,Business:.2}};
  })};
  const result=await evaluateCategories(ro.db,jev,{sampleSize:3});
  assert.equal(result.rows,3); assert.equal(result.evaluated,3);
  const output=JSON.stringify(result); for(const secret of ['Secret payee','Private label','Groceries','Business','3456'])assert.ok(!output.includes(secret));
  assert.deepEqual(before,readFileSync(join(s.root,'fathom.sqlite')));
  const rows=[{id:1},{id:2},{id:3}]; assert.deepEqual(sampleRows(rows,2),sampleRows([...rows].reverse(),2));
});

test('thresholds require precision over the entire accepted confidence tail',()=>{
  const scores=[...Array.from({length:99},()=>({confidence:.99,correct:true,top3:true})),{confidence:.99,correct:false,top3:true},...Array.from({length:10},()=>({confidence:.7,correct:false,top3:false}))];
  const c=calibration(scores); assert.equal(c.thresholds.autoApply,.99); assert.equal(c.thresholds.review,.7);
  assert.equal(calibration([{confidence:.9,correct:false,top3:false}]).thresholds.autoApply,null);
  assert.equal(calibration([...Array.from({length:95},()=>({confidence:.91,correct:true})),
    ...Array.from({length:5},()=>({confidence:.91,correct:false}))]).thresholds.autoApply,.91);
});

test('chronological replay excludes current labels, same-date labels, future rows and future Confirm answers',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'category-replay-')), s=await createInstance(dir,{mode:'real'});
  t.after(async ()=>{await s.db.close();await s.platform.close();rmSync(dir,{recursive:true,force:true});});
  await s.db.applySchema("INSERT INTO accounts (id,kind,name) VALUES ('a','checking','Synthetic account')");
  for(let day=1;day<=7;day++) await s.db.prepare("INSERT INTO transactions (account_id,date,description,amount,category,parser) VALUES ('a',?,'Cobalt Market',-45,?,'aggregator')")
    .run(`2032-01-0${day}`,day<=5?'Groceries':'Business');
  const seen=[];
  const jev={isOn:()=>true,stats:()=>({costUsd:0,latenciesMs:[]}),choose:async qs=>qs.map(q=>{
    seen.push(q);
    for(const example of q.state.examples??[]) assert.ok(example.date<q.state.date);
    assert.equal(q.state.category,undefined);
    return {choice:'Groceries',confidence:.96,probabilities:{Groceries:.96,Business:.04}};
  })};
  const result=await evaluateCategories(s.db,jev,{sampleSize:7});
  assert.equal(result.rows,7);assert.equal(result.evaluated,7);
  assert.equal(result.stages.history.rows,3);assert.equal(result.stages.history.correct,2);
  assert.equal(result.stages.model.rows,4);
  assert.ok(seen.some(q=>q.state.date==='2032-01-01' && !q.state.examples));
});

test('read-only store refuses missing identity and missing eval schema without changing them',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'category-ro-')); const s=await createInstance(dir,{mode:'real'});
  t.after(async ()=>{await s.db.close();await s.platform.close();rmSync(dir,{recursive:true,force:true});});
  await s.db.applySchema('DROP TABLE transaction_category_imports');
  await assert.rejects(async ()=>await openReadOnlyHousehold({dataDir:dir},s.householdId),/store_schema_required/);
  await assert.rejects(async ()=>await openReadOnlyHousehold({dataDir:dir},'hh-synthetic-unknown'),/household_unavailable/);
  assert.equal((await s.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='transaction_category_imports'").get()).n,0);
});

test('the eval takes the household engine pause and instance funding before any Jev call',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'category-adm-')); const s=await createInstance(dir,{mode:'real'});
  t.after(async ()=>{await s.db.close();await s.platform.close();rmSync(dir,{recursive:true,force:true});});
  const fund=async v=>await s.platform.prepare('INSERT INTO platform_settings (key,value,updated_at) VALUES (?,?,0) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(FUNDING_SETTING,JSON.stringify(v));
  await setOutbound(s.platform,s.householdId,{engine:false});
  assert.equal(await evalAdmission(s.platform,s.householdId),'engine_paused');
  await setOutbound(s.platform,s.householdId,{engine:true});
  assert.equal(await evalAdmission(s.platform,s.householdId),'funding_unavailable');
  await fund(0); assert.equal(await evalAdmission(s.platform,s.householdId),'funding_unavailable');
  await fund(5); assert.equal(await evalAdmission(s.platform,s.householdId),null);
  await setOutbound(s.platform,s.householdId,{engine:false});
  const errors=[]; const log=console.error; console.error=m=>errors.push(String(m)); t.after(()=>{console.error=log;});
  assert.equal(await main(['--household',s.householdId,dir,'3','0.01']),1);
  console.error=log; assert.deepEqual(errors,['category_eval_failed: engine_paused']);
});
