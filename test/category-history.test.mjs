import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInstance } from '../src/platform/db.mjs';
import { setSetting } from '../src/store/db.mjs';
import { loadCategoryInputs, queueCategoryChecks, categoryOptions } from '../src/categories/store.mjs';
import { resolveCategories, historyExamples, historyDecision } from '../src/categories/resolve.mjs';
import { guessCategories } from '../src/categories/guess.mjs';
import { categoryQuestions, createJev, JEV_MODEL } from '../src/categories/jev.mjs';
import { jevEvidence } from '../src/categories/policy.mjs';
import { answerItem, pendingItems, autoInfo, reopenItem } from '../src/ingest/confirm.mjs';
import { spendingInputs } from '../src/calc/targets.mjs';
import { plainEvidence } from '../src/categories/display.mjs';
import { mapSeries } from '../src/shared/series.mjs';

const accounts = [{id:'a',kind:'checking'}, {id:'b',kind:'business'}, {id:'c',kind:'card'}, {id:'d',kind:'savings'}];
const row = (id, patch={}) => ({id,account_id:'a',date:`2032-01-${String(id).padStart(2,'0')}`,description:'Cobalt Market',amount:-36,...patch});
const history = () => [1,2,3].map(id=>row(id,{category:'Groceries',parser:'aggregator'}));
async function store(t) {
  const dir=mkdtempSync(join(tmpdir(),'category-history-')), s=await createInstance(dir,{mode:'real'});
  t.after(async ()=>{await s.db.close();await s.platform.close();rmSync(dir,{recursive:true,force:true});});
  for(const a of accounts) await s.db.prepare('INSERT INTO accounts (id,kind,name) VALUES (?,?,?)').run(a.id,a.kind,'Synthetic account');
  await setSetting(s.db,'clock','2032-11-01');
  return s.db;
}
async function insert(db,t) {
  return Number((await db.prepare('INSERT INTO transactions (account_id,date,description,amount,category,parser) VALUES (?,?,?,?,?,?) RETURNING id')
    .get(t.account_id,t.date,t.description,t.amount,t.category??null,t.parser??'simplefin')).id);
}
const off={isOn:()=>false,stats:()=>({costUsd:0})};

test('history ranks labeled past rows and refuses future, opposite-sign and conflicting labels',()=>{
  const target=row(8), transactions=[...history(),target,row(9,{category:'Business',parser:'aggregator'}),row(4,{amount:36,category:'Income',parser:'aggregator'})];
  const input={accounts,transactions};
  assert.deepEqual(historyExamples(target,input).map(t=>t.id),[3,2,1]);
  const decision=historyDecision(target,input);
  assert.equal(decision.category,'Groceries');
  assert.match(decision.evidence.text,/last 3.*Cobalt Market.*Groceries/);
  transactions.push(row(5,{category:'Business',parser:'aggregator'}));
  assert.equal(historyDecision(target,input),null);
  assert.equal(resolveCategories(input).get(target.id).layer,'uncategorized');
});

test('Confirm answers and enriched imported categories train immediately without merchant rules',async t=>{
  const db=await store(t);
  const ids=await mapSeries(history(), async r=>await insert(db,r));
  const target=await insert(db,row(8));
  await queueCategoryChecks(db);
  await guessCategories(db,off);
  const item=await db.prepare("SELECT id FROM confirm_items WHERE subject=? AND kind='transaction_category'").get(String(target));
  assert.equal((await autoInfo(db,item.id)).evidence.refs.stage,'history');
  assert.equal(resolveCategories(await loadCategoryInputs(db)).get(target).category,'Groceries');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM category_merchant_rules').get()).n,0);
  await reopenItem(db,item.id);
  assert.equal(resolveCategories(await loadCategoryInputs(db)).get(target).layer,'uncategorized');
  await guessCategories(db,off);
  assert.equal((await pendingItems(db)).find(q=>q.id===item.id).status,'pending');
  await answerItem(db,item.id,'Business');
  const input=await loadCategoryInputs(db), next=row(10);
  assert.equal(historyExamples(next,input)[0].category,'Business');
  assert.equal(historyDecision(next,input),null);
  assert.equal(ids.length,3);
});

