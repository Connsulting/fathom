import test from 'node:test';
import assert from 'node:assert/strict';
import { realStore, NOW } from './helpers/ingest.mjs';
import { callTool, tools } from '../src/tools/index.mjs';
import { createToolServer } from '../src/mcp/server.mjs';
import { ask, OWNER_OPTIONS, KIND_OPTIONS, getItem, answerItem, recordAutoAnswer } from '../src/ingest/confirm.mjs';
import { listPendingConfirm, getConfirm, answerConfirm, reopenConfirm } from '../src/api/ingest-handlers.mjs';
import { accountMergeCandidates } from '../src/api/accounts.mjs';
import { recAnswers } from '../src/api/fact-answers.mjs';
import { markItem } from '../src/api/yearend-handlers.mjs';
import { yearendChecklist } from '../src/yearend/expected.mjs';
import { setSetting } from '../src/store/db.mjs';
import { proposalTools, proposalBasis } from '../src/actions/proposals.mjs';

async function setup(t){const s=await realStore();t.after(()=>s.close());setSetting(s.db,'clock','2032-03-10');
 s.db.prepare("INSERT INTO accounts (id,name,kind,owner,inst) VALUES ('manual','Synthetic checking','cash',NULL,'Example Bank')").run();
 const ctx={db:s.db,household:s.household,config:s.config,now:NOW,actorId:'test-owner',channel:'mcp',ownerText:'family',replan:async()=>({status:'ok'}),scheduler:{soon(){},trigger(){},runNow:async()=>({status:'ok'})}};
 const q=kind=>ask(s.db,{kind,subject:'manual',question:'Choose',options:kind==='account_owner'?OWNER_OPTIONS:KIND_OPTIONS,context:{},now:NOW}).id;
 return {...s,ctx,q};}
const undo=(ctx,r)=>callTool('undo',{operation:'undo',id:r.receipt.id},ctx);

test('Confirm reads match pending, detail and merge-candidate routes with filtering',async t=>{
 const s=await setup(t),id=s.q('account_owner');
 assert.deepEqual(await callTool('household',{operation:'confirm_items'},s.ctx),listPendingConfirm(s.ctx));
 const detail=await callTool('household',{operation:'confirm_items',status:'all',ids:[id]},s.ctx);
 assert.deepEqual(detail.items,[getConfirm({...s.ctx,params:{id:String(id)}}).item]);
 answerConfirm({...s.ctx,params:{id:String(id)},body:{answer:'owner'}});
 assert.deepEqual((await callTool('household',{operation:'confirm_items',ids:[id]},s.ctx)).items,[getConfirm({...s.ctx,params:{id:String(id)}}).item]);
 assert.equal((await callTool('household',{operation:'confirm_items',kinds:['account_kind']},s.ctx)).items.length,0);
 assert.deepEqual(await callTool('accounts',{operation:'merge_candidates',id:'manual'},s.ctx),accountMergeCandidates({...s.ctx,params:{id:'manual'}}));
});

test('Confirm batch answer and reopen share routes, preserve atomicity and undo each direction',async t=>{
 const s=await setup(t),owner=s.q('account_owner'),kind=s.q('account_kind');
 await assert.rejects(callTool('answer',{operation:'confirm',items:[{id:owner,answer:'owner'},{id:kind,answer:'invalid'}]},s.ctx));
 assert.equal(getItem(s.db,owner).status,'pending');
 const r=await callTool('answer',{operation:'confirm',items:[{id:owner,answer:'owner'},{id:kind,answer:'taxable'}]},s.ctx);
 assert.deepEqual(r.items.map(i=>i.status),['answered','answered']);assert.equal(s.db.prepare("SELECT owner FROM accounts WHERE id='manual'").get().owner,'You');
 await undo(s.ctx,r);assert.equal(getItem(s.db,owner).status,'pending');assert.equal(s.db.prepare("SELECT owner FROM accounts WHERE id='manual'").get().owner,null);
 answerConfirm({...s.ctx,params:{id:String(owner)},body:{answer:'spouse'}});
 const opened=await callTool('answer',{operation:'reopen',ids:[owner]},s.ctx);assert.equal(opened.items[0].status,'pending');
 await undo(s.ctx,opened);assert.equal(getItem(s.db,owner).answer,'spouse');
 const revised=await callTool('answer',{operation:'confirm',items:[{id:owner,answer:'joint'}],revise:true},s.ctx);
 await undo(s.ctx,revised);assert.equal(getItem(s.db,owner).answer,'spouse');
 const reopened=await callTool('answer',{operation:'reopen',ids:[owner]},s.ctx);s.db.prepare("UPDATE accounts SET owner='Later' WHERE id='manual'").run();
 await assert.rejects(undo(s.ctx,reopened),/changed_since|changed since/);
});

