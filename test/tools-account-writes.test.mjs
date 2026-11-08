import test from 'node:test';
import assert from 'node:assert/strict';
import { realStore, NOW } from './helpers/ingest.mjs';
import { seedDuplicate } from './helpers/account-merge.mjs';
import { callTool, tools } from '../src/tools/index.mjs';
import { createToolServer } from '../src/mcp/server.mjs';
import { proposalTools, proposalBasis } from '../src/actions/proposals.mjs';
import * as api from '../src/api/accounts.mjs';
import { rehearse } from '../src/storage/index.mjs';

const context = s => ({ db: s.db, household: s.household, config: s.config, now: NOW, actorId: 'test-owner', channel: 'mcp', ownerText: 'yes, merge these accounts', replan: async () => ({ status: 'ok' }) });
const account = async (s,id='manual') => await s.db.prepare("INSERT INTO accounts (id,name,inst,kind,owner,mirror) VALUES (?, 'Savings', 'Example Bank', 'cash', 'Your spouse', 'manual')").run(id);
const row = async (s,id='manual') => ({ ...await s.db.prepare('SELECT * FROM accounts WHERE id=?').get(id) });
const undo = (ctx,r) => callTool('undo',{ operation:'undo', id:r.receipt.id },ctx);

for (const [operation,params,field,value] of [
  ['rename',{ displayName:'Rainy day' },'display_name','Rainy day'],
  ['mask',{ mask:'1234' },'mask','1234'],
  ['owner',{ owner:'owner' },'owner','You'],
  ['kind',{ kind:'taxable' },'kind','taxable'],
]) test(`account ${operation} matches the route and undoes`,async t => {
  const s=await realStore();t.after(async ()=>await s.close());await account(s);await account(s,'route');
  const ctx=context(s), before=await row(s);
  const result=await callTool('update_account',{operation,id:'manual',...params},ctx);
  const handler={rename:api.accountRename,mask:api.accountMask,owner:api.accountOwner,kind:api.accountKind}[operation];
  await handler({...ctx,params:{id:'route'},body:params});
  assert.equal((await row(s))[field],value);assert.equal((await row(s,'route'))[field],value);
  assert.equal(result.account.id,'manual');assert.equal(result.receipt.scope,'write:accounts');assert.equal(result.undo.available,true);
  await undo(ctx,result);assert.equal((await row(s))[field],before[field]);
});

test('account receipts refuse later edits and another actor',async t=>{
  const s=await realStore();t.after(async ()=>await s.close());await account(s);const ctx=context(s);
  const r=await callTool('update_account',{operation:'rename',id:'manual',displayName:'Reserve'},ctx);
  await assert.rejects(undo({...ctx,actorId:'someone-else'},r),{code:'forbidden'});
  await s.db.prepare("UPDATE accounts SET display_name='Later' WHERE id='manual'").run();
  await assert.rejects(undo(ctx,r),/changed since/);
  const own=await callTool('update_account',{operation:'owner',id:'manual',owner:'owner'},ctx);
  await api.accountOwner({...ctx,params:{id:'manual'},body:{owner:'joint'}});
  await assert.rejects(undo(ctx,own),/changed since/);
});

test('merge requires confirmation and later owner evidence, then restores moved rows',async t=>{
  const s=await realStore();t.after(async ()=>await s.close());const ids=await seedDuplicate(s,{sure:true});const ctx=context(s);
  const moved=Number((await s.db.prepare("INSERT INTO transactions (account_id,date,amount,description) VALUES (?,'2032-03-02',-57,'Unique moved row') RETURNING id").get(ids.own)).id);
  const args={operation:'merge',id:ids.keep,withId:ids.own,evidence:'yes, merge these accounts'};
  await assert.rejects(callTool('update_account',args,ctx),{code:'bad_input'});
  await assert.rejects(callTool('update_account',{...args,confirm:true,evidence:'please merge'},ctx),{code:'bad_input'});
  const ask={...ctx,channel:'ask',conversationKey:'ask:123456abcdef',ownerText:'yes, merge these accounts'};
  await assert.rejects(callTool('update_account',{...args,confirm:true},ask),{code:'bad_input'});
  await s.db.prepare('INSERT INTO conversations (key,created_at,last_at) VALUES (?,?,?)').run(ask.conversationKey,NOW,NOW);
  await s.db.prepare("INSERT INTO messages (conversation_key,role,text,ts,provenance) VALUES (?, 'fathom', 'Merge the shown candidates?', ?, ?)").run(ask.conversationKey,NOW,JSON.stringify({tools:[{name:'accounts',args:{operation:'merge_candidates',id:ids.keep},result:await api.accountMergeCandidates({...ctx,params:{id:ids.keep}})}]}));
  const r=await callTool('update_account',{...args,confirm:true},ask);
  assert.equal(r.survivorId,ids.keep);assert.equal((await s.db.prepare('SELECT count(*) AS n FROM transactions WHERE account_id=?').get(ids.own)).n,0);
  await undo(ask,r);assert.ok((await s.db.prepare('SELECT count(*) AS n FROM transactions WHERE account_id=?').get(ids.own)).n>0);
  const again=await callTool('update_account',{...args,confirm:true},ctx);
  await s.db.prepare('UPDATE transactions SET amount=amount-1 WHERE id=?').run(moved);
  await assert.rejects(undo(ctx,again),e=>e.code==='changed_since'||e.reason==='changed_since'||/changed_since|changed since/.test(e.message));
});

