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
async function store(t) {
  const dir=mkdtempSync(join(tmpdir(),'jev-category-')); const s=await createInstance(dir,{mode:'real'});
  t.after(async ()=>{await s.db.close();await s.platform.close();rmSync(dir,{recursive:true,force:true});});
  await s.db.applySchema("INSERT INTO accounts (id,kind,name,mask) VALUES ('a','checking','Everyday','3456')");
  await setSetting(s.db,'clock','2032-11-05');
  return s.db;
}
async function transaction(db,description='Synthetic Shop',patch={}) {
  return Number((await db.prepare('INSERT INTO transactions (account_id,date,amount,description,category,parser) VALUES (?,?,?,?,?,?)')
    .run(patch.account_id??'a',patch.date??'2032-10-03',patch.amount??-20,description,patch.category??null,patch.parser??'simplefin')).lastInsertRowid);
}
const provider=(confidence)=>({isOn:()=>true,stats:()=>({costUsd:0}),choose:async qs=>qs.map(()=>({choice:'Groceries',confidence,probabilities:{Groceries:.9,Business:.1}}))});
const resolutions=async db=>resolveCategories(await loadCategoryInputs(db));
async function vocabulary(db) { await transaction(db,'Different historical merchant',{category:'Groceries',parser:'aggregator'}); await transaction(db,'Historical service',{category:'Business',parser:'aggregator'}); }

test('one threshold table classifies exact boundaries and disables unsupported bands',()=>{
  assert.ok(Object.hasOwn(CONFIDENCE_POLICY,'autoApply')); assert.equal(confidenceBand(.95,policy),'auto');
  assert.equal(confidenceBand(.7,policy),'review'); assert.equal(confidenceBand(.69,policy),'uncategorized');
  assert.equal(confidenceBand(1,{autoApply:null,review:null}),'uncategorized');
});

test('review stays Uncategorized, crosses the spending window and amount filters, and survives queue sweep',async t=>{
  const db=await store(t); await vocabulary(db); const id=await transaction(db,'Small old merchant',{date:'2031-01-01'});
  await guessCategories(db,provider(.8),{policy});
  assert.equal((await resolutions(db)).get(id).layer,'uncategorized');
  const item=(await pendingItems(db)).find(i=>i.subject===String(id)); assert.ok(item);
  const g=await bestGuess(db,item,{}); assert.equal(g.option,'Groceries'); assert.equal(g.evidence,"Fathom's categorization");
  for(let i=0;i<15;i++)await transaction(db,'More merchant '+i);
  await queueCategoryChecks(db,{policy}); assert.ok(await getItem(db,item.id)); assert.equal((await bestGuess(db,await getItem(db,item.id),{})).confidence,.8);
});

test('below-review attempts are persisted and never re-sent or applied',async t=>{
  const db=await store(t); await vocabulary(db); const id=await transaction(db); let calls=0; const jev=provider(.3);
  const choose=jev.choose; jev.choose=async q=>{calls++;return choose(q);};
  await guessCategories(db,jev,{policy}); await guessCategories(db,jev,{policy});
  assert.equal(calls,1); assert.equal((await resolutions(db)).get(id).category,'Uncategorized');
  assert.ok(!(await pendingItems(db)).some(i=>i.subject===String(id)));
});

test('auto application is provenance-marked, does not teach memory, and undo/revise survive an import',async t=>{
  const db=await store(t); await vocabulary(db); const id=await transaction(db);
  await guessCategories(db,provider(.99),{policy});
  const item=await db.prepare("SELECT id FROM confirm_items WHERE kind='transaction_category' AND subject=?").get(String(id));
  assert.equal((await getItem(db,item.id)).status,'answered'); assert.equal((await resolutions(db)).get(id).layer,'guess');
  const later=await transaction(db,'Synthetic Shop'); assert.equal((await resolutions(db)).get(later).layer,'uncategorized');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM category_merchant_rules').get()).n,0);
  await db.applySchema('INSERT INTO ingest_epoch (id,n) VALUES (1,1) ON CONFLICT(id) DO UPDATE SET n=n+1');
  await reopenItem(db,item.id); await queueCategoryChecks(db); assert.equal((await resolutions(db)).get(id).layer,'uncategorized');
  await guessCategories(db,provider(.99),{policy}); assert.equal((await getItem(db,item.id)).status,'pending');
  const {answerItem}=await import('../src/ingest/confirm.mjs'); await answerItem(db,item.id,'Business');
  assert.equal((await resolutions(db)).get(id).layer,'correction');
  const another=await transaction(db,'Another merchant'); await guessCategories(db,provider(.99),{policy});
  const q=await db.prepare("SELECT id FROM confirm_items WHERE subject=? AND kind='transaction_category'").get(String(another));
  await db.applySchema('INSERT INTO ingest_epoch (id,n) VALUES (1,1) ON CONFLICT(id) DO UPDATE SET n=n+1'); await reviseItem(db,q.id,'Business');
  assert.equal((await resolutions(db)).get(another).category,'Business');
});

