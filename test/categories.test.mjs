import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createInstance } from '../src/platform/db.mjs';
import { setSetting } from '../src/store/db.mjs';
import { resolveCategories, CATEGORY_TABLES, normalizeMerchant } from '../src/categories/resolve.mjs';
import { loadCategoryInputs, queueCategoryChecks, categoryCoverage, moveCategoryRows } from '../src/categories/store.mjs';
import { guessCategories } from '../src/categories/guess.mjs';
import { answerItem, reopenItem, pendingItems, ask } from '../src/ingest/confirm.mjs';
import { ingestFile, accountIdOf } from '../src/ingest/pipeline.mjs';
import { bestGuess } from '../src/ingest/bestguess.mjs';
import { validateGuesses } from '../src/ingest/guess.mjs';
import { aggregatorFile } from './helpers/ingest.mjs';
import { householdContext, instanceSecretsOf } from './helpers/server.mjs';
import { spendingInputs, spendingFigures } from '../src/calc/targets.mjs';
import { visibleOptions, categoryAnswerOption } from '../web/horizon/screens/ingest.js';

const clock = '2032-11-05';
const accounts = [{ id: 'checking', kind: 'checking', inst: 'Example Bank' }, { id: 'saving', kind: 'savings' },
  { id: 'card', kind: 'card', inst: 'Example Card', mask: '5678' }, { id: 'biz', kind: 'business' }];
