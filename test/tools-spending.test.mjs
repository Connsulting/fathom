import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDemo } from '../demo/seed.mjs';
import { tempDb } from './helpers/server.mjs';
import { spendingStore, custom } from './helpers/spending.mjs';
import { spendingInputs } from '../src/calc/targets.mjs';
import { loadCategoryInputs } from '../src/categories/store.mjs';
import { resolveCategories } from '../src/categories/resolve.mjs';
import { classOf, BUILTIN_DEFINITIONS } from '../src/calc/classes.mjs';
import { callTool } from '../src/tools/index.mjs';
import { assertRefsResolve } from './helpers/figures.mjs';

const sum = xs => Math.round(xs.reduce((s,x) => s+x,0)*100)/100;

test('total shares the exact demo and real card spending window selection', async t => {
  const real = await spendingStore(t), demo = await tempDb();
  t.after(() => demo.close()); seedDemo(demo.db);
  for (const ctx of [real.ctx, { db: demo.db, dataDir: demo.dataDir, clock: '2026-11-05' }]) {
    const sp = spendingInputs({ ...loadCategoryInputs(ctx.db), clock: ctx.clock });
    const r = await callTool('spending', { operation: 'total', measure: 'spending' }, ctx);
    assert.equal(r.total.value, sp.spendTotal);
    assert.deepEqual(r.window, sp.window);
    await assertRefsResolve(r, ctx);
  }
});

test('Q01 excludes matched mortgage and tax amounts and essential sums five classes', async t => {
  const s = await spendingStore(t);
  const args = { ...custom, groupBy: 'class', exclude: { classes: ['debt_service'], buckets: ['tax'] } };
  const r = await s.call('total', args);
  const input = loadCategoryInputs(s.db), resolved = resolveCategories(input);
  const rows = input.transactions.filter(x => x.date >= '2026-03' && x.date < '2026-06' && x.amount < 0);
  const want = -sum(rows.filter(x => resolved.get(x.id).bucket === 'household' && classOf(resolved.get(x.id).category, resolved.get(x.id).bucket) !== 'debt_service').map(x=>x.amount));
  assert.equal(r.total.value,want);
  assert.equal(r.excluded.find(x=>x.selector.value==='debt_service').matched.value,900);
  assert.equal(r.excluded.find(x=>x.selector.value==='tax').matched.value,180);
  assert.equal(r.excluded.find(x=>x.selector.value==='tax').removed.value,0);
  assert.equal(sum(r.groups.map(x=>x.figure.value)),r.total.value);
  assert.ok(r.groups.some(x=>x.key==='healthcare'));
  const essential = await s.call('total', { ...custom, definition:'essential', groupBy:'class' });
  assert.equal(essential.total.value,1350);
  assert.equal(sum(essential.groups.map(x=>x.figure.value)), essential.total.value);
  for (const key of ['housing','childcare']) {
    s.tx('checking','2026-04-12',-10,key==='housing'?'Home & Garden':'Childcare',key);
  }
  const five = await s.call('total',{...custom,definition:'essential',groupBy:'class'});
  assert.equal(five.groups.length,5);
  await assertRefsResolve(r,s.ctx);
});

test('uncertain rows, silent cards, unclassified categories and healthcare outside ledger are measured gaps', async t => {
  const s = await spendingStore(t);
  const id = s.tx('card','2026-04-12',-17,null,'Unknown example');
  const guess = s.tx('card','2026-04-13',-23,null,'Guessed example');
  s.db.prepare("INSERT INTO transaction_category_corrections(transaction_id,category,bucket,updated_at) VALUES (?,'Shopping','household','2026-04-13')").run(guess);
  s.db.prepare("INSERT INTO confirm_items(kind,subject,question,status,created_at,updated_at) VALUES ('transaction_category',?,'Category?','pending','2026-04-13','2026-04-13')").run(String(guess));
  const item = s.db.prepare('SELECT id FROM confirm_items WHERE subject=?').get(String(guess)).id;
  s.db.prepare("INSERT INTO confirm_auto(item_id,rule,evidence,at) VALUES (?,'jev_category','{}','2026-04-13')").run(item);
  s.fact('income.w2',true);
  const r = await s.call('total',custom);
  const gap = code => r.gaps.find(g=>g.code===code);
  assert.equal(gap('uncategorized_rows').amount,17); assert.equal(gap('uncategorized_rows').count,1);
  assert.equal(gap('guessed_rows').amount,23); assert.equal(gap('guessed_rows').count,1);
  assert.equal(gap('account_no_history').count,1);
  assert.ok(gap('outside_household_ledger')); assert.ok(gap('unclassified_category'));
  assert.ok(r.total.provenance.sources.some(x=>x.ids.includes(id)));
});