test('Confirm preserves deterministic kind guesses and sends only owner-match features',async t=>{
  const db=await store(t); await db.applySchema("UPDATE accounts SET name='Everyday checking' WHERE id='a'");
  await setSetting(db,'unused',true);
  await db.prepare("INSERT INTO facts (key,value,updated_at) VALUES ('household.names',?,'2032-01-01')").run(JSON.stringify({me:'Jordan Example',spouse:'Taylor Sample'}));
  await db.applySchema("INSERT INTO account_holders (account_id,holder,created_at) VALUES ('a','Jordan Example','2032-01-01')");
  const kind=await ask(db,{kind:'account_kind',subject:'a',question:'Kind?',options:KIND_OPTIONS});
  const owner=await ask(db,{kind:'account_owner',subject:'a',question:'Owner?',options:[{id:'owner',label:'You'},{id:'spouse',label:'Spouse'}]});
  let sent;
  const jev={...provider(.88),choose:async qs=>{sent=qs;return qs.map(()=>({choice:'owner',confidence:.88,probabilities:{owner:.9,spouse:.1}}));}};
  await guessClosedOptions(db,jev);
  assert.equal(sent.length,1); assert.ok(!JSON.stringify(sent).includes('Jordan')); assert.ok(!JSON.stringify(sent).includes('3456'));
  assert.equal((await bestGuess(db,await getItem(db,kind.id),{account:{name:'Everyday checking'}})).source,'rule');
  assert.equal((await bestGuess(db,await getItem(db,owner.id),{type:'account',account:{holder:'Jordan Example'}})).confidence,.88);
});


test('scheduled Jev work uses the configured key independently of the general engine and records spend',async t=>{
  const db=await store(t); await vocabulary(db); const id=await transaction(db);
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
  const {defaultHandlers,createScheduler}=await import('../src/jobs/scheduler.mjs');
  // The household's outbound engine pause and missing instance funding each stop Jev before any
  // request; with both admitted Jev runs.
  const household=(engine,funded=true)=>({outbound:{enabled:kind=>kind==='engine'?engine:true},funded:()=>funded});
  const calls=[];const answer=globalThis.fetch;globalThis.fetch=async(...a)=>{calls.push(a);return answer(...a);};
  const job=async ctx=>{
    const handlers=defaultHandlers({});
    const scheduler=createScheduler({db,config:{engine:'live',typesafeKeyFile:keyFile,clock:'2032-11-05'},
      engine:{isOn:()=>true,call(){assert.fail('no unresolved household model question');}},
      handlers:{'confirm-guess':handlers['confirm-guess']},household:()=>ctx.household,
      now:()=>new Date('2032-11-05T00:00:00Z'),log:{log(){}}});
    try{return await scheduler.runNow('confirm-guess');}finally{await scheduler.stop();}
  };
  await job({household:household(false)});
  assert.equal(calls.length,0,'a paused household sends Jev nothing');
  await job({household:household(true,false)});
  assert.equal(calls.length,0,'an unfunded instance sends Jev nothing');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM spend_ledger').get()).n,0);
  const result=await job({household:household(true)});
  assert.ok(calls.length>0);
  assert.ok(result.note.guessed>=1);assert.equal((await resolutions(db)).get(id).layer,'guess');
  const spend=await db.prepare('SELECT purpose,model,cost_usd FROM spend_ledger').all();
  assert.ok(spend.length);assert.ok(spend.every(r=>r.purpose==='categorize'&&r.model==='jev-1.14.0'&&r.cost_usd>0));
});


async function spendingHistory(db) {
  for(let m=1;m<=8;m++) for(const [amount,category] of [[-100,'Groceries'],[3000,'Income']])
    await transaction(db,category+' historical '+String.fromCharCode(64+m),{date:`2032-${String(m).padStart(2,'0')}-15`,amount,category,parser:'aggregator'});
}

