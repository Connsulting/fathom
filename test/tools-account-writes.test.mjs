import test from 'node:test';
import assert from 'node:assert/strict';
import { realStore, NOW } from './helpers/ingest.mjs';
import { seedDuplicate } from './helpers/account-merge.mjs';
import { callTool, tools } from '../src/tools/index.mjs';
import { createToolServer } from '../src/mcp/server.mjs';
import { proposalTools, proposalBasis } from '../src/actions/proposals.mjs';
import * as api from '../src/api/accounts.mjs';

const context = s => ({ db: s.db, household: s.household, config: s.config, now: NOW, actorId: 'test-owner', channel: 'mcp', ownerText: 'yes, merge these accounts', replan: async () => ({ status: 'ok' }) });
const account = (s,id='manual') => s.db.prepare("INSERT INTO accounts (id,name,inst,kind,owner,mirror) VALUES (?, 'Savings', 'Example Bank', 'cash', 'Your spouse', 'manual')").run(id);
const row = (s,id='manual') => ({ ...s.db.prepare('SELECT * FROM accounts WHERE id=?').get(id) });
const undo = (ctx,r) => callTool('undo',{ operation:'undo', id:r.receipt.id },ctx);

for (const [operation,params,field,value] of [
  ['rename',{ displayName:'Rainy day' },'display_name','Rainy day'],
  ['mask',{ mask:'1234' },'mask','1234'],
  ['owner',{ owner:'owner' },'owner','You'],
  ['kind',{ kind:'taxable' },'kind','taxable'],
]) test(`account ${operation} matches the route and undoes`,async t => {
  const s=await realStore();t.after(()=>s.close());account(s);account(s,'route');
  const ctx=context(s), before=row(s);
  const result=await callTool('update_account',{operation,id:'manual',...params},ctx);
  const handler={rename:api.accountRename,mask:api.accountMask,owner:api.accountOwner,kind:api.accountKind}[operation];
  handler({...ctx,params:{id:'route'},body:params});
  assert.equal(row(s)[field],value);assert.equal(row(s,'route')[field],value);
  assert.equal(result.account.id,'manual');assert.equal(result.receipt.scope,'write:accounts');assert.equal(result.undo.available,true);
  await undo(ctx,result);assert.equal(row(s)[field],before[field]);
});

test('account receipts refuse later edits and another actor',async t=>{
  const s=await realStore();t.after(()=>s.close());account(s);const ctx=context(s);
  const r=await callTool('update_account',{operation:'rename',id:'manual',displayName:'Reserve'},ctx);
  await assert.rejects(undo({...ctx,actorId:'someone-else'},r),{code:'forbidden'});
  s.db.prepare("UPDATE accounts SET display_name='Later' WHERE id='manual'").run();
  await assert.rejects(undo(ctx,r),/changed since/);
  const own=await callTool('update_account',{operation:'owner',id:'manual',owner:'owner'},ctx);
  api.accountOwner({...ctx,params:{id:'manual'},body:{owner:'joint'}});
  await assert.rejects(undo(ctx,own),/changed since/);
});

test('merge requires confirmation and later owner evidence, then restores moved rows',async t=>{
  const s=await realStore();t.after(()=>s.close());const ids=await seedDuplicate(s,{sure:true});const ctx=context(s);
  const moved=Number(s.db.prepare("INSERT INTO transactions (account_id,date,amount,description) VALUES (?,'2032-03-02',-57,'Unique moved row')").run(ids.own).lastInsertRowid);
  const args={operation:'merge',id:ids.keep,withId:ids.own,evidence:'yes, merge these accounts'};
  await assert.rejects(callTool('update_account',args,ctx),{code:'bad_input'});
  await assert.rejects(callTool('update_account',{...args,confirm:true,evidence:'please merge'},ctx),{code:'bad_input'});
  const ask={...ctx,channel:'ask',conversationKey:'ask:123456abcdef',ownerText:'yes, merge these accounts'};
  await assert.rejects(callTool('update_account',{...args,confirm:true},ask),{code:'bad_input'});
  s.db.prepare('INSERT INTO conversations (key,created_at,last_at) VALUES (?,?,?)').run(ask.conversationKey,NOW,NOW);
  s.db.prepare("INSERT INTO messages (conversation_key,role,text,ts,provenance) VALUES (?, 'fathom', 'Merge the shown candidates?', ?, ?)").run(ask.conversationKey,NOW,JSON.stringify({tools:[{name:'accounts',args:{operation:'merge_candidates',id:ids.keep},result:api.accountMergeCandidates({...ctx,params:{id:ids.keep}})}]}));
  const r=await callTool('update_account',{...args,confirm:true},ask);
  assert.equal(r.survivorId,ids.keep);assert.equal(s.db.prepare('SELECT count(*) AS n FROM transactions WHERE account_id=?').get(ids.own).n,0);
  await undo(ask,r);assert.ok(s.db.prepare('SELECT count(*) AS n FROM transactions WHERE account_id=?').get(ids.own).n>0);
  const again=await callTool('update_account',{...args,confirm:true},ctx);
  s.db.prepare('UPDATE transactions SET amount=amount-1 WHERE id=?').run(moved);
  await assert.rejects(undo(ctx,again),e=>e.code==='changed_since'||e.reason==='changed_since'||/changed_since|changed since/.test(e.message));
});