test('all account operations deny a read key before validating arguments',async()=>{
  const server=createToolServer({scopes:['read'],authorize:()=>true,ctx:{},runTool:fn=>fn()});
  for(const operation of ['rename','mask','owner','kind','merge']){
    const r=await server._requestHandlers.get('tools/call')({method:'tools/call',params:{name:'update_account',arguments:{operation}}},{});assert.equal(r.isError,true);assert.match(r.content[0].text,/Permission denied.*write:accounts/);
  }
});

test('account rename proposals ignore unrelated postings and stale on the target account',async t=>{
  const s=await realStore();t.after(async ()=>await s.close());await account(s);const ctx=context(s);let pending;
  const p=proposalTools(tools).find(t=>t.name==='update_account');
  await p.handler({operation:'rename',id:'manual',displayName:'Reserve',propose:true},{...ctx,onProposal:v=>{pending=v;}});
  assert.equal((await row(s)).display_name,null);assert.equal(pending.scopes[0],'write:accounts');
  const basis=pending.basis;
  await s.db.prepare("INSERT INTO transactions (account_id,date,amount,description) VALUES ('manual','2032-03-01',-1,'New posting')").run();
  assert.equal(await proposalBasis(s.db,pending.tool,pending.scopes,pending.args),basis);
  await s.db.prepare("UPDATE accounts SET display_name='Later' WHERE id='manual'").run();
  assert.notEqual(await proposalBasis(s.db,pending.tool,pending.scopes,pending.args),basis);
});

for (const confirmation of ['yes','Confirmed']) test(`a stored Ask merge proposal executes on ${confirmation} and its own scope can undo`,async t=>{
  const { claimProposal, executeProposal }=await import('../src/actions/proposals.mjs');
  const s=await realStore();t.after(async ()=>await s.close());const ids=await seedDuplicate(s,{sure:true});
  const key='ask:fedcba654321',ctx={...context(s),channel:'ask',conversationKey:key,ownerText:'Merge these accounts',scopes:['write:accounts']};
  await s.db.prepare('INSERT INTO conversations (key,created_at,last_at) VALUES (?,?,?)').run(key,NOW,NOW);
  let pending;const tool=proposalTools(tools).find(t=>t.name==='update_account');
  await tool.handler({operation:'merge',id:ids.keep,withId:ids.own,confirm:true,evidence:'Merge these accounts',propose:true},{...ctx,onProposal:p=>{pending=p;}});
  assert.ok(await s.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(ids.own));
  const id=Number((await s.db.prepare("INSERT INTO messages (conversation_key,role,text,ts,provenance) VALUES (?,'fathom','Merge these shown candidates?',?,?) RETURNING id").get(key,NOW,JSON.stringify({pendingAction:pending,tools:[{name:'accounts',args:{operation:'merge_candidates',id:ids.keep}}]}))).id);
  await api.accountMergeCandidates({...ctx,params:{id:ids.keep}});
  const {scenarioOf}=await import('../src/api/scenario.mjs');await scenarioOf(ctx);
  const claim=await claimProposal(s.db,{key,id,decision:'confirm',scopes:ctx.scopes,at:NOW});assert.equal(claim.status,'confirmed');
  const out=await executeProposal(claim.pending,{...ctx,ownerText:confirmation,evidenceMessageId:id});
  assert.equal(out.receipt.scope,'write:accounts');assert.equal(await s.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(ids.own),undefined);
  await assert.rejects(undo({...ctx,scopes:['write:confirm']},out),{code:'forbidden'});
  await undo(ctx,out);assert.ok(await s.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(ids.own));
});