const row = (id, patch = {}) => ({ id, account_id: 'checking', date: '2032-06-10', amount: -250, description: 'Example Shop', ...patch });
const resolve = (transactions, extra = {}) => resolveCategories({ transactions, accounts, ...extra });
async function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fathom-category-'));
  const s = await createInstance(dir, { mode: 'real' });
  await setSetting(s.db, 'clock', clock);
  t.after(async () => { await s.db.close(); await s.platform.close(); rmSync(dir, { recursive: true, force: true }); });
  return { ...s, dir };
}
async function account(db, id = 'checking', kind = 'checking') {
  await db.prepare("INSERT INTO accounts (id,kind,inst,mask,name,display_name,identity) VALUES (?,?, 'Example Bank','1111','Synthetic checking','Everyday account',?)").run(id, kind, 'examplebank|mask:' + id);
}
async function txn(db, patch = {}) {
  const r = row(0, patch);
  const q = await db.prepare('INSERT INTO transactions (account_id,date,amount,description,category,parser,dedupe_key,external_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(r.account_id, r.date, r.amount, r.description, r.category ?? null, r.parser ?? 'simplefin', r.dedupe_key ?? null, r.external_id ?? null);
  return Number(q.lastInsertRowid);
}
async function history(db) {
  for (let m = 1; m <= 8; m++) for (const amount of [-100, 3000]) await txn(db, { date: `2032-${String(m).padStart(2, '0')}-15`, amount, description: amount < 0 ? 'Household item' : 'Earned deposit', category: amount < 0 ? 'Groceries' : 'Income', parser: 'aggregator' });
}
const spend = async db => { const input = await loadCategoryInputs(db); return spendingInputs({ ...input, clock }); };

test('AC1 shipped source tables cover every stock name, and unknown names fall through', () => {
  const stock = ['Shopping','Income','Dining & Drinks','Business','Credit Card Payment','Entertainment & Rec.','Bills & Utilities','Auto & Transport','Groceries','Travel & Vacation','Software & Tech','Home & Garden','Mortgage','Income Tax','Investment','Medical','Childcare','Internal Transfers','Gifts','Uncategorized','Health & Wellness','Personal Care','Healthcare Premiums','Taxes','Cash & Checks','Mortgage Principal','HSA','Pets','Fees','Ignore','Family Care','Charitable Donations','Savings Transfer','Legal'];
  assert.deepEqual(Object.keys(CATEGORY_TABLES.aggregator).sort(), stock.sort());
  for (const [name, bucket] of Object.entries(CATEGORY_TABLES.aggregator)) {
    const c = resolve([row(1, { category: name, parser: 'aggregator' })]).get(1);
    assert.equal(c.layer, name === 'Uncategorized' ? 'uncategorized' : 'import');
    if (bucket) assert.equal(c.bucket, bucket);
  }
  const unknown = row(2, { category: 'Future Export Name', parser: 'another-app' });
  assert.equal(resolve([unknown]).get(2).category, 'Future Export Name');
  assert.equal(resolve([unknown]).get(2).layer, 'uncategorized');
  const m = resolve([unknown], { sourceRules: [{ parser: 'another-app', category: 'Future Export Name', bucket: 'tax' }] });
  assert.equal(m.get(2).bucket, 'tax');
  assert.equal(m.get(2).layer, 'correction');
});

test('AC1 first answering layer wins and memory never learns from a guess', () => {
  const transactions = [row(1, { category: 'Business', parser: 'aggregator' }),row(3,{category:'Business',parser:'aggregator',date:'2032-06-09'}),
    row(4,{category:'Business',parser:'aggregator',date:'2032-06-08'}), row(2, { date: '2032-06-12' })];
  const all = { corrections: [{ transaction_id: 2, category: 'Groceries', bucket: 'household' }], merchantRules: [{ merchant: 'example shop', category: 'Taxes', bucket: 'tax' }], guesses: [{ transaction_id: 2, category: 'Investment' }] };
  assert.equal(resolve(transactions, all).get(2).category, 'Groceries');
  assert.equal(resolve(transactions, { ...all, corrections: [] }).get(2).bucket, 'tax');
  assert.equal(resolve(transactions).get(1).layer, 'import');
  assert.equal(resolve(transactions).get(2).layer, 'merchant');
  assert.equal(resolve(transactions).get(2).bucket, 'business');
  assert.equal(resolve([row(1),row(2)], { guesses: [{ transaction_id: 1, category: 'Taxes' }] }).get(2).layer, 'uncategorized');
  assert.equal(resolve([row(1)], { corrections: [{ transaction_id: 1, category: 'Taxes', bucket:'tax', auto:{text:'Jev guess, 99% confident'} }] }).get(1).layer, 'guess');
});

test('AC1 normalizes feed merchant descriptions and leaves conflicting history unresolved', () => {
  assert.equal(normalizeMerchant('POS DEBIT SQ *Example Shop #0042 06/10'), normalizeMerchant('Example Shop'));
  assert.notEqual(normalizeMerchant('Shop 7Eleven'), normalizeMerchant('Shop Eleven'));
  const a = row(1, { category: 'Groceries', parser: 'aggregator', date: '2032-03-01', category_at: '2032-08-01' });
  const b = row(2, { category: 'Business', parser: 'aggregator', date: '2032-04-01', category_at: '2032-07-01' });
  assert.equal(resolve([a,b,row(3, { description: 'POS DEBIT Example Shop #0099' })]).get(3).category, 'Uncategorized');
});

test('AC1 structural layer recognizes card payments, preserves business draws and loses to imports', () => {
  const r = resolve([row(1,{description:'AUTOPAY Example Card 5678'}),row(2,{account_id:'card',amount:250,description:'PAYMENT THANK YOU'}),
    row(3,{account_id:'biz',amount:-900}),row(4,{amount:900}),row(5,{category:'Groceries',parser:'aggregator',description:'AUTOPAY Example Card 5678'}),row(6,{description:'Payment Unknown Lender'})]);
  assert.equal(r.get(1).bucket,'transfer'); assert.equal(r.get(2).bucket,'transfer');
  assert.equal(r.get(4).bucket,'income'); assert.equal(r.get(4).layer,'uncategorized');
  assert.equal(r.get(5).bucket,'household'); assert.equal(r.get(6).layer,'uncategorized');
});

test('AC4 store path gives in-window household transfers first claim over business/pre-window rows', async t => {
  const {db} = await store(t); await account(db); await account(db,'biz','business'); await account(db,'broker','taxable'); await history(db);
  await txn(db,{ account_id:'biz',date:'2032-06-08',amount:-1000 });
  await txn(db,{ account_id:'broker',date:'2032-06-08',amount:-1000 });
  await txn(db,{ date:'2032-06-10',amount:-1000 });
  await txn(db,{ account_id:'broker',date:'2032-06-10',amount:1000 });
  assert.equal((await spend(db)).spendTotal,600);
});

test('AC4 bucket filtering and retained uncertainty note change real spending figures', async t => {
  const {db} = await store(t); await account(db); await history(db);
  for (const category of ['Business','Credit Card Payment','Internal Transfers','Savings Transfer','Ignore','Taxes','Investment','HSA','Mortgage Principal']) await txn(db,{category,parser:'aggregator',amount:-500});
  await txn(db,{amount:-275,description:'Unresolved service'});
  const sp=await spend(db); assert.equal(sp.spendTotal,875);
  const f=spendingFigures(sp,{clock}).monthlySpend;
  assert.equal(f.locator.inputs.uncategorizedSpend,275);
  assert.ok(f.notes.some(n=>n.includes('275.00') && n.includes('Uncategorized')));
  assert.match(f.locator.steps[0].formula,/household/);
});

test('AC3 amount threshold/top ten, one source-name mapping, rules past/future and undo', async t => {
  const {db} = await store(t); await account(db); await history(db);
  for(let i=0;i<12;i++) await txn(db,{amount:-(100+i),description:'Merchant '+String.fromCharCode(65+i)});
  await txn(db,{amount:-99,description:'Below threshold'});
  await txn(db,{amount:-5000,description:'Outside the spending window',date:'2031-01-15'});
  await txn(db,{amount:-6000,description:'Future posting',date:'2033-01-15'});
  await queueCategoryChecks(db,{clock});
  let pending=(await pendingItems(db)).filter(i=>i.kind==='transaction_category');
  assert.equal(pending.length,10);
  assert.equal(pending[0].context.amount,-111);
  const item=pending[0]; const before=(await spend(db)).spendTotal;
  await answerItem(db,item.id,'always:Business');
  assert.equal((await spend(db)).spendTotal,before-111);
  await txn(db,{amount:-200,description:item.context.description,date:'2032-06-11'});
  assert.equal(resolveCategories(await loadCategoryInputs(db)).get((await db.prepare('SELECT max(id) AS id FROM transactions').get()).id).bucket,'business');
  await reopenItem(db,item.id);
  assert.equal((await spend(db)).spendTotal,before+200);
  await txn(db,{category:'New category',parser:'another-app',amount:-50});
  await txn(db,{category:'New category',parser:'another-app',amount:-500});
  await queueCategoryChecks(db,{clock});
  const maps=(await pendingItems(db)).filter(i=>i.kind==='category_mapping');
  assert.equal(maps.length,1);
  await answerItem(db,maps[0].id,'tax');
  assert.equal([...resolveCategories(await loadCategoryInputs(db)).values()].filter(c=>c.category==='New category' && c.bucket==='tax').length,2);
  await reopenItem(db,maps[0].id);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM category_source_rules').get()).n,0);
});

test('AC2 live-row enrichment keeps one posting, parser provenance, replay and ambiguous rows', async t => {
  const {db,dir,platform,householdId}=await store(t); const accountId=accountIdOf('examplebank|mask:1111'); await account(db,accountId);
  await db.prepare("UPDATE accounts SET identity='examplebank|mask:1111' WHERE id=?").run(accountId);
  const id=await txn(db,{account_id:accountId,date:'2032-06-10',amount:-250,description:'POS DEBIT Example Shop',dedupe_key:'live:one',external_id:'live-one'});
  const file=aggregatorFile('export.csv',[{date:'2032-06-12',amount:250,description:'Example Shop',category:'Business'}]);
  const {secrets,keys}=await instanceSecretsOf(dir,'real');
  const household=await householdContext({db,platform,householdId,mode:'real',config:{dataDir:dir,platformKeyFile:keys.platformKeyFile,mcpSecretFile:keys.mcpSecretFile},secrets});
  const opts={household,now:'2032-08-01T12:00:00Z'};
  assert.equal((await ingestFile(db,file,opts)).status,'imported');
  assert.equal((await db.prepare('SELECT count(*) AS n FROM transactions').get()).n,1);
  const c=resolveCategories(await loadCategoryInputs(db)).get(id);
  assert.equal(c.bucket,'business'); assert.equal(c.evidence.parser,'aggregator');
  const overlap=aggregatorFile('overlap.csv',[{date:'2032-06-12',amount:250,description:'Example Shop',category:'Business'}, {date:'2032-06-13',amount:12,description:'Other Merchant',category:'Groceries'}]);
  await ingestFile(db,overlap,opts);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM transactions WHERE amount=-250').get()).n,1);
  await txn(db,{account_id:accountId,date:'2032-08-13',amount:-350,description:'Early export',dedupe_key:'live:early'});
  await ingestFile(db,aggregatorFile('early-export.csv',[{date:'2032-08-11',amount:350,description:'Early export',category:'Taxes'}]),opts);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM transactions WHERE amount=-350').get()).n,1);
  await txn(db,{account_id:accountId,date:'2032-09-10',amount:-375,description:'Late export',dedupe_key:'live:late'});
  await ingestFile(db,aggregatorFile('late-export.csv',[{date:'2032-09-13',amount:375,description:'Late export',category:'Taxes'}]),opts);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM transactions WHERE amount=-375').get()).n,2);
  await txn(db,{account_id:accountId,date:'2032-07-10',amount:-400,description:'POS Example Shop',dedupe_key:'live:two'});
  await txn(db,{account_id:accountId,date:'2032-07-10',amount:-400,description:'POS Example Shop',dedupe_key:'live:three'});
  await ingestFile(db,aggregatorFile('ambiguous.csv',[{date:'2032-07-11',amount:400,description:'Example Shop',category:'Business'}]),opts);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM transactions WHERE amount=-400').get()).n,3);
  assert.ok((await pendingItems(db)).some(i=>i.kind==='near_duplicate'));
});

test('AC2 corrections survive duplicate consolidation and its undo without cascades', async t => {
  const {db}=await store(t); await account(db);
  const a=await txn(db,{dedupe_key:'a',description:'Original description'}), b=await txn(db,{dedupe_key:'b'});
  await db.prepare("INSERT INTO transaction_category_corrections VALUES (?,'Business','business',?)").run(b,'2032-08-01');
  const q=await ask(db,{kind:'near_duplicate',subject:'a|b',question:'Same?',options:[{id:'same',label:'Same'},{id:'different',label:'Different'}],context:{keys:['a','b']}});
  await answerItem(db,q.id,'same');
  assert.equal(resolveCategories(await loadCategoryInputs(db)).get(a).bucket,'business');
  await reopenItem(db,q.id);
  assert.equal(resolveCategories(await loadCategoryInputs(db)).get(b).bucket,'business');
  assert.equal(resolveCategories(await loadCategoryInputs(db)).get(a).layer,'uncategorized');
  assert.deepEqual((await db.foreignKeyCheck()),[]);
  // Same dependency move is the account-merge call site; run it in a rollbackable transaction.
  db.exec('BEGIN'); await moveCategoryRows(db,b,a); await db.prepare('DELETE FROM transactions WHERE id=?').run(b); db.exec('COMMIT');
  assert.equal(resolveCategories(await loadCategoryInputs(db)).get(a).bucket,'business');
});

test('AC1 missing category provider does nothing and old uncalibrated proposals are not applied', async t => {
  const {db}=await store(t); await account(db); const id=await txn(db);
  assert.equal((await guessCategories(db,{isOn:()=>false})).skipped,'provider_off');
  await db.prepare("INSERT INTO transaction_category_guesses VALUES (?,'Business','unmeasured',?)").run(id,'2032-01-01');
  assert.equal(resolveCategories(await loadCategoryInputs(db)).get(id).layer,'uncategorized');
});

test('AC3 only explicit checkbox can produce an always option; engine and best guess reject hidden options', async t => {
  const {db}=await store(t); await account(db); await history(db); await txn(db); await queueCategoryChecks(db,{clock});
  const item=(await pendingItems(db)).find(i=>i.kind==='transaction_category');
  const options=visibleOptions(item);
  assert.ok(options.every(o=>!o.id.startsWith('always:')));
  assert.equal(categoryAnswerOption(item,options[1].id,false),options[1].id);
  assert.equal(categoryAnswerOption(item,options[1].id,true),'always:'+options[1].id);
  assert.equal(categoryAnswerOption(item,'always:Business',false),null);
  assert.deepEqual(validateGuesses([item],{guesses:[{item:item.id,option:'always:Business',basis:'question'}]}),[]);
  await db.prepare("INSERT INTO confirm_guesses VALUES (?,'always:Business','question','synthetic',?)").run(item.id,'2032-06-10');
  const g=await bestGuess(db,item,{});
  assert.ok(!g || !g.option.startsWith('always:'));
});

test('AC5 coverage CLI uses platform readiness and emits only counts; architecture documents source tables', async t => {
  const {db,dir,householdId}=await store(t); await account(db); await txn(db);
  const coverage=await categoryCoverage(db,{clock}); assert.equal(coverage.uncategorized,1);
  const env={...process.env,FATHOM_DATA:dir};
  const unnamed=spawnSync(process.execPath,['scripts/category-coverage.mjs'],{encoding:'utf8',env});
  assert.equal(unnamed.status,1); assert.equal(unnamed.stdout,''); assert.equal(unnamed.stderr.trim(),'household_required');
  const out=spawnSync(process.execPath,['scripts/category-coverage.mjs','--household',householdId],{encoding:'utf8',env});
  assert.equal(out.status,0,out.stderr);
  const counts=JSON.parse(out.stdout); assert.equal(counts.uncategorized,1);
  assert.ok(!out.stdout.includes('Example'));
  assert.ok(Object.values(counts.layers).every(Number.isInteger));
  assert.match(readFileSync('docs/architecture.md','utf8'),/CATEGORY_TABLES/);
});

test('AC1 migration preserves a populated store and existing Confirm undo history', async t => {
  const {db}=await store(t); await account(db); await history(db);
  const q=await ask(db,{kind:'account_owner',subject:'checking',question:'Whose account?',options:[{id:'owner',label:'You'},{id:'spouse',label:'Spouse'}]});
  await answerItem(db,q.id,'owner');
  const before=(await db.prepare('SELECT changes FROM confirm_undo WHERE item_id=?').get(q.id)).changes;
  const count=(await db.prepare('SELECT count(*) AS n FROM transactions').get()).n;
  for(const table of ['transaction_category_imports','transaction_category_corrections','transaction_category_guesses','category_merchant_rules','category_source_rules']) await db.applySchema(`DROP TABLE ${table}`);
  await db.prepare('DELETE FROM schema_migrations WHERE id=23').run();
  const {migrate}=await import('../src/store/db.mjs');
  assert.deepEqual((await migrate(db)).applied,[23]);
  assert.equal((await db.prepare('SELECT changes FROM confirm_undo WHERE item_id=?').get(q.id)).changes,before);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM transactions').get()).n,count);
  await reopenItem(db,q.id);
  assert.equal((await db.prepare('SELECT owner FROM accounts WHERE id=?').get('checking')).owner,null);
});

test('AC2 a corrected connected row survives the actual account merge and Undo', async t => {
  const {realStore}=await import('./helpers/ingest.mjs');
  const {seedDuplicate}=await import('./helpers/account-merge.mjs');
  const {queueAccountPairs}=await import('../src/ingest/account-merge.mjs');
  const s=await realStore(); t.after(()=>s.close());
  const {own,keep}=await seedDuplicate(s,{sure:true});
  const r=await s.db.prepare('SELECT id FROM transactions WHERE account_id=?').get(own);
  await s.db.prepare("INSERT INTO transaction_category_corrections VALUES (?,'Business','business',?)").run(r.id,'2032-03-10');
  await queueAccountPairs(s.db);
  const q=(await pendingItems(s.db)).find(i=>i.kind==='account_match' && i.context?.repair);
  assert.ok(q);
  await answerItem(s.db,q.id,'same');
  const survivor=await s.db.prepare('SELECT id FROM transactions WHERE account_id=? AND amount=-10').get(keep);
  assert.equal(resolveCategories(await loadCategoryInputs(s.db)).get(survivor.id).bucket,'business');
  await reopenItem(s.db,q.id);
  assert.equal(resolveCategories(await loadCategoryInputs(s.db)).get(r.id).bucket,'business');
  assert.deepEqual((await s.db.foreignKeyCheck()),[]);
});


test('AC7 source-name mapping is parser-specific, retains unknown names, and covers every matching row', () => {
  const transactions=[row(1,{parser:'future-budget',category:'Custom label'}),row(2,{parser:'future-budget',category:'Custom label'}),row(3,{parser:'other-budget',category:'Custom label'})];
  const c=resolve(transactions,{sourceRules:[{parser:'future-budget',category:'Custom label',bucket:'business'}]});
  assert.equal(c.get(1).category,'Custom label'); assert.equal(c.get(2).bucket,'business');
  assert.equal(c.get(1).layer,'correction'); assert.equal(c.get(3).layer,'uncategorized');
  assert.match(readFileSync('docs/architecture.md','utf8'),/CATEGORY_TABLES/);
});


test('AC1 a shared bank name never makes mortgage payments card transfers', () => {
  const shared=[{id:'checking',kind:'checking',inst:'Example Bank',name:'Daily checking'},
    {id:'card',kind:'card',inst:'Example Bank',name:'Rewards',mask:'5678'},
    {id:'loan',kind:'loan',inst:'Example Bank',name:'Mortgage'}];
  const transactions=[row(1,{description:'ONLINE PAYMENT Example Bank MORTGAGE'}),
    row(2,{description:'ONLINE PAYMENT Example Bank 5678'}),row(3,{description:'ONLINE PAYMENT Rewards'})];
  const c=resolveCategories({accounts:shared,transactions});
  assert.equal(c.get(1).layer,'uncategorized'); assert.equal(c.get(1).bucket,'household');
  assert.equal(c.get(2).bucket,'transfer'); assert.equal(c.get(3).bucket,'transfer');
});

test('AC3 queue uses the same in-window transfer priority as the spending figure', async t => {
  const {db}=await store(t); await account(db); await account(db,'broker','taxable'); await history(db);
  await txn(db,{date:'2032-01-31',amount:-1000,description:'Partial-month posting'});
  const transfer=await txn(db,{date:'2032-02-02',amount:-1000,description:'Current-window transfer'});
  await txn(db,{date:'2032-02-02',amount:1000,account_id:'broker',description:'Transfer received'});
  assert.ok(!(await spend(db)).spendIds.includes(transfer));
  await queueCategoryChecks(db,{clock});
  assert.ok(!(await pendingItems(db)).some(i=>i.kind==='transaction_category' && i.context.transactionId===transfer));
});