test('ambiguous neighbours reach the model as scrubbed labeled examples',async t=>{
  const db=await store(t);
  for(const r of [...history(),row(4,{category:'Business',parser:'aggregator'})]) await insert(db,r);
  await insert(db,row(8));
  let sent;
  await guessCategories(db,{isOn:()=>true,stats:()=>({costUsd:0}),choose:async qs=>{
    sent=qs;return qs.map(()=>({choice:'Groceries',confidence:.8,probabilities:{Groceries:.8,Business:.2}}));
  }});
  assert.equal(sent.length,1);
  assert.equal(sent[0].state.examples.length,4);
  assert.equal(sent[0].state.examples[0].category,'Business');
  const questions=categoryQuestions([row(8)],{accounts,categories:['Groceries','Business'],examples:[[row(1,{description:'Synthetic Private 7788',category:'Groceries'})]],householdNames:{me:'Synthetic Private'}});
  assert.ok(!JSON.stringify(questions).includes('7788'));
  assert.ok(!JSON.stringify(questions).includes('Synthetic Private'));
});

test('processor business deposits, card payments and own-account transfers are undoable offline',async t=>{
  const db=await store(t);
  const payout=await insert(db,row(1,{account_id:'b',amount:720,description:'Stripe payout'}));
  const personal=await insert(db,row(2,{amount:83,description:'Stripe payout'}));
  const fee=await insert(db,row(3,{account_id:'b',amount:-12,description:'Stripe fee'}));
  const card=await insert(db,row(4,{account_id:'c',amount:48,description:'Payment received'}));
  const out=await insert(db,row(5,{amount:-321,description:'Own account transfer'}));
  const incoming=await insert(db,row(6,{account_id:'d',amount:321,description:'Own account transfer'}));
  await guessCategories(db,off);
  const resolved=resolveCategories(await loadCategoryInputs(db));
  assert.equal(resolved.get(payout).bucket,'income');
  for(const id of [card,out,incoming]) assert.equal(resolved.get(id).bucket,'transfer');
  for(const id of [personal,fee]) assert.equal(resolved.get(id).layer,'uncategorized');
  for(const id of [payout,card,out,incoming]) {
    const item=await db.prepare("SELECT id FROM confirm_items WHERE kind='transaction_category' AND subject=?").get(String(id));
    assert.equal((await autoInfo(db,item.id)).evidence.refs.stage,'rules');
    await reopenItem(db,item.id);
    assert.equal(resolveCategories(await loadCategoryInputs(db)).get(id).layer,'uncategorized');
  }
});