test('reopen refuses changed rows with changed_since and leaves the answer intact',async t=>{
 const s=await setup(t),id=s.q('account_owner');
 answerConfirm({...s.ctx,params:{id:String(id)},body:{answer:'owner'}});
 s.db.prepare("UPDATE accounts SET owner='Joint' WHERE id='manual'").run();
 await assert.rejects(callTool('answer',{operation:'reopen',ids:[id]},s.ctx),e=>e.code==='changed_since'||e.reason==='changed_since');
 assert.equal(getItem(s.db,id).status,'answered');
});

test('rec_questions checks question keys and evidence, matches route values and writes undoable fact receipts',async t=>{
 const s=await setup(t),def={id:'synthetic',title:'Coverage',question:{keys:['benefits.hsaCoverage'],primary:true}};
 s.db.prepare("INSERT INTO recs (id,def,status,updated_at) VALUES ('synthetic',?,'waiting',?)").run(JSON.stringify(def),NOW);
 const args={operation:'rec_questions',recId:'synthetic',answers:[{key:'benefits.hsaCoverage',value:'family'}],evidence:'family'};
 await assert.rejects(callTool('answer',{...args,answers:[{key:'synthetic.unsupported',value:'family'}]},s.ctx),{name:'ToolError',code:'bad_input'});
 await assert.rejects(callTool('answer',{...args,answers:[{key:'business.cashBasis',value:true}]},s.ctx));
 await assert.rejects(callTool('answer',{...args,evidence:'individual'},s.ctx),{code:'bad_input'});
 const r=await callTool('answer',args,s.ctx);assert.equal(r.receipts.length,1);assert.equal(JSON.parse(s.db.prepare("SELECT value FROM facts WHERE key='benefits.hsaCoverage'").get().value),'family');
 assert.equal(r.receipts[0].scope,'write:facts');
 await callTool('undo',{operation:'undo',id:r.receipts[0].id},s.ctx);assert.equal(s.db.prepare("SELECT * FROM facts WHERE key='benefits.hsaCoverage'").get(),undefined);
 await recAnswers({...s.ctx,params:{id:'synthetic'},body:{answers:args.answers}});assert.equal(JSON.parse(s.db.prepare("SELECT value FROM facts WHERE key='benefits.hsaCoverage'").get().value),'family');
 s.db.prepare("UPDATE recs SET status='hidden' WHERE id='synthetic'").run();await assert.rejects(callTool('answer',args,s.ctx),{name:'ToolError',code:'not_found'});
});

test('yearend mark and clear match route validation and undo prior reasons',async t=>{
 const s=await setup(t);s.db.prepare("INSERT INTO transactions (account_id,date,amount,description) VALUES ('manual','2031-05-01',20,'Interest')").run();const year=2031,key=yearendChecklist(s.db,{year,clock:'2032-03-10'}).items[0].key;
 const args={operation:'yearend_mark',year,itemKey:key,reason:'Account closed'};
 const r=await callTool('answer',args,s.ctx);assert.deepEqual(r.item,{key,marked:true,reason:'Account closed'});
 const clear=await callTool('answer',{...args,reason:null},s.ctx);assert.equal(clear.item.marked,false);
 await undo(s.ctx,clear);assert.equal(s.db.prepare('SELECT reason FROM yearend_marks WHERE tax_year=? AND item_key=?').get(year,key).reason,'Account closed');
 await undo(s.ctx,r);assert.equal(s.db.prepare('SELECT * FROM yearend_marks WHERE tax_year=? AND item_key=?').get(year,key),undefined);
 markItem({...s.ctx,body:{year,key,reason:'Account closed'}});assert.equal(s.db.prepare('SELECT reason FROM yearend_marks WHERE tax_year=? AND item_key=?').get(year,key).reason,'Account closed');
 await assert.rejects(callTool('answer',{...args,itemKey:'missing'},s.ctx));
});

