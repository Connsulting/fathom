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
import { ingestFile } from '../src/ingest/pipeline.mjs';
import { bestGuess } from '../src/ingest/bestguess.mjs';
import { validateGuesses } from '../src/ingest/guess.mjs';
import { aggregatorFile } from './helpers/ingest.mjs';
import { spendingInputs, spendingFigures } from '../src/calc/targets.mjs';
import { visibleOptions, categoryAnswerOption } from '../web/horizon/screens/ingest.js';

const clock = '2032-11-05';
const accounts = [{ id: 'checking', kind: 'checking', inst: 'Example Bank' }, { id: 'saving', kind: 'savings' },
  { id: 'card', kind: 'card', inst: 'Example Card', mask: '5678' }, { id: 'biz', kind: 'business' }];
const row = (id, patch = {}) => ({ id, account_id: 'checking', date: '2032-06-10', amount: -250, description: 'Example Shop', ...patch });
const resolve = (transactions, extra = {}) => resolveCategories({ transactions, accounts, ...extra });
function store(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fathom-category-'));
  const s = createInstance(dir, { mode: 'real' });
  setSetting(s.db, 'clock', clock);
  t.after(() => { s.db.close(); s.platform.close(); rmSync(dir, { recursive: true, force: true }); });
  return { ...s, dir };
}
function account(db, id = 'checking', kind = 'checking') {
  db.prepare("INSERT INTO accounts (id,kind,inst,mask,name,display_name,identity) VALUES (?,?, 'Example Bank','1111','Synthetic checking','Everyday account',?)").run(id, kind, 'examplebank|mask:' + id);
}
function txn(db, patch = {}) {
  const r = row(0, patch);
  const q = db.prepare('INSERT INTO transactions (account_id,date,amount,description,category,parser,dedupe_key,external_id) VALUES (?,?,?,?,?,?,?,?)')
    .run(r.account_id, r.date, r.amount, r.description, r.category ?? null, r.parser ?? 'simplefin', r.dedupe_key ?? null, r.external_id ?? null);
  return Number(q.lastInsertRowid);
}
function history(db) {
  for (let m = 1; m <= 8; m++) for (const amount of [-100, 3000]) txn(db, { date: `2032-${String(m).padStart(2, '0')}-15`, amount, description: amount < 0 ? 'Household item' : 'Earned deposit', category: amount < 0 ? 'Groceries' : 'Income', parser: 'aggregator' });
}
const spend = db => { const input = loadCategoryInputs(db); return spendingInputs({ ...input, clock }); };

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
  const transactions = [row(1, { category: 'Business', parser: 'aggregator' }), row(2, { date: '2032-06-12' })];
  const all = { corrections: [{ transaction_id: 2, category: 'Groceries', bucket: 'household' }], merchantRules: [{ merchant: 'example shop', category: 'Taxes', bucket: 'tax' }], guesses: [{ transaction_id: 2, category: 'Investment' }] };
  assert.equal(resolve(transactions, all).get(2).category, 'Groceries');
  assert.equal(resolve(transactions, { ...all, corrections: [] }).get(2).bucket, 'tax');
  assert.equal(resolve(transactions).get(1).layer, 'import');
  assert.equal(resolve(transactions).get(2).layer, 'merchant');
  assert.equal(resolve(transactions).get(2).bucket, 'business');
  assert.equal(resolve([row(1),row(2)], { guesses: [{ transaction_id: 1, category: 'Taxes' }] }).get(2).layer, 'uncategorized');
  assert.equal(resolve([row(1)], { guesses: [{ transaction_id: 1, category: 'Taxes' }] }).get(1).layer, 'guess');
});

test('AC1 normalizes feed merchant descriptions and picks most recently supplied category', () => {
  assert.equal(normalizeMerchant('POS DEBIT SQ *Example Shop #0042 06/10'), normalizeMerchant('Example Shop'));
  assert.notEqual(normalizeMerchant('Shop 7Eleven'), normalizeMerchant('Shop Eleven'));
  const a = row(1, { category: 'Groceries', parser: 'aggregator', date: '2032-03-01', category_at: '2032-08-01' });
  const b = row(2, { category: 'Business', parser: 'aggregator', date: '2032-04-01', category_at: '2032-07-01' });
  assert.equal(resolve([a,b,row(3, { description: 'POS DEBIT Example Shop #0099' })]).get(3).category, 'Groceries');
});