test('all account operations deny a read key before validating arguments',async()=>{
  const server=createToolServer({scopes:['read'],authorize:()=>true,ctx:{}});
  for(const operation of ['rename','mask','owner','kind','merge']){
    const r=await server._requestHandlers.get('tools/call')({method:'tools/call',params:{name:'update_account',arguments:{operation}}},{});assert.equal(r.isError,true);assert.match(r.content[0].text,/Permission denied.*write:accounts/);
  }
});

test('account rename proposals ignore unrelated postings and stale on the target account',async t=>{
  const s=await realStore();t.after(()=>s.close());account(s);const ctx=context(s);let pending;
  const p=proposalTools(tools).find(t=>t.name==='update_account');
  await p.handler({operation:'rename',id:'manual',displayName:'Reserve',propose:true},{...ctx,onProposal:v=>{pending=v;}});
  assert.equal(row(s).display_name,null);assert.equal(pending.scopes[0],'write:accounts');
  const basis=pending.basis;
  s.db.prepare("INSERT INTO transactions (account_id,date,amount,description) VALUES ('manual','2032-03-01',-1,'New posting')").run();
  assert.equal(proposalBasis(s.db,pending.tool,pending.scopes,pending.args),basis);
  s.db.prepare("UPDATE accounts SET display_name='Later' WHERE id='manual'").run();
  assert.notEqual(proposalBasis(s.db,pending.tool,pending.scopes,pending.args),basis);
});

for (const confirmation of ['yes','Confirmed']) test(`a stored Ask merge proposal executes on ${confirmation} and its own scope can undo`,async t=>{
  const { claimProposal, executeProposal }=await import('../src/actions/proposals.mjs');
  const s=await realStore();t.after(()=>s.close());const ids=await seedDuplicate(s,{sure:true});
  const key='ask:fedcba654321',ctx={...context(s),channel:'ask',conversationKey:key,ownerText:'Merge these accounts',scopes:['write:accounts']};
  s.db.prepare('INSERT INTO conversations (key,created_at,last_at) VALUES (?,?,?)').run(key,NOW,NOW);
  let pending;const tool=proposalTools(tools).find(t=>t.name==='update_account');
  await tool.handler({operation:'merge',id:ids.keep,withId:ids.own,confirm:true,evidence:'Merge these accounts',propose:true},{...ctx,onProposal:p=>{pending=p;}});
  assert.ok(s.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(ids.own));
  const id=Number(s.db.prepare("INSERT INTO messages (conversation_key,role,text,ts,provenance) VALUES (?,'fathom','Merge these shown candidates?',?,?)").run(key,NOW,JSON.stringify({pendingAction:pending,tools:[{name:'accounts',args:{operation:'merge_candidates',id:ids.keep}}]})).lastInsertRowid);
  api.accountMergeCandidates({...ctx,params:{id:ids.keep}});
  const {scenarioOf}=await import('../src/api/scenario.mjs');scenarioOf(ctx);
  const claim=claimProposal(s.db,{key,id,decision:'confirm',scopes:ctx.scopes,at:NOW});assert.equal(claim.status,'confirmed');
  const out=await executeProposal(claim.pending,{...ctx,ownerText:confirmation,evidenceMessageId:id});
  assert.equal(out.receipt.scope,'write:accounts');assert.equal(s.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(ids.own),undefined);
  await assert.rejects(undo({...ctx,scopes:['write:confirm']},out),{code:'forbidden'});
  await undo(ctx,out);assert.ok(s.db.prepare('SELECT 1 FROM accounts WHERE id=?').get(ids.own));
});

test('source-operation proposals retain the merged catalog scope and durable Undo',async t=>{
 const {claimProposal,executeProposal}=await import('../src/actions/proposals.mjs');
 const s=await realStore();t.after(()=>s.close());account(s);
 const key='ask:abc123def456',ctx={...context(s),channel:'ask',conversationKey:key,scopes:['write:sources']};
 s.db.prepare('INSERT INTO conversations (key,created_at,last_at) VALUES (?,?,?)').run(key,NOW,NOW);
 let pending;await proposalTools(tools).find(t=>t.name==='sources').handler({operation:'archive_account',id:'manual',propose:true},{...ctx,onProposal:p=>{pending=p;}});
 assert.equal(row(s).archived_at,null);
 const id=Number(s.db.prepare("INSERT INTO messages (conversation_key,role,text,ts,provenance) VALUES (?,'fathom','Archive this account?',?,?)").run(key,NOW,JSON.stringify({pendingAction:pending})).lastInsertRowid);
 const claim=claimProposal(s.db,{key,id,decision:'confirm',scopes:ctx.scopes,at:NOW});assert.equal(claim.status,'confirmed');
 const out=await executeProposal(claim.pending,ctx);assert.ok(row(s).archived_at);assert.equal(out.receipt.scope,'write:sources');
 await undo(ctx,out);assert.equal(row(s).archived_at,null);
});
