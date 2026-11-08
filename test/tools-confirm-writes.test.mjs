import test from 'node:test';
import assert from 'node:assert/strict';
import { realStore, NOW } from './helpers/ingest.mjs';
import { callTool, tools } from '../src/tools/index.mjs';
import { createToolServer } from '../src/mcp/server.mjs';
import { ask, OWNER_OPTIONS, KIND_OPTIONS, getItem } from '../src/ingest/confirm.mjs';
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
 const s=await setup(t),id=s.q('account_owner'),server=createToolServer({scopes:['read'],ctx:s.ctx});
 for(const operation of ['rec_questions','confirm','reopen','yearend_mark']){
  const r=await server._requestHandlers.get('tools/call')({method:'tools/call',params:{name:'answer',arguments:{operation}}},{});assert.match(r.content[0].text,/Permission denied/);
 }
 let pending;await proposalTools(tools).find(t=>t.name==='answer').handler({operation:'confirm',items:[{id,answer:'owner'}],propose:true},{...s.ctx,onProposal:v=>{pending=v;}});
 assert.equal(getItem(s.db,id).status,'pending');const basis=pending.basis;
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