test('generated evidence uses the product label without vendors or percentages',()=>{
  const texts=[jevEvidence(.99),historyDecision(row(8),{accounts,transactions:history()}).evidence.text,
    ...[...resolveCategories({accounts,transactions:[row(1,{account_id:'b',amount:99,description:'PayPal payout'}),row(2,{account_id:'c',amount:34,description:'Payment received'})]}).values()].map(v=>v.evidence.text)];
  for(const text of texts) assert.doesNotMatch(text,/jev|typesafe|anthropic|openai|claude|gpt|gemini|\d+\s*%/i);
  for(const text of texts) assert.equal(plainEvidence(text),text);
  assert.match(jevEvidence(.99),/Fathom's categorization/);
  const serviceHistory=history().map(t=>({...t,description:'OpenAI 20% invoice'}));
  assert.doesNotMatch(historyDecision(row(8,{description:'OpenAI 20% invoice'}),{accounts,transactions:serviceHistory}).evidence.text,/openai|%/i);
  const percentHistory=history().map(t=>({...t,description:'Synthetic percent supplies'}));
  const text=historyDecision(row(8,{description:'Synthetic percent supplies'}),{accounts,transactions:percentHistory}).evidence.text;
  assert.equal(plainEvidence(text),text);
});

test('one categorization run attempts all open transactions under its cost cap',async t=>{
  const db=await store(t),dir=mkdtempSync(join(tmpdir(),'history-budget-')),keyFile=join(dir,'key');
  writeFileSync(keyFile,'synthetic-key',{mode:0o600});t.after(()=>rmSync(dir,{recursive:true,force:true}));
  await insert(db,row(1,{description:'Historical food',category:'Groceries',parser:'aggregator'}));
  await insert(db,row(2,{description:'Historical service',category:'Business',parser:'aggregator'}));
  for(let i=0;i<35;i++) await insert(db,row(8,{description:'New merchant '+String.fromCharCode(65+i)}));
  let attempted=0;
  const jev=await createJev({keyFile,transport:async(_,opts)=>{
    const body=JSON.parse(opts.body);attempted+=Object.keys(body.questions).length;
    return Response.json({model:JEV_MODEL,usage:{input_tokens:1500,output_tokens:12},answers:Object.fromEntries(Object.keys(body.questions)
      .map(id=>[id,{type:'choice',choice:'Groceries',confidence:.88,probabilities:{Groceries:.88,Business:.12}}]))});
  }});
  const result=await guessCategories(db,jev);
  assert.equal(result.stopped,undefined);assert.equal(attempted,35);assert.equal(result.guessed,35);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM transaction_category_guesses').get()).n,35);
  assert.ok(result.costUsd<=.05);
});

test('enrichment categories and Confirm source mappings are immediately usable training labels',async t=>{
  const db=await store(t), ids=await mapSeries(history(), async r=>await insert(db,{...r,category:null}));
  for(const id of ids) await db.prepare('INSERT INTO transaction_category_imports VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id,'synthetic:'+id,'Synthetic supplies','synthetic-source',null,null,'2032-01-01','Cobalt Market','2032-01-01');
  await db.prepare('INSERT INTO category_source_rules VALUES (?,?,?,?)').run('synthetic-source','Synthetic supplies','business','2032-01-04');
  const input=await loadCategoryInputs(db),target=row(8);
  assert.equal(historyExamples(target,input).length,3);
  assert.equal(historyDecision(target,input).category,'Synthetic supplies');
  assert.equal(historyDecision(target,input).bucket,'business');
});

test('unmapped source categories leave one mapping card and never stop later local or model decisions',async t=>{
  const db=await store(t);
  const unknown=await insert(db,row(1,{account_id:'b',amount:115,description:'Stripe payout',category:'Synthetic receipts',parser:'aggregator'}));
  const card=await insert(db,row(2,{account_id:'c',amount:44,description:'Payment received',category:'Synthetic card activity',parser:'aggregator'}));
  const debit=await insert(db,row(3,{amount:-122,description:'Synthetic move',category:'Synthetic movement',parser:'aggregator'}));
  await insert(db,row(4,{account_id:'d',amount:122,description:'Synthetic move'}));
  const payout=await insert(db,row(5,{account_id:'b',amount:631,description:'Square payout'}));
  await insert(db,row(6,{description:'Historical food',category:'Groceries',parser:'aggregator'}));
  await insert(db,row(7,{description:'Historical work',category:'Business',parser:'aggregator'}));
  const unresolved=await insert(db,row(8,{description:'New merchant'}));
  let attempted=0;
  const provider={isOn:()=>true,stats:()=>({costUsd:0}),choose:async qs=>{attempted+=qs.length;return qs.map(()=>({choice:'Groceries',confidence:.85,probabilities:{Groceries:.85,Business:.15}}));}};
  for(let run=0;run<2;run++) {
    const result=await guessCategories(db,provider);
    assert.equal(result.stopped,undefined);
    assert.equal(resolveCategories(await loadCategoryInputs(db)).get(payout).category,'Income');
    for(const id of [unknown,card,debit]) assert.equal((await db.prepare("SELECT count(*) AS n FROM confirm_items WHERE kind='transaction_category' AND subject=?").get(String(id))).n,0);
    assert.equal((await pendingItems(db)).filter(q=>q.kind==='category_mapping').length,3);
  }
  assert.equal(attempted,1);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM transaction_category_guesses WHERE transaction_id=?').get(unresolved)).n,1);
});

test('business draws keep personal income while business-card payments stay transfers',async t=>{
  const db=await store(t);
  await insert(db,row(1,{account_id:'b',amount:-907,description:'Synthetic owner draw'}));
  const draw=await insert(db,row(2,{amount:907,description:'Synthetic owner draw'}));
  await db.prepare('INSERT INTO facts (key,value,updated_at) VALUES (?,?,?)').run('accounts.businessEntity',JSON.stringify({c:'Synthetic entity'}),'2032-01-01');
  const card=await insert(db,row(3,{account_id:'c',amount:51,description:'Payment received'}));
  await guessCategories(db,off);
  const resolved=resolveCategories(await loadCategoryInputs(db));
  assert.equal(resolved.get(draw).bucket,'income');
  assert.equal(resolved.get(draw).layer,'uncategorized');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM transaction_category_corrections WHERE transaction_id=?').get(draw)).n,0);
  assert.equal(resolved.get(card).bucket,'transfer');
});

test('undoing a learned business category restores spending through the calculator boundary',async t=>{
  const db=await store(t);
  for(const r of history()) await insert(db,{...r,category:'Business',parser:'aggregator'});
  for(let month=2;month<=11;month++) await insert(db,row(1,{date:`2032-${String(month).padStart(2,'0')}-15`,description:'Synthetic groceries',amount:-11,category:'Groceries',parser:'aggregator'}));
  const target=await insert(db,row(8,{date:'2032-10-20'}));
  await guessCategories(db,off);
  const spend=async ()=>spendingInputs({...await loadCategoryInputs(db),clock:'2032-11-30'});
  assert.ok(!(await spend()).spendIds.includes(target));
  const item=await db.prepare("SELECT id FROM confirm_items WHERE kind='transaction_category' AND subject=?").get(String(target));
  await reopenItem(db,item.id);
  assert.ok((await spend()).spendIds.includes(target));
});

test('stored category choices use the full household list in one order on every card',async t=>{
  const db=await store(t);
  await insert(db,row(1,{description:'Historical food',category:'Groceries',parser:'aggregator'}));
  await insert(db,row(2,{description:'Historical meal',category:'Dining & Drinks',parser:'aggregator'}));
  const first=await insert(db,row(8,{description:'New merchant alpha'})),second=await insert(db,row(9,{description:'New merchant beta'}));
  const provider={isOn:()=>true,stats:()=>({costUsd:0}),choose:async qs=>qs.map((q,i)=>({choice:i?'Dining & Drinks':'Groceries',confidence:.85,probabilities:{Groceries:.5,'Dining & Drinks':.5}}))};
  await guessCategories(db,provider);
  const items=(await pendingItems(db)).filter(q=>q.kind==='transaction_category' && [String(first),String(second)].includes(q.subject));
  assert.equal(items.length,2);assert.notEqual(items[0].context.guess,items[1].context.guess);
  assert.deepEqual(items[0].options,items[1].options);
  const ids=items[0].options.filter(o=>!o.id.startsWith('always:')).map(o=>o.id);
  assert.deepEqual(ids,['Shopping','Business','Income','Internal Transfers','Taxes','Investment','Ignore','Dining & Drinks','Groceries']);
  assert.deepEqual(categoryOptions(await loadCategoryInputs(db)),items[0].options);
  assert.equal(items[0].options.some(o=>o.guess),false);
});