test('source-operation proposals retain the merged catalog scope and durable Undo',async t=>{
 const {claimProposal,executeProposal}=await import('../src/actions/proposals.mjs');
 const s=await realStore();t.after(async ()=>await s.close());await account(s);
 const key='ask:abc123def456',ctx={...context(s),channel:'ask',conversationKey:key,scopes:['write:sources']};
 await s.db.prepare('INSERT INTO conversations (key,created_at,last_at) VALUES (?,?,?)').run(key,NOW,NOW);
 let pending;await proposalTools(tools).find(t=>t.name==='sources').handler({operation:'archive_account',id:'manual',propose:true},{...ctx,onProposal:p=>{pending=p;}});
 assert.equal((await row(s)).archived_at,null);
 const id=Number((await s.db.prepare("INSERT INTO messages (conversation_key,role,text,ts,provenance) VALUES (?,'fathom','Archive this account?',?,?) RETURNING id").get(key,NOW,JSON.stringify({pendingAction:pending}))).id);
 const claim=await claimProposal(s.db,{key,id,decision:'confirm',scopes:ctx.scopes,at:NOW});assert.equal(claim.status,'confirmed');
 const out=await executeProposal(claim.pending,ctx);assert.ok((await row(s)).archived_at);assert.equal(out.receipt.scope,'write:sources');
 await undo(ctx,out);assert.equal((await row(s)).archived_at,null);
});

for (const [operation,params] of [
 ['mask',{mask:'1234'}],['owner',{owner:'owner'}],['kind',{kind:'taxable'}],
]) test(`account ${operation} proposals ignore unrelated rows and guard the target`,async t=>{
 const s=await realStore();t.after(async ()=>await s.close());await account(s);await account(s,'unrelated');let pending;
 await proposalTools(tools).find(t=>t.name==='update_account').handler({operation,id:'manual',...params,propose:true},{...context(s),onProposal:p=>{pending=p;}});
 const basis=async ()=>await proposalBasis(s.db,pending.tool,pending.scopes,pending.args);
 await s.db.prepare("INSERT INTO transactions (account_id,date,amount,description) VALUES ('unrelated','2032-03-01',-10,'New posting')").run();
 await s.db.prepare("UPDATE accounts SET display_name='Other reserve' WHERE id='unrelated'").run();
 assert.equal(await basis(),pending.basis);
 await s.db.prepare("UPDATE accounts SET display_name='Target reserve' WHERE id='manual'").run();
 assert.notEqual(await basis(),pending.basis);
});


test('merge proposals ignore unrelated transactions and retain both accounts and moved rows',async t=>{
 const s=await realStore();t.after(async ()=>await s.close());const ids=await seedDuplicate(s,{sure:true});await account(s,'unrelated');
 const args={id:ids.keep,withId:ids.own,confirm:true,evidence:'yes, merge these accounts'};
 const basis=async (db=s.db)=>await proposalBasis(db,'update_account',['write:accounts'],args), before=await basis();
 await s.db.prepare("INSERT INTO transactions(account_id,date,amount,description) VALUES ('unrelated','2032-03-01',-10,'Unrelated posting')").run();
 await s.db.prepare("INSERT INTO transactions(account_id,date,amount,description) VALUES (?,'2032-03-01',-999,'Unrelated survivor posting')").run(ids.keep);
 assert.equal(await basis(),before);
 for(const id of [ids.keep,ids.own]){
  await rehearse(s.db,async h=>{
   await h.prepare("UPDATE accounts SET display_name='Changed' WHERE id=?").run(id);
   assert.notEqual(await basis(h),before);
  });
 }
 await s.db.prepare('UPDATE transactions SET amount=amount-1 WHERE account_id=?').run(ids.own);
 assert.notEqual(await basis(),before);
});


test('a completed merge makes its outstanding proposal stale without throwing',async t=>{
 const s=await realStore();t.after(async ()=>await s.close());const ids=await seedDuplicate(s,{sure:true});
 const args={id:ids.keep,withId:ids.own,confirm:true,evidence:'yes, merge these accounts'};
 const before=await proposalBasis(s.db,'update_account',['write:accounts'],args);
 await callTool('update_account',{operation:'merge',...args},context(s));
 assert.notEqual(await proposalBasis(s.db,'update_account',['write:accounts'],args),before);
});