test('retired uncalibrated attempts and low-confidence results retain deterministic spending checks',async t=>{
  const db=await store(t); await vocabulary(db); await spendingHistory(db);
  const ids=[await transaction(db,'Older uncalibrated merchant',{amount:-250,date:'2032-06-10'}),await transaction(db,'Earlier declined merchant',{amount:-260,date:'2032-06-10'})];
  for(const [i,id] of ids.entries()) await db.prepare('INSERT INTO transaction_category_guesses VALUES (?,?,?,?)').run(id,i?'Business':null,'unmeasured','2032-10-01');
  await queueCategoryChecks(db);
  for(const id of ids) assert.ok((await pendingItems(db)).find(q=>q.subject===String(id)));
  let asked=0;const jev=provider(.3),choose=jev.choose;jev.choose=async qs=>{asked+=qs.length;return choose(qs);};
  await guessCategories(db,jev,{policy});await guessCategories(db,jev,{policy});
  assert.equal(asked,2);
  for(const id of ids) {
    const q=(await pendingItems(db)).find(q=>q.subject===String(id));assert.ok(q);assert.equal(q.context.jev,undefined);
    assert.equal((await bestGuess(db,q,{})).source,'rule');assert.equal((await resolutions(db)).get(id).layer,'uncategorized');
    assert.equal((await db.prepare('SELECT model FROM transaction_category_guesses WHERE transaction_id=?').get(id)).model,'jev-1.14.0');
  }
});

test('Jev review cards and answered autos cannot crowd out source mappings or deterministic checks',async t=>{
  const db=await store(t);await vocabulary(db);await spendingHistory(db);
  for(let i=0;i<12;i++)await transaction(db,'Review merchant '+String.fromCharCode(65+i),{amount:-500-i});
  await guessCategories(db,provider(.9),{policy});
  const autos=[];for(let i=0;i<12;i++)autos.push(await transaction(db,'Auto merchant '+String.fromCharCode(65+i),{amount:-900-i}));
  await guessCategories(db,provider(1),{policy});
  const deterministic=await transaction(db,'Deterministic merchant',{amount:-150,date:'2032-06-10'});
  await transaction(db,'New source row',{category:'Future source category',parser:'new-budget',amount:-5});
  const candidates=await queueCategoryChecks(db,{policy});
  assert.ok((await pendingItems(db)).find(q=>q.kind==='category_mapping'));
  assert.ok((await pendingItems(db)).find(q=>q.kind==='transaction_category'&&q.subject===String(deterministic)));
  assert.equal((await pendingItems(db)).filter(q=>q.context.jev).length,12);
  assert.ok(candidates.every(c=>!autos.includes(c.transactionId)));
});

test('duplicate consolidation keeps a model correction from becoming owner memory and undo restores it',async t=>{
  const db=await store(t);await vocabulary(db);
  const keep=await transaction(db,'Observed first'),drop=await transaction(db,'Predicted duplicate');
  await db.prepare("UPDATE transactions SET dedupe_key='jev-keep' WHERE id=?").run(keep);
  await db.prepare("UPDATE transactions SET dedupe_key='jev-drop' WHERE id=?").run(drop);
  await db.prepare("INSERT INTO transaction_category_corrections VALUES (?,'Groceries','household','2032-01-01')").run(keep);
  await guessCategories(db,provider(.99),{policy});
  const auto=await db.prepare("SELECT id FROM confirm_items WHERE kind='transaction_category' AND subject=?").get(String(drop));
  assert.equal((await resolutions(db)).get(drop).layer,'guess');
  await db.prepare('DELETE FROM transaction_category_corrections WHERE transaction_id=?').run(keep);
  const later=await transaction(db,'Observed first');
  const duplicate=await ask(db,{kind:'near_duplicate',subject:'jev-keep|jev-drop',question:'Same posting?',options:[{id:'same',label:'Same'},{id:'different',label:'Different'}],context:{keys:['jev-keep','jev-drop']}});
  const {answerItem}=await import('../src/ingest/confirm.mjs');await answerItem(db,duplicate.id,'same');
  assert.equal((await resolutions(db)).get(keep).layer,'uncategorized');
  assert.equal((await resolutions(db)).get(later).layer,'uncategorized');
  await reopenItem(db,duplicate.id);assert.equal((await resolutions(db)).get(drop).layer,'guess');
  await reopenItem(db,auto.id);assert.equal((await resolutions(db)).get(drop).layer,'uncategorized');
  assert.deepEqual((await db.foreignKeyCheck()),[]);
});