test('AC1 structural layer recognizes both card-payment sides, preserves draws and loses to imports', () => {
  const r = resolve([row(1,{description:'AUTOPAY Example Card 5678'}),row(2,{account_id:'card',amount:250,description:'PAYMENT THANK YOU'}),
    row(3,{account_id:'biz',amount:-900}),row(4,{amount:900}),row(5,{category:'Groceries',parser:'aggregator',description:'AUTOPAY Example Card 5678'}),row(6,{description:'Payment Unknown Lender'})]);
  assert.equal(r.get(1).bucket,'transfer'); assert.equal(r.get(2).bucket,'transfer');
  assert.equal(r.get(4).bucket,'income'); assert.equal(r.get(4).layer,'uncategorized');
  assert.equal(r.get(5).bucket,'household'); assert.equal(r.get(6).layer,'uncategorized');
});

test('AC4 store path gives in-window household transfers first claim over business/pre-window rows', t => {
  const {db} = store(t); account(db); account(db,'biz','business'); account(db,'broker','taxable'); history(db);
  txn(db,{ account_id:'biz',date:'2032-06-08',amount:-1000 });
  txn(db,{ account_id:'broker',date:'2032-06-08',amount:-1000 });
  txn(db,{ date:'2032-06-10',amount:-1000 });
  txn(db,{ account_id:'broker',date:'2032-06-10',amount:1000 });
  assert.equal(spend(db).spendTotal,600);
});

test('AC4 bucket filtering and retained uncertainty note change real spending figures', t => {
  const {db} = store(t); account(db); history(db);
  for (const category of ['Business','Credit Card Payment','Internal Transfers','Savings Transfer','Ignore','Taxes','Investment','HSA','Mortgage Principal']) txn(db,{category,parser:'aggregator',amount:-500});
  txn(db,{amount:-275,description:'Unresolved service'});
  const sp=spend(db); assert.equal(sp.spendTotal,875);
  const f=spendingFigures(sp,{clock}).monthlySpend;
  assert.equal(f.locator.inputs.uncategorizedSpend,275);
  assert.ok(f.notes.some(n=>n.includes('275.00') && n.includes('Uncategorized')));
  assert.match(f.locator.steps[0].formula,/household/);
});

