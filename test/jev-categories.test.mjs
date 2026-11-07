import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance } from '../src/platform/db.mjs';
import { setSetting } from '../src/store/db.mjs';
import { guessCategories } from '../src/categories/guess.mjs';
import { confidenceBand, CONFIDENCE_POLICY } from '../src/categories/policy.mjs';
import { loadCategoryInputs, queueCategoryChecks } from '../src/categories/store.mjs';
import { resolveCategories } from '../src/categories/resolve.mjs';
import { ask, getItem, reopenItem, reviseItem, pendingItems, KIND_OPTIONS } from '../src/ingest/confirm.mjs';
import { bestGuess } from '../src/ingest/bestguess.mjs';
import { guessClosedOptions } from '../src/ingest/jev.mjs';

const policy={autoApply:.95,review:.7};
function store(t) {
  const dir=mkdtempSync(join(tmpdir(),'jev-category-')); const s=createInstance(dir,{mode:'real'});
  t.after(()=>{s.db.close();s.platform.close();rmSync(dir,{recursive:true,force:true});});
  s.db.exec("INSERT INTO accounts (id,kind,name,mask) VALUES ('a','checking','Everyday','3456')");
  setSetting(s.db,'clock','2032-11-05');
  return s.db;
}
function transaction(db,description='Synthetic Shop',patch={}) {
  return Number(db.prepare('INSERT INTO transactions (account_id,date,amount,description,category,parser) VALUES (?,?,?,?,?,?)')
    .run('a',patch.date??'2032-10-03',patch.amount??-20,description,patch.category??null,patch.parser??'simplefin').lastInsertRowid);
}
const provider=(confidence)=>({isOn:()=>true,stats:()=>({costUsd:0}),choose:async qs=>qs.map(()=>({choice:'Groceries',confidence,probabilities:{Groceries:.9,Business:.1}}))});
const resolutions=db=>resolveCategories(loadCategoryInputs(db));
function vocabulary(db) { transaction(db,'Different historical merchant',{category:'Groceries',parser:'aggregator'}); transaction(db,'Historical service',{category:'Business',parser:'aggregator'}); }

test('one threshold table classifies exact boundaries and disables unsupported bands',()=>{
  assert.ok(Object.hasOwn(CONFIDENCE_POLICY,'autoApply')); assert.equal(confidenceBand(.95,policy),'auto');
  assert.equal(confidenceBand(.7,policy),'review'); assert.equal(confidenceBand(.69,policy),'uncategorized');
  assert.equal(confidenceBand(1,{autoApply:null,review:null}),'uncategorized');
});

test('review stays Uncategorized, crosses the spending window and amount filters, and survives queue sweep',async t=>{
  const db=store(t); vocabulary(db); const id=transaction(db,'Small old merchant',{date:'2031-01-01'});
  await guessCategories(db,provider(.8),{policy});
  assert.equal(resolutions(db).get(id).layer,'uncategorized');
  const item=pendingItems(db).find(i=>i.subject===String(id)); assert.ok(item);
  const g=bestGuess(db,item,{}); assert.equal(g.option,'Groceries'); assert.match(g.evidence,/Jev guess, 80% confident/);
  for(let i=0;i<15;i++)transaction(db,'More merchant '+i);
  queueCategoryChecks(db); assert.ok(getItem(db,item.id)); assert.equal(bestGuess(db,getItem(db,item.id),{}).confidence,.8);
});

test('below-review attempts are persisted and never re-sent or applied',async t=>{
  const db=store(t); vocabulary(db); const id=transaction(db); let calls=0; const jev=provider(.3);
  const choose=jev.choose; jev.choose=async q=>{calls++;return choose(q);};
  await guessCategories(db,jev,{policy}); await guessCategories(db,jev,{policy});
  assert.equal(calls,1); assert.equal(resolutions(db).get(id).category,'Uncategorized');
  assert.ok(!pendingItems(db).some(i=>i.subject===String(id)));
});