test('Confirm and fact operations enforce scopes and proposal bases without writes',async t=>{
 const s=await setup(t),id=s.q('account_owner'),server=createToolServer({scopes:['read'],authorize:()=>true,ctx:s.ctx});
 for(const operation of ['rec_questions','confirm','reopen','yearend_mark']){
  const r=await server._requestHandlers.get('tools/call')({method:'tools/call',params:{name:'answer',arguments:{operation}}},{});assert.match(r.content[0].text,/Permission denied/);
 }
 let pending;await proposalTools(tools).find(t=>t.name==='answer').handler({operation:'confirm',items:[{id,answer:'owner'}],propose:true},{...s.ctx,onProposal:v=>{pending=v;}});
 assert.equal(getItem(s.db,id).status,'pending');const basis=pending.basis;
 s.db.prepare("INSERT INTO transactions (account_id,date,amount,description) VALUES ('manual','2032-03-01',-10,'New posting')").run();
 assert.equal(proposalBasis(s.db,'answer',pending.scopes,pending.args),basis);
 s.db.prepare("UPDATE accounts SET owner='Joint' WHERE id='manual'").run();
 assert.notEqual(proposalBasis(s.db,'answer',pending.scopes,pending.args),basis);
});

test('undoing a batch reopen refuses a later edit to any account field it would restore',async t=>{
 const s=await setup(t),owner=s.q('account_owner'),kind=s.q('account_kind');
 await callTool('answer',{operation:'confirm',items:[{id:owner,answer:'owner'},{id:kind,answer:'taxable'}]},s.ctx);
 const reopened=await callTool('answer',{operation:'reopen',ids:[owner,kind]},s.ctx);
 s.db.prepare("UPDATE accounts SET owner='Later owner' WHERE id='manual'").run();
 await assert.rejects(undo(s.ctx,reopened),{code:'changed_since'});
 assert.equal(s.db.prepare("SELECT owner FROM accounts WHERE id='manual'").get().owner,'Later owner');
 assert.equal(getItem(s.db,owner).status,'pending');assert.equal(getItem(s.db,kind).status,'pending');
});

test('large Confirm batches keep the result bounded while applying and undoing every answer',async t=>{
 const s=await setup(t),items=[];
 for(let i=0;i<40;i++){
  const accountId=`bulk-${i}`;s.db.prepare("INSERT INTO accounts (id,name,kind) VALUES (?,?,'cash')").run(accountId,'Synthetic account');
  const q=ask(s.db,{kind:'account_owner',subject:accountId,question:'Synthetic imported context '.repeat(320),options:OWNER_OPTIONS,context:{},now:NOW});
  items.push({id:q.id,answer:'owner'});
 }
 const result=await callTool('answer',{operation:'confirm',items},s.ctx);
 assert.ok(Buffer.byteLength(JSON.stringify(result))<=256*1024);
 assert.equal(result.truncated,true);
 assert.equal(s.db.prepare("SELECT count(*) AS n FROM accounts WHERE id LIKE 'bulk-%' AND owner='You'").get().n,items.length);
 assert.equal(result.undo.args.id,result.receipt.id);
 await undo(s.ctx,result);
 assert.equal(s.db.prepare("SELECT count(*) AS n FROM accounts WHERE id LIKE 'bulk-%' AND owner IS NULL").get().n,items.length);
});

test('C8 eval scripts select the requested household subjects without unrelated substitutes',async t=>{
 const {createEvalStore}=await import('../evals/harness.mjs');const s=await createEvalStore();t.after(()=>s.close());
 const owner=await import('../evals/scripts/q59-change-account-owner.mjs');
 const ownerCalls=(await owner.script({db:s.db}))[0].toolCalls;
 const account=s.db.prepare('SELECT owner,kind FROM accounts WHERE id=?').get(ownerCalls[1].args.id);
 assert.equal(account.owner,'{n:spouse}');assert.equal(account.kind,'taxable');
 const merchant=await import('../evals/scripts/q60-merchant-rule-groceries.mjs');
 const merchantCalls=(await merchant.script({db:s.db}))[0].toolCalls;
 const search=await callTool('transactions',merchantCalls[0].args,{db:s.db});
 assert.ok(search.rows.length>0);assert.ok(search.rows.some(row=>row.merchant===merchantCalls[1].args.merchant));
 const yearend=await import('../evals/scripts/q61-mark-1099-not-needed.mjs');
 const yearendCalls=(await yearend.script({db:s.db,clock:'2026-11-05'}))[0].toolCalls;
 const health=await callTool('household',yearendCalls[0].args,{db:s.db,clock:'2026-11-05'});
 assert.match(health.yearend.items.find(item=>item.key===yearendCalls[1].args.itemKey).issuer,/credit union/i);
});

test('Confirm proposals retain the target item row',async t=>{
 const s=await setup(t),id=s.q('account_owner');let pending;
 await proposalTools(tools).find(t=>t.name==='answer').handler({operation:'confirm',items:[{id,answer:'owner'}],propose:true},{...s.ctx,onProposal:v=>{pending=v;}});
 s.db.prepare("UPDATE confirm_items SET question='Updated question' WHERE id=?").run(id);
 assert.notEqual(proposalBasis(s.db,pending.tool,pending.scopes,pending.args),pending.basis);
});