test('periods, all measures and scopes, selectors, definitions, annualizing and other are consistent', async t => {
  const s = await spendingStore(t);
  s.tx('business','2026-04-10',-25,'Business','Business cost');
  s.tx('business','2026-04-11',100,'Income','Business revenue');
  for (const args of [{}, {window:'trailing_12'}, {window:'ytd'}, {window:'calendar_year',year:2026}, {window:'custom',...custom}, custom]) {
    const r = await s.call('total',args); assert.ok(r.window.months>0 && r.window.months<=120);
  }
  for (const args of [{window:'custom'}, {window:'calendar_year'}, {from:'2026-13',to:'2026-14'}, {from:'2026-05',to:'2026-01'}, {from:'2000-01',to:'2026-01'}, {window:'ytd',year:2025}]) await assert.rejects(s.call('total',args),e=>e.code==='bad_input');
  for (const scope of ['household','business','all']) for (const measure of ['spending','income','outflow','inflow','net']) {
    const r = await s.call('total',{...custom,scope,measure,groupBy:'bucket'});
    assert.equal(sum(r.groups.map(x=>x.figure.value)),r.total.value);
  }
  assert.equal((await s.call('total',{...custom,scope:'business'})).total.value,25);
  for (const [field,value] of [['buckets','household'],['categories','Groceries'],['classes','essential_other'],['accounts','checking'],['merchants','market']]) {
    const r = await s.call('total',{...custom,include:{[field]:[value]}}); assert.ok(r.total.value>0);
    const ex = await s.call('total',{...custom,exclude:{[field]:[value]}}); assert.ok(ex.total.value<1470);
  }
  const intersect = await s.call('total',{...custom,include:{accounts:['card'],categories:['Groceries']}}); assert.equal(intersect.total.value,0);
  const override = await s.call('total',{...custom,definition:'essential',include:{classes:['discretionary']}});
  assert.equal(override.total.value,120); assert.ok(override.notes.length);
  const excludedOverride = await s.call('total',{...custom,definition:'core_living',exclude:{classes:['healthcare']}});
  assert.ok(excludedOverride.notes.length); assert.equal(excludedOverride.excluded.some(x=>x.selector.value==='debt_service'),false);
  const defs = await s.call('definitions'); assert.deepEqual(defs.map(x=>x.id).sort(),Object.keys(BUILTIN_DEFINITIONS).sort());
  await assert.rejects(s.call('total',{definition:'missing'}),e=>e.code==='bad_input');
  const r = await s.call('total',{...custom,groupBy:'category',limit:1}); assert.equal(r.groups.length,1); assert.ok(r.other); assert.equal(sum([...r.groups.map(x=>x.figure.value),r.other.value]),r.total.value);
  for (const groupBy of ['none','bucket','category','class','merchant','account','month']) assert.ok((await s.call('total',{...custom,groupBy})).total);
  const annual = await s.call('total',{...custom,annualize:true}); assert.equal(annual.total.value,5880); assert.equal(annual.total.unit,'usd_per_year'); assert.equal(annual.perMonth.value,490);
});

test('compare uses two totals and folds their group union with unequal-period gaps', async t => {
  const s = await spendingStore(t), a={from:'2026-03',to:'2026-03'},b=custom;
  const r = await s.call('compare',{a,b,groupBy:'category',limit:1});
  const ra = await s.call('total',a),rb=await s.call('total',b);
  assert.equal(r.difference.value,rb.total.value-ra.total.value); assert.equal(r.ratio.value,3);
  assert.ok(r.gaps.some(g=>g.code==='unequal_periods'));
  assert.equal(sum(r.groups.map(x=>x.difference.value)),r.difference.value);
  await assertRefsResolve(r,s.ctx);
  const zero=await s.call('compare',{a:{from:'2025-01',to:'2025-02'},b}); assert.equal(zero.ratio,undefined);
});