test('auto application is provenance-marked, does not teach memory, and undo/revise survive an import',async t=>{
  const db=store(t); vocabulary(db); const id=transaction(db);
  await guessCategories(db,provider(.99),{policy});
  const item=db.prepare("SELECT id FROM confirm_items WHERE kind='transaction_category' AND subject=?").get(String(id));
  assert.equal(getItem(db,item.id).status,'answered'); assert.equal(resolutions(db).get(id).layer,'guess');
  const later=transaction(db,'Synthetic Shop'); assert.equal(resolutions(db).get(later).layer,'uncategorized');
  assert.equal(db.prepare('SELECT count(*) AS n FROM category_merchant_rules').get().n,0);
  db.exec('INSERT INTO ingest_epoch (id,n) VALUES (1,1) ON CONFLICT(id) DO UPDATE SET n=n+1');
  reopenItem(db,item.id); queueCategoryChecks(db); assert.equal(resolutions(db).get(id).layer,'uncategorized');
  await guessCategories(db,provider(.99),{policy}); assert.equal(getItem(db,item.id).status,'pending');
  const {answerItem}=await import('../src/ingest/confirm.mjs'); answerItem(db,item.id,'Business');
  assert.equal(resolutions(db).get(id).layer,'correction');
  const another=transaction(db,'Another merchant'); await guessCategories(db,provider(.99),{policy});
  const q=db.prepare("SELECT id FROM confirm_items WHERE subject=? AND kind='transaction_category'").get(String(another));
  db.exec('INSERT INTO ingest_epoch (id,n) VALUES (1,1) ON CONFLICT(id) DO UPDATE SET n=n+1'); reviseItem(db,q.id,'Business');
  assert.equal(resolutions(db).get(another).category,'Business');
});

test('Confirm preserves deterministic kind guesses and sends only owner-match features',async t=>{
  const db=store(t); db.exec("UPDATE accounts SET name='Everyday checking' WHERE id='a'");
  setSetting(db,'unused',true);
  db.prepare("INSERT INTO facts (key,value,updated_at) VALUES ('household.names',?,'2032-01-01')").run(JSON.stringify({me:'Jordan Example',spouse:'Taylor Sample'}));
  db.exec("INSERT INTO account_holders (account_id,holder,created_at) VALUES ('a','Jordan Example','2032-01-01')");
  const kind=ask(db,{kind:'account_kind',subject:'a',question:'Kind?',options:KIND_OPTIONS});
  const owner=ask(db,{kind:'account_owner',subject:'a',question:'Owner?',options:[{id:'owner',label:'You'},{id:'spouse',label:'Spouse'}]});
  let sent;
  const jev={...provider(.88),choose:async qs=>{sent=qs;return qs.map(()=>({choice:'owner',confidence:.88,probabilities:{owner:.9,spouse:.1}}));}};
  await guessClosedOptions(db,jev);
  assert.equal(sent.length,1); assert.ok(!JSON.stringify(sent).includes('Jordan')); assert.ok(!JSON.stringify(sent).includes('3456'));
  assert.equal(bestGuess(db,getItem(db,kind.id),{account:{name:'Everyday checking'}}).source,'rule');
  assert.equal(bestGuess(db,getItem(db,owner.id),{type:'account',account:{holder:'Jordan Example'}}).confidence,.88);
});


test('scheduled Jev work uses the configured key independently of the general engine and records spend',async t=>{
  const db=store(t); vocabulary(db); const id=transaction(db);
  const dir=mkdtempSync(join(tmpdir(),'jev-job-')), keyFile=join(dir,'key');
  writeFileSync(keyFile,'synthetic-key',{mode:0o600});t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});
  globalThis.fetch=async(_,o)=>{
    const body=JSON.parse(o.body);
    return Response.json({model:'jev-1.14.0',usage:{input_tokens:120,output_tokens:12},answers:Object.fromEntries(Object.entries(body.questions).map(([id,q])=>{
      const names=Object.keys(q.criteria);return [id,{type:'choice',choice:'Groceries',confidence:.99,
        probabilities:Object.fromEntries(names.map(c=>[c,c==='Groceries'?.9:.1/(names.length-1)]))}];
    }))});
  };
  const {defaultHandlers}=await import('../src/jobs/scheduler.mjs');
  const result=await defaultHandlers({})['confirm-guess']({db,now:'2032-11-05T00:00:00Z',config:{engine:'live',typesafeKeyFile:keyFile},engine:{isOn:()=>false}});
  assert.ok(result.note.guessed>=1);assert.equal(resolutions(db).get(id).layer,'guess');
  const spend=db.prepare('SELECT purpose,model,cost_usd FROM spend_ledger').all();
  assert.ok(spend.length);assert.ok(spend.every(r=>r.purpose==='categorize'&&r.model==='jev-1.14.0'&&r.cost_usd>0));
});


function spendingHistory(db) {
  for(let m=1;m<=8;m++) for(const [amount,category] of [[-100,'Groceries'],[3000,'Income']])
    transaction(db,category+' historical '+String.fromCharCode(64+m),{date:`2032-${String(m).padStart(2,'0')}-15`,amount,category,parser:'aggregator'});
}