for (const kind of ['entity_alias', 'tax_year', 'fact_check', 'near_duplicate', 'employer_relation',
  'employer_recipient', 'document_recipient', 'withholding_conflict', 'account_match',
  'transaction_category', 'category_mapping', 'resolver_fact']) {
 test(`${kind} proposals ignore unrelated transactions and retain affected rows`, async t => {
  const s = await setup(t), db = s.db;
  const transaction = key => Number(db.prepare("INSERT INTO transactions(account_id,date,amount,description,dedupe_key) VALUES ('manual','2032-03-01',-20,'Synthetic posting',?)").run(key).lastInsertRowid);
  const payment = (payer, slot, key) => Number(db.prepare("INSERT INTO tax_payments(jurisdiction,tax_year,date,amount,payer,source_slot,dedupe_key,recipient) VALUES ('federal',2031,'2032-01-10',20,?,?,?,'unknown')").run(payer,slot,key).lastInsertRowid);
  let subject = 'synthetic', context = {}, answer = 'yes', change;
  if (kind === 'entity_alias') {
   subject = 'exampleco'; answer = 'entity:Canonical Co';
   const id = Number(db.prepare("INSERT INTO pnl_lines(entity,period,category,amount) VALUES ('Example Co','2031-01','Revenue',10)").run().lastInsertRowid);
   change = () => db.prepare('UPDATE pnl_lines SET amount=11 WHERE id=?').run(id);
  } else if (kind === 'tax_year') {
   subject = 'tax:2031'; answer = 'payment_year';
   const id = payment('tax', 'tax:2031:federal', 'tax-row');
   change = () => db.prepare('UPDATE tax_payments SET amount=21 WHERE id=?').run(id);
  } else if (kind === 'fact_check' || kind === 'resolver_fact') {
   context = { key:'benefits.hsaCoverage', value:'family', values:{family:'family'} };
   answer = kind === 'fact_check' ? 'yes' : 'family';
   change = () => db.prepare("INSERT INTO facts(key,value,confirmed,updated_at) VALUES ('benefits.hsaCoverage','\"individual\"',1,?)").run(NOW);
  } else if (kind === 'near_duplicate') {
   transaction('near-first'); const id = transaction('near-second');
   subject = 'near-first|near-second'; context = { keys:subject.split('|') }; answer = 'same';
   change = () => db.prepare('UPDATE transactions SET amount=-21 WHERE id=?').run(id);
  } else if (kind === 'employer_relation') {
   subject = 'exampleco'; answer = 'outside';
   const id = Number(db.prepare("INSERT INTO held_facts(hold,key,value,confidence,created_at) VALUES ('employer:exampleco','income.w2','true',1,?)").run(NOW).lastInsertRowid);
   change = () => db.prepare("UPDATE held_facts SET value='false' WHERE id=?").run(id);
  } else if (['employer_recipient','document_recipient','withholding_conflict'].includes(kind)) {
   const id = payment('w2:exampleco:doc:1','wh:exampleco:2031:federal:unknown','withholding-first');
   answer = 'owner'; subject = kind === 'employer_recipient' ? 'exampleco' : 'w2:exampleco:doc:1';
   if (kind === 'withholding_conflict') {
    const second = payment('w2:exampleco:doc:2','wh:exampleco:2031:federal:unknown','withholding-second');
    context = { first:{id,key:'withholding-first',fileId:null,cents:2000}, second:{id:second,key:'withholding-second',fileId:null,cents:2000} };
    answer = 'first';
   }
   change = () => db.prepare('UPDATE tax_payments SET amount=21 WHERE id=?').run(id);
  } else if (kind === 'account_match') {
   db.prepare("INSERT INTO simplefin_accounts(sf_key,account_id,status,name,created_at) VALUES ('synthetic','manual','pending','Synthetic',?)").run(NOW);
   context = { sfKey:'synthetic', candidateId:'manual', ownId:'manual' }; answer = 'same';
   change = () => db.prepare("UPDATE simplefin_accounts SET status='mapped' WHERE sf_key='synthetic'").run();
  } else if (kind === 'transaction_category') {
   const id = transaction('category-target'); context = { transactionId:id }; answer = 'Groceries';
   change = () => db.prepare('UPDATE transactions SET amount=-21 WHERE id=?').run(id);
  } else {
   context = { parser:'synthetic', category:'Synthetic category' }; answer = 'household';
   db.prepare("INSERT INTO category_source_rules(parser,category,bucket,updated_at) VALUES ('synthetic','Synthetic category','income',?)").run(NOW);
   change = () => db.prepare("UPDATE category_source_rules SET bucket='excluded' WHERE parser='synthetic'").run();
  }
  const id = ask(db, {kind,subject,context,options:[{id:answer,label:answer}],question:'Synthetic question',now:NOW}).id;
  if (['transaction_category','category_mapping'].includes(kind)) db.prepare('INSERT INTO confirm_auto_declined(item_id,at) VALUES (?,?)').run(id,NOW);
  let pending;
  await proposalTools(tools).find(t => t.name === 'answer').handler({operation:'confirm',items:[{id,answer}],propose:true},{...s.ctx,onProposal:p => {pending=p;}});
  const basis = () => proposalBasis(db,pending.tool,pending.scopes,pending.args);
  transaction('unrelated');
  assert.equal(basis(),pending.basis);
  change();
  assert.notEqual(basis(),pending.basis);
 });
}


