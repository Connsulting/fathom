import test from 'node:test';
import assert from 'node:assert/strict';
import { realStore, NOW } from './helpers/ingest.mjs';
import { callTool, tools } from '../src/tools/index.mjs';
import { createToolServer } from '../src/mcp/server.mjs';
import { ask, answerItem } from '../src/ingest/confirm.mjs';
import { loadCategoryInputs } from '../src/categories/store.mjs';
import { resolveCategories, normalizeMerchant } from '../src/categories/resolve.mjs';
import { proposalTools, proposalBasis } from '../src/actions/proposals.mjs';

async function setup(t){const s=await realStore();t.after(()=>s.close());await s.db.prepare("INSERT INTO accounts (id,name,kind,owner) VALUES ('card','Synthetic card','card','You')").run();
 for(const description of ['Warehouse Club #1','Warehouse Club #1','Other shop'])await s.db.prepare("INSERT INTO transactions (account_id,date,amount,description) VALUES ('card','2032-02-01',-150,?)").run(description);
 return {...s,ctx:{db:s.db,household:s.household,config:s.config,now:NOW,actorId:'test-owner',channel:'mcp'}};}
const correction=async (db,id)=>await db.prepare('SELECT category,bucket FROM transaction_category_corrections WHERE transaction_id=?').get(id);

test('transaction category matches Confirm and undo restores its prior category',async t=>{
 const s=await setup(t), ids=(await s.db.prepare('SELECT id FROM transactions ORDER BY id').all()).map(r=>r.id);
 const out=await callTool('categorize',{operation:'transaction',transactionId:ids[0],category:'Groceries'},s.ctx);
 const q=await ask(s.db,{kind:'transaction_category',subject:String(ids[1]),question:'Category?',options:[{id:'Groceries',label:'Groceries'}],context:{transactionId:ids[1]},now:NOW});
 await answerItem(s.db,q.id,'Groceries',{now:NOW});assert.deepEqual(await correction(s.db,ids[0]),await correction(s.db,ids[1]));
 assert.equal(out.transaction.category,'Groceries');assert.equal(out.transaction.bucket,'household');assert.equal(typeof out.transaction.class,'string');
 await callTool('undo',{operation:'undo',id:out.receipt.id},s.ctx);assert.equal(await correction(s.db,ids[0]),undefined);
});

test('merchant rule affected count agrees with resolved rows and both replacements undo',async t=>{
 const s=await setup(t), merchant=normalizeMerchant('Warehouse Club #1');
 const r=await callTool('categorize',{operation:'merchant_rule',merchant,category:'Groceries'},s.ctx);
 const input=await loadCategoryInputs(s.db), resolved=resolveCategories(input);
 const affected=input.transactions.filter(tx=>normalizeMerchant(tx.description)===merchant&&resolved.get(tx.id).category==='Groceries').length;
 assert.equal(r.affected.value,affected);assert.equal(affected,2);assert.equal(r.affected.unit,'count');
 const next=await callTool('categorize',{operation:'merchant_rule',merchant,category:'Shopping'},s.ctx);
 await callTool('undo',{operation:'undo',id:next.receipt.id},s.ctx);assert.equal((await s.db.prepare('SELECT category FROM category_merchant_rules WHERE merchant=?').get(merchant)).category,'Groceries');
 await callTool('undo',{operation:'undo',id:r.receipt.id},s.ctx);assert.equal(await s.db.prepare('SELECT * FROM category_merchant_rules WHERE merchant=?').get(merchant),undefined);
});

test('invalid category, missing transaction and stale receipt refuse without writing',async t=>{
 const s=await setup(t),id=(await s.db.prepare('SELECT id FROM transactions LIMIT 1').get()).id;
 await assert.rejects(callTool('categorize',{operation:'transaction',transactionId:id,category:'Invented category'},s.ctx));
 await assert.rejects(callTool('categorize',{operation:'transaction',transactionId:99999,category:'Groceries'},s.ctx));
 assert.equal((await s.db.prepare('SELECT count(*) AS n FROM transaction_category_corrections').get()).n,0);
 const r=await callTool('categorize',{operation:'transaction',transactionId:id,category:'Groceries'},s.ctx);
 await callTool('categorize',{operation:'transaction',transactionId:id,category:'Shopping'},s.ctx);
 await assert.rejects(callTool('undo',{operation:'undo',id:r.receipt.id},s.ctx),/changed since/);
});