test('AC3 amount threshold/top ten, one source-name mapping, rules past/future and undo', t => {
  const {db} = store(t); account(db); history(db);
  for(let i=0;i<12;i++) txn(db,{amount:-(100+i),description:'Merchant '+String.fromCharCode(65+i)});
  txn(db,{amount:-99,description:'Below threshold'});
  queueCategoryChecks(db,{clock});
  let pending=pendingItems(db).filter(i=>i.kind==='transaction_category');
  assert.equal(pending.length,10);
  assert.equal(pending[0].context.amount,-111);
  const item=pending[0]; const before=spend(db).spendTotal;
  answerItem(db,item.id,'always:Business');
  assert.equal(spend(db).spendTotal,before-111);
  txn(db,{amount:-200,description:item.context.description,date:'2032-06-11'});
  assert.equal(resolveCategories(loadCategoryInputs(db)).get(db.prepare('SELECT max(id) AS id FROM transactions').get().id).bucket,'business');
  reopenItem(db,item.id);
  assert.equal(spend(db).spendTotal,before+200);
  txn(db,{category:'New category',parser:'another-app',amount:-50});
  txn(db,{category:'New category',parser:'another-app',amount:-500});
  queueCategoryChecks(db,{clock});
  const maps=pendingItems(db).filter(i=>i.kind==='category_mapping');
  assert.equal(maps.length,1);
  answerItem(db,maps[0].id,'tax');
  assert.equal([...resolveCategories(loadCategoryInputs(db)).values()].filter(c=>c.category==='New category' && c.bucket==='tax').length,2);
  reopenItem(db,maps[0].id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM category_source_rules').get().n,0);
});

test('AC2 live-row enrichment keeps one posting, parser provenance, replay and ambiguous rows', async t => {
  const {db,dir}=store(t); account(db);
  db.prepare("UPDATE accounts SET identity='examplebank|mask:1111' WHERE id='checking'").run();
  const id=txn(db,{date:'2032-06-10',amount:-250,description:'POS DEBIT Example Shop',dedupe_key:'live:one',external_id:'live-one'});
  const file=aggregatorFile('export.csv',[{date:'2032-06-12',amount:250,description:'Example Shop',category:'Business'}]);
  const opts={dataDir:dir,key:Buffer.alloc(32,7),now:'2032-08-01T12:00:00Z'};
  assert.equal((await ingestFile(db,file,opts)).status,'imported');
  assert.equal(db.prepare('SELECT count(*) AS n FROM transactions').get().n,1);
  const c=resolveCategories(loadCategoryInputs(db)).get(id);
  assert.equal(c.bucket,'business'); assert.equal(c.evidence.parser,'aggregator');
  const overlap=aggregatorFile('overlap.csv',[{date:'2032-06-12',amount:250,description:'Example Shop',category:'Business'}, {date:'2032-06-13',amount:12,description:'Other Merchant',category:'Groceries'}]);
  await ingestFile(db,overlap,opts);
  assert.equal(db.prepare('SELECT count(*) AS n FROM transactions WHERE amount=-250').get().n,1);
  txn(db,{date:'2032-07-10',amount:-400,description:'POS Example Shop',dedupe_key:'live:two'});
  txn(db,{date:'2032-07-10',amount:-400,description:'POS Example Shop',dedupe_key:'live:three'});
  await ingestFile(db,aggregatorFile('ambiguous.csv',[{date:'2032-07-11',amount:400,description:'Example Shop',category:'Business'}]),opts);
  assert.equal(db.prepare('SELECT count(*) AS n FROM transactions WHERE amount=-400').get().n,3);
  assert.ok(pendingItems(db).some(i=>i.kind==='near_duplicate'));
});

test('AC2 corrections survive duplicate consolidation and its undo without cascades', t => {
  const {db}=store(t); account(db);
  const a=txn(db,{dedupe_key:'a'}), b=txn(db,{dedupe_key:'b'});
  db.prepare("INSERT INTO transaction_category_corrections VALUES (?,'Business','business',?)").run(b,'2032-08-01');
  const q=ask(db,{kind:'near_duplicate',subject:'a|b',question:'Same?',options:[{id:'same',label:'Same'},{id:'different',label:'Different'}],context:{keys:['a','b']}});
  answerItem(db,q.id,'same');
  assert.equal(resolveCategories(loadCategoryInputs(db)).get(a).bucket,'business');
  reopenItem(db,q.id);
  assert.equal(resolveCategories(loadCategoryInputs(db)).get(b).bucket,'business');
  assert.equal(resolveCategories(loadCategoryInputs(db)).get(a).layer,'uncategorized');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  // Same dependency move is the account-merge call site; run it in a rollbackable transaction.
  db.exec('BEGIN'); moveCategoryRows(db,b,a); db.prepare('DELETE FROM transactions WHERE id=?').run(b); db.exec('COMMIT');
  assert.equal(resolveCategories(loadCategoryInputs(db)).get(a).bucket,'business');
});

test('AC1 engine off does nothing; valid category guesses are stored but invalid ids/names are rejected', async t => {
  const {db}=store(t); account(db); const id=txn(db);
  assert.equal((await guessCategories(db,{isOn:()=>false})).skipped,'engine_off');
  let request;
  const engine={isOn:()=>true,mode:'live',call:async q=>{request=q;return {text:JSON.stringify({categories:[{id,category:'Business'},{id:99999,category:'Taxes'},{id,category:'invented'}]}),model:'synthetic',costUsd:0};}};
  await guessCategories(db,engine);
  assert.equal(resolveCategories(loadCategoryInputs(db)).get(id).layer,'guess');
  assert.equal(resolveCategories(loadCategoryInputs(db)).get(id).bucket,'business');
  assert.ok(!JSON.stringify(request).includes('always:'));
});

test('AC3 only explicit checkbox can produce an always option; engine and best guess reject hidden options', t => {
  const {db}=store(t); account(db); txn(db); queueCategoryChecks(db,{clock});
  const item=pendingItems(db).find(i=>i.kind==='transaction_category');
  const options=visibleOptions(item);
  assert.ok(options.every(o=>!o.id.startsWith('always:')));
  assert.equal(categoryAnswerOption(item,options[1].id,false),options[1].id);
  assert.equal(categoryAnswerOption(item,options[1].id,true),'always:'+options[1].id);
  assert.equal(categoryAnswerOption(item,'always:Business',false),null);
  assert.deepEqual(validateGuesses([item],{guesses:[{item:item.id,option:'always:Business',basis:'question'}]}),[]);
  db.prepare("INSERT INTO confirm_guesses VALUES (?,'always:Business','question','synthetic',?)").run(item.id,'2032-06-10');
  const g=bestGuess(db,item,{});
  assert.ok(!g || !g.option.startsWith('always:'));
});

test('AC5 coverage CLI uses platform readiness and emits only counts; architecture documents source tables', t => {
  const {db,dir}=store(t); account(db); txn(db);
  const coverage=categoryCoverage(db,{clock}); assert.equal(coverage.uncategorized,1);
  const out=spawnSync(process.execPath,['scripts/category-coverage.mjs',dir],{encoding:'utf8'});
  assert.equal(out.status,0,out.stderr);
  const counts=JSON.parse(out.stdout); assert.equal(counts.uncategorized,1);
  assert.ok(!out.stdout.includes('Example'));
  assert.ok(Object.values(counts.layers).every(Number.isInteger));
  assert.match(readFileSync('docs/architecture.md','utf8'),/CATEGORY_TABLES/);
});