test('reopen and revise proposals retain dependent answers and their Undo rows', async t => {
 const s=await setup(t), root=s.q('account_owner');
 answerItem(s.db,root,'owner',{now:NOW});
 const transaction=Number(s.db.prepare("INSERT INTO transactions(account_id,date,amount,description) VALUES ('manual','2032-03-01',-20,'Synthetic market')").run().lastInsertRowid);
 const dependent=ask(s.db,{kind:'transaction_category',subject:String(transaction),question:'Synthetic category',options:[{id:'Groceries',label:'Groceries'}],context:{transactionId:transaction},now:NOW}).id;
 recordAutoAnswer(s.db,dependent,'Groceries',{rule:'synthetic',evidence:{text:'Synthetic evidence',basis:[root],ancestors:[root]},now:NOW});
 for(const args of [{ids:[root]},{items:[{id:root,answer:'joint'}],revise:true}]){
  const basis=()=>proposalBasis(s.db,'answer',['write:confirm'],args),before=basis();
  s.db.prepare("INSERT INTO transactions(account_id,date,amount,description) VALUES ('manual','2032-03-02',-7,'Unrelated posting')").run();
  assert.equal(basis(),before);
  s.db.exec('SAVEPOINT dependent_change');
  s.db.prepare("UPDATE transaction_category_corrections SET category='Medical' WHERE transaction_id=?").run(transaction);
  assert.notEqual(basis(),before);
  s.db.exec('ROLLBACK TO dependent_change');s.db.exec('RELEASE dependent_change');
 }
});


for (const [kind,answer] of [['employer_recipient','both'],['withholding_conflict','both'],['document_recipient','owner']]) {
 test(`${kind} ${answer} basis follows whether the answer closes stale conflicts`,async t=>{
  const s=await setup(t),db=s.db;
  const payment=key=>Number(db.prepare("INSERT INTO tax_payments(jurisdiction,tax_year,date,amount,payer,source_slot,dedupe_key,recipient) VALUES ('federal',2031,'2032-01-10',20,?,'wh:example:2031:federal:unknown',?,'unknown')").run(key,key).lastInsertRowid);
  const first=payment('first'),second=payment('second'),foreign=payment('foreign'),foreignSecond=payment('foreign-second');
  const ref=id=>({id,key:db.prepare('SELECT dedupe_key FROM tax_payments WHERE id=?').get(id).dedupe_key,fileId:null,cents:2000});
  const unrelated=ask(db,{kind:'withholding_conflict',subject:'unrelated',question:'Synthetic conflict',options:[{id:'both',label:'Both'}],context:{first:{...ref(foreign),cents:1900},second:ref(foreignSecond)},now:NOW}).id;
  const subject=kind==='document_recipient'?'first':kind==='employer_recipient'?'no-payments':'selected-conflict';
  const context=kind==='withholding_conflict'?{first:ref(first),second:ref(second)}:{};
  const id=ask(db,{kind,subject,context,question:'Synthetic recipient',options:[{id:answer,label:answer}],now:NOW}).id;
  const args={items:[{id,answer}]},basis=()=>proposalBasis(db,'answer',['write:confirm'],args),before=basis();
  db.prepare("UPDATE confirm_items SET question='Edited unrelated conflict' WHERE id=?").run(unrelated);
  if(answer==='both') assert.equal(basis(),before);
  else assert.notEqual(basis(),before);
  await callTool('answer',{operation:'confirm',...args},s.ctx);
  assert.equal(getItem(db,unrelated).status,answer==='both'?'pending':'answered');
 });
}