test('category scopes and proposal basis cover rules and transaction changes',async t=>{
 const s=await setup(t), server=createToolServer({scopes:['read'],authorize:()=>true,ctx:s.ctx,runTool:fn=>fn()});
 for(const operation of ['transaction','merchant_rule']){const r=await server._requestHandlers.get('tools/call')({method:'tools/call',params:{name:'categorize',arguments:{operation}}},{});assert.match(r.content[0].text,/Permission denied.*write:categories/);}
 let pending;await proposalTools(tools).find(t=>t.name==='categorize').handler({operation:'merchant_rule',merchant:'warehouse club',category:'Groceries',propose:true},{...s.ctx,onProposal:v=>{pending=v;}});
 assert.equal((await s.db.prepare('SELECT count(*) AS n FROM category_merchant_rules').get()).n,0);
 const basis=pending.basis;
 await s.db.prepare("INSERT INTO transactions (account_id,date,amount,description) VALUES ('card','2032-02-02',-20,'Unrelated shop')").run();
 assert.equal(await proposalBasis(s.db,'categorize',pending.scopes,pending.args),basis);
 await s.db.prepare("UPDATE transactions SET description='Different'").run();
 assert.notEqual(await proposalBasis(s.db,'categorize',pending.scopes,pending.args),basis);
});

test('merchant count excludes individual corrections and repeat rules change no categories',async t=>{
 const s=await setup(t),merchant=normalizeMerchant('Warehouse Club #1'),id=(await s.db.prepare('SELECT id FROM transactions ORDER BY id LIMIT 1').get()).id;
 await callTool('categorize',{operation:'transaction',transactionId:id,category:'Shopping'},s.ctx);
 const r=await callTool('categorize',{operation:'merchant_rule',merchant,category:'Groceries'},s.ctx);
 assert.equal(r.affected.value,1);assert.equal(resolveCategories(await loadCategoryInputs(s.db)).get(id).category,'Shopping');
 const again=await callTool('categorize',{operation:'merchant_rule',merchant,category:'Groceries'},s.ctx);assert.equal(again.affected.value,0);
});

test('Confirm always answers retain long merchants while the tool enforces its input limit',async t=>{
 const s=await setup(t),description='Long synthetic merchant '.repeat(12),merchant=normalizeMerchant(description);
 const id=Number((await s.db.prepare("INSERT INTO transactions (account_id,date,amount,description) VALUES ('card','2032-02-02',-175,?)").run(description)).lastInsertRowid);
 const q=await ask(s.db,{kind:'transaction_category',subject:String(id),question:'Category?',options:[{id:'always:Groceries',label:'Groceries'}],context:{transactionId:id},now:NOW});
 await answerItem(s.db,q.id,'always:Groceries',{now:NOW});
 assert.equal((await s.db.prepare('SELECT category FROM category_merchant_rules WHERE merchant=?').get(merchant)).category,'Groceries');
 await assert.rejects(callTool('categorize',{operation:'merchant_rule',merchant,category:'Groceries'},s.ctx),{code:'bad_input'});
});

test('transaction category proposals ignore other transactions but retain the correction row',async t=>{
 const s=await setup(t),id=(await s.db.prepare('SELECT id FROM transactions ORDER BY id LIMIT 1').get()).id;
 let pending;await proposalTools(tools).find(t=>t.name==='categorize').handler({operation:'transaction',transactionId:id,category:'Groceries',propose:true},{...s.ctx,onProposal:v=>{pending=v;}});
 const basis=async ()=>await proposalBasis(s.db,pending.tool,pending.scopes,pending.args);
 await s.db.prepare('UPDATE transactions SET amount=amount-1 WHERE id!=?').run(id);
 assert.equal(await basis(),pending.basis);
 await callTool('categorize',{operation:'transaction',transactionId:id,category:'Shopping'},s.ctx);
 assert.notEqual(await basis(),pending.basis);
});

test('merchant proposals guard their rule and the requested category mapping',async t=>{
 const s=await setup(t),merchant=normalizeMerchant('Warehouse Club #1');let pending;
 await s.db.prepare("INSERT INTO category_source_rules (parser,category,bucket,updated_at) VALUES ('synthetic','Custom category','household',?)").run(NOW);
 await proposalTools(tools).find(t=>t.name==='categorize').handler({operation:'merchant_rule',merchant,category:'Custom category',propose:true},{...s.ctx,onProposal:p=>{pending=p;}});
 const basis=async ()=>await proposalBasis(s.db,pending.tool,pending.scopes,pending.args);
 await callTool('categorize',{operation:'merchant_rule',merchant:'Other shop',category:'Groceries'},s.ctx);
 assert.equal(await basis(),pending.basis);
 await s.db.prepare("UPDATE category_source_rules SET bucket='business' WHERE category='Custom category'").run();
 assert.notEqual(await basis(),pending.basis);
 const prior=await basis();
 await callTool('categorize',{operation:'merchant_rule',merchant,category:'Groceries'},s.ctx);
 assert.notEqual(await basis(),prior);
});