test('retired uncalibrated attempts and low-confidence results retain deterministic spending checks',async t=>{
  const db=store(t); vocabulary(db); spendingHistory(db);
  const ids=[transaction(db,'Older uncalibrated merchant',{amount:-250,date:'2032-06-10'}),transaction(db,'Earlier declined merchant',{amount:-260,date:'2032-06-10'})];
  for(const [i,id] of ids.entries()) db.prepare('INSERT INTO transaction_category_guesses VALUES (?,?,?,?)').run(id,i?'Business':null,'unmeasured','2032-10-01');
  queueCategoryChecks(db);
  for(const id of ids) assert.ok(pendingItems(db).find(q=>q.subject===String(id)));
  let asked=0;const jev=provider(.3),choose=jev.choose;jev.choose=async qs=>{asked+=qs.length;return choose(qs);};
  await guessCategories(db,jev,{policy});await guessCategories(db,jev,{policy});
  assert.equal(asked,2);
  for(const id of ids) {
    const q=pendingItems(db).find(q=>q.subject===String(id));assert.ok(q);assert.equal(q.context.jev,undefined);
    assert.equal(bestGuess(db,q,{}).source,'rule');assert.equal(resolutions(db).get(id).layer,'uncategorized');
    assert.equal(db.prepare('SELECT model FROM transaction_category_guesses WHERE transaction_id=?').get(id).model,'jev-1.14.0');
  }
});

test('Jev review cards and answered autos cannot crowd out source mappings or deterministic checks',async t=>{
  const db=store(t);vocabulary(db);spendingHistory(db);
  for(let i=0;i<12;i++)transaction(db,'Review merchant '+String.fromCharCode(65+i),{amount:-500-i});
  await guessCategories(db,provider(.9),{policy});
  const autos=[];for(let i=0;i<12;i++)autos.push(transaction(db,'Auto merchant '+String.fromCharCode(65+i),{amount:-900-i}));
  await guessCategories(db,provider(1),{policy});
  const deterministic=transaction(db,'Deterministic merchant',{amount:-150,date:'2032-06-10'});
  transaction(db,'New source row',{category:'Future source category',parser:'new-budget',amount:-5});
  const candidates=queueCategoryChecks(db,{policy});
  assert.ok(pendingItems(db).find(q=>q.kind==='category_mapping'));
  assert.ok(pendingItems(db).find(q=>q.kind==='transaction_category'&&q.subject===String(deterministic)));
  assert.equal(pendingItems(db).filter(q=>q.context.jev).length,12);
  assert.ok(candidates.every(c=>!autos.includes(c.transactionId)));
});

test('duplicate consolidation keeps a model correction from becoming owner memory and undo restores it',async t=>{
  const db=store(t);vocabulary(db);
  const keep=transaction(db,'Observed first'),drop=transaction(db,'Predicted duplicate');
  db.prepare("UPDATE transactions SET dedupe_key='jev-keep' WHERE id=?").run(keep);
  db.prepare("UPDATE transactions SET dedupe_key='jev-drop' WHERE id=?").run(drop);
  db.prepare("INSERT INTO transaction_category_corrections VALUES (?,'Groceries','household','2032-01-01')").run(keep);
  await guessCategories(db,provider(.99),{policy});
  const auto=db.prepare("SELECT id FROM confirm_items WHERE kind='transaction_category' AND subject=?").get(String(drop));
  assert.equal(resolutions(db).get(drop).layer,'guess');
  db.prepare('DELETE FROM transaction_category_corrections WHERE transaction_id=?').run(keep);
  const later=transaction(db,'Observed first');
  const duplicate=ask(db,{kind:'near_duplicate',subject:'jev-keep|jev-drop',question:'Same posting?',options:[{id:'same',label:'Same'},{id:'different',label:'Different'}],context:{keys:['jev-keep','jev-drop']}});
  const {answerItem}=await import('../src/ingest/confirm.mjs');answerItem(db,duplicate.id,'same');
  assert.equal(resolutions(db).get(keep).layer,'uncategorized');
  assert.equal(resolutions(db).get(later).layer,'uncategorized');
  reopenItem(db,duplicate.id);assert.equal(resolutions(db).get(drop).layer,'guess');
  reopenItem(db,auto.id);assert.equal(resolutions(db).get(drop).layer,'uncategorized');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});