test('export enrichment retires its Jev review card and preserves another unresolved review',async t=>{
  // Ingest runs in a household context (MT-03), so this store comes from the ingest helper.
  const {ingestFile,accountIdOf}=await import('../src/ingest/pipeline.mjs');
  const {aggregatorFile,realStore}=await import('./helpers/ingest.mjs');
  const s=await realStore();t.after(async ()=>await s.close());
  const db=s.db;await setSetting(db,'clock','2032-11-05');
  await db.applySchema("INSERT INTO accounts (id,kind,name,mask) VALUES ('a','checking','Everyday','3456')");await vocabulary(db);
  const {answerItem}=await import('../src/ingest/confirm.mjs');
  const accountId=accountIdOf('examplebank|mask:1111');
  await db.prepare("INSERT INTO accounts (id,kind,inst,mask,name,identity) VALUES (?,'checking','Example Bank','1111','Synthetic checking','examplebank|mask:1111')").run(accountId);
  const target=await transaction(db,'POS DEBIT Enrollment merchant',{account_id:accountId,date:'2032-06-10',amount:-240});
  await db.prepare("UPDATE transactions SET external_id='live-synthetic',dedupe_key='live:synthetic' WHERE id=?").run(target);
  const other=await transaction(db,'Different unresolved review');
  await guessCategories(db,provider(.9),{policy});
  const card=(await pendingItems(db)).find(q=>q.kind==='transaction_category'&&q.subject===String(target));assert.ok(card);
  await ingestFile(db,aggregatorFile('synthetic-export.csv',[{date:'2032-06-10',amount:240,description:'Enrollment merchant',category:'Business'}]),
    s.opts(null,{now:'2032-08-01T12:00:00Z'}));
  await queueCategoryChecks(db,{policy});
  assert.equal((await db.prepare('SELECT count(*) AS n FROM transactions WHERE account_id=?').get(accountId)).n,1);
  assert.equal((await resolutions(db)).get(target).layer,'import');assert.equal((await resolutions(db)).get(target).category,'Business');
  assert.equal(await getItem(db,card.id),null);
  assert.throws(async ()=>await answerItem(db,card.id,'Groceries'));
  assert.equal((await db.prepare('SELECT count(*) AS n FROM transaction_category_corrections WHERE transaction_id=?').get(target)).n,0);
  assert.ok((await pendingItems(db)).find(q=>q.kind==='transaction_category'&&q.subject===String(other))?.context.jev);
});

test('near-duplicate consolidation retires the dropped Jev review and undo can recreate it',async t=>{
  const db=await store(t);await vocabulary(db);
  const {answerItem}=await import('../src/ingest/confirm.mjs');
  const keep=await transaction(db,'First review merchant'),drop=await transaction(db,'Dropped review merchant');
  await db.prepare("UPDATE transactions SET dedupe_key='review-keep' WHERE id=?").run(keep);
  await db.prepare("UPDATE transactions SET dedupe_key='review-drop' WHERE id=?").run(drop);
  await guessCategories(db,provider(.9),{policy});
  const droppedCard=(await pendingItems(db)).find(q=>q.kind==='transaction_category'&&q.subject===String(drop));assert.ok(droppedCard);
  const duplicate=await ask(db,{kind:'near_duplicate',subject:'review-keep|review-drop',question:'Same posting?',options:[{id:'same',label:'Same'},{id:'different',label:'Different'}],context:{keys:['review-keep','review-drop']}});
  await answerItem(db,duplicate.id,'same');await queueCategoryChecks(db,{policy});
  assert.equal(await getItem(db,droppedCard.id),null);
  const current=(await pendingItems(db)).filter(q=>q.kind==='transaction_category');
  assert.equal(current.length,1);assert.equal(current[0].subject,String(keep));assert.equal((await bestGuess(db,current[0],{})).confidence,.9);
  await reopenItem(db,duplicate.id);await queueCategoryChecks(db,{policy});
  assert.equal((await pendingItems(db)).filter(q=>q.kind==='transaction_category').length,2);
  assert.deepEqual((await db.foreignKeyCheck()),[]);
});
