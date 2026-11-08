import test from 'node:test';
import assert from 'node:assert/strict';
import { realStore, NOW } from './helpers/ingest.mjs';
import { callTool, tools } from '../src/tools/index.mjs';
import { createToolServer } from '../src/mcp/server.mjs';
import { ask, answerItem } from '../src/ingest/confirm.mjs';
import { loadCategoryInputs } from '../src/categories/store.mjs';
import { resolveCategories, normalizeMerchant } from '../src/categories/resolve.mjs';
import { proposalTools, proposalBasis } from '../src/actions/proposals.mjs';

async function setup(t){const s=await realStore();t.after(()=>s.close());s.db.prepare("INSERT INTO accounts (id,name,kind,owner) VALUES ('card','Synthetic card','card','You')").run();
 for(const description of ['Warehouse Club #1','Warehouse Club #1','Other shop'])s.db.prepare("INSERT INTO transactions (account_id,date,amount,description) VALUES ('card','2032-02-01',-150,?)").run(description);
 return {...s,ctx:{db:s.db,household:s.household,config:s.config,now:NOW,actorId:'test-owner',channel:'mcp'}};}
const correction=(db,id)=>db.prepare('SELECT category,bucket FROM transaction_category_corrections WHERE transaction_id=?').get(id);

test('transaction category matches Confirm and undo restores its prior category',async t=>{
 const s=await setup(t), ids=s.db.prepare('SELECT id FROM transactions ORDER BY id').all().map(r=>r.id);
 const out=await callTool('categorize',{operation:'transaction',transactionId:ids[0],category:'Groceries'},s.ctx);
 const q=ask(s.db,{kind:'transaction_category',subject:String(ids[1]),question:'Category?',options:[{id:'Groceries',label:'Groceries'}],context:{transactionId:ids[1]},now:NOW});
 answerItem(s.db,q.id,'Groceries',{now:NOW});assert.deepEqual(correction(s.db,ids[0]),correction(s.db,ids[1]));
 assert.equal(out.transaction.category,'Groceries');assert.equal(out.transaction.bucket,'household');assert.equal(typeof out.transaction.class,'string');
 await callTool('undo',{operation:'undo',id:out.receipt.id},s.ctx);assert.equal(correction(s.db,ids[0]),undefined);
});

test('merchant rule affected count agrees with resolved rows and both replacements undo',async t=>{
 const s=await setup(t), merchant=normalizeMerchant('Warehouse Club #1');
 const r=await callTool('categorize',{operation:'merchant_rule',merchant,category:'Groceries'},s.ctx);
 const input=loadCategoryInputs(s.db), resolved=resolveCategories(input);
 const affected=input.transactions.filter(tx=>normalizeMerchant(tx.description)===merchant&&resolved.get(tx.id).category==='Groceries').length;
 assert.equal(r.affected.value,affected);assert.equal(affected,2);assert.equal(r.affected.unit,'count');
 const next=await callTool('categorize',{operation:'merchant_rule',merchant,category:'Shopping'},s.ctx);
 await callTool('undo',{operation:'undo',id:next.receipt.id},s.ctx);assert.equal(s.db.prepare('SELECT category FROM category_merchant_rules WHERE merchant=?').get(merchant).category,'Groceries');
 await callTool('undo',{operation:'undo',id:r.receipt.id},s.ctx);assert.equal(s.db.prepare('SELECT * FROM category_merchant_rules WHERE merchant=?').get(merchant),undefined);
});

test('invalid category, missing transaction and stale receipt refuse without writing',async t=>{
 const s=await setup(t),id=s.db.prepare('SELECT id FROM transactions LIMIT 1').get().id;
 await assert.rejects(callTool('categorize',{operation:'transaction',transactionId:id,category:'Invented category'},s.ctx));
 await assert.rejects(callTool('categorize',{operation:'transaction',transactionId:99999,category:'Groceries'},s.ctx));
 assert.equal(s.db.prepare('SELECT count(*) AS n FROM transaction_category_corrections').get().n,0);
 const r=await callTool('categorize',{operation:'transaction',transactionId:id,category:'Groceries'},s.ctx);
 await callTool('categorize',{operation:'transaction',transactionId:id,category:'Shopping'},s.ctx);
 await assert.rejects(callTool('undo',{operation:'undo',id:r.receipt.id},s.ctx),/changed since/);
});

test('category scopes and proposal basis cover rules and transaction changes',async t=>{
 const s=await setup(t), server=createToolServer({scopes:['read'],ctx:s.ctx});
 for(const operation of ['transaction','merchant_rule']){const r=await server._requestHandlers.get('tools/call')({method:'tools/call',params:{name:'categorize',arguments:{operation}}},{});assert.match(r.content[0].text,/Permission denied.*write:categories/);}
 let pending;await proposalTools(tools).find(t=>t.name==='categorize').handler({operation:'merchant_rule',merchant:'warehouse club',category:'Groceries',propose:true},{...s.ctx,onProposal:v=>{pending=v;}});
 assert.equal(s.db.prepare('SELECT count(*) AS n FROM category_merchant_rules').get().n,0);
 const basis=pending.basis;s.db.prepare("UPDATE transactions SET description='Different'").run();
 assert.notEqual(proposalBasis(s.db,'categorize',pending.scopes,pending.args),basis);
});
