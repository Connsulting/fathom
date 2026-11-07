import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
    .run('a',patch.date??'2032-10-03',-20,description,patch.category??null,patch.parser??'simplefin').lastInsertRowid);
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
