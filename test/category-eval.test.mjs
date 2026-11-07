import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance } from '../src/platform/db.mjs';
import { openServedStore } from '../src/platform/ready.mjs';
import { evaluateCategories, calibration, sampleRows } from '../scripts/category-eval.mjs';

test('deterministic holdout and aggregate calibration never return per-row values',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'category-eval-')); const s=createInstance(dir,{mode:'real'});
  t.after(()=>{s.db.close();s.platform.close();rmSync(dir,{recursive:true,force:true});});
  s.db.exec("INSERT INTO accounts (id,kind,name,mask) VALUES ('a','checking','Private label','3456')");
  for(let i=0;i<5;i++) s.db.prepare("INSERT INTO transactions (account_id,date,description,amount,category,parser) VALUES ('a','2032-01-01',?,-25,?,'aggregator')").run('Secret payee '+i,i%2?'Business':'Groceries');
  const before=readFileSync(join(dir,'fathom.sqlite')); const ro=openServedStore({dataDir:dir},{readOnly:true});
  t.after(()=>{ro.db.close();ro.platform.close();});
  assert.throws(()=>ro.db.exec("UPDATE settings SET value='true' WHERE key='mode'"),/readonly/i);
  const jev={stats:()=>({costUsd:.001,latenciesMs:[10,20]}),choose:async qs=>qs.map(q=>{
    assert.equal(q.state.category,undefined); assert.equal(q.state.mask,undefined);
    return {choice:'Groceries',confidence:.9,probabilities:{Groceries:.8,Business:.2}};
  })};
  const result=await evaluateCategories(ro.db,jev,{sampleSize:3});
  assert.equal(result.rows,3); assert.equal(result.evaluated,3);
  const output=JSON.stringify(result); for(const secret of ['Secret payee','Private label','Groceries','Business','3456'])assert.ok(!output.includes(secret));
  assert.deepEqual(before,readFileSync(join(dir,'fathom.sqlite')));
  const rows=[{id:1},{id:2},{id:3}]; assert.deepEqual(sampleRows(rows,2),sampleRows([...rows].reverse(),2));
});

test('thresholds require precision over the entire accepted confidence tail',()=>{
  const scores=[...Array.from({length:99},()=>({confidence:.99,correct:true,top3:true})),{confidence:.99,correct:false,top3:true},...Array.from({length:10},()=>({confidence:.7,correct:false,top3:false}))];
  const c=calibration(scores); assert.equal(c.thresholds.autoApply,.99); assert.equal(c.thresholds.review,.7);
  assert.equal(calibration([{confidence:.9,correct:false,top3:false}]).thresholds.autoApply,null);
});

test('read-only store refuses missing identity and missing eval schema without changing them',t=>{
  const dir=mkdtempSync(join(tmpdir(),'category-ro-')); const s=createInstance(dir,{mode:'real'});
  t.after(()=>{s.db.close();s.platform.close();rmSync(dir,{recursive:true,force:true});});
  s.db.exec('DROP TABLE transaction_category_imports');
  assert.throws(()=>openServedStore({dataDir:dir},{readOnly:true}),/store_schema_required/);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='transaction_category_imports'").get().n,0);
});
