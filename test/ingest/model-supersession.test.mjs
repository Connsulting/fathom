import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, upload, approve, transactions } from '../helpers/model-cutover.mjs';
import { recipe } from '../helpers/model-import.mjs';

test('same bytes reinterpret only replace active rows after approval and preserve history', async () => {
  const x = await setup();
  try {
    const r = await upload(x, transactions()); await approve(x, r);
    const layout = recipe(); layout.tables[0].fields.amount.transform = { op: 'sign', mode: 'negate' };
    const next = await upload(x, transactions(), layout, { reinterpret: true });
    assert.equal(next.status, 'needs_confirmation');
    assert.deepEqual((await x.db.prepare('SELECT amount FROM transactions').all()).map(r => r.amount), [-12.25, -12.25]);
    await approve(x, next);
    assert.deepEqual((await x.db.prepare('SELECT amount FROM transactions').all()).map(r => r.amount), [12.25, 12.25]);
    assert.equal((await x.db.prepare('SELECT count(*) n FROM superseded_rows').get()).n, 2);
  } finally { x.close(); }
});

import { importProposedRows } from '../helpers/import-proposal-fixture.mjs';
const pnl = (period, category, amount) => ({ target: 'pnl', purpose: 'business', fields: { entity: 'Synthetic studio', period, category, amount, basis: 'cash' } });
test('corrected overlapping files remove only complete represented groups, retain other periods, and archive revisions', async () => {
  const x = await setup();
  try {
    await x.db.prepare('INSERT INTO entity_aliases(alias,entity,created_at) VALUES (?,?,?)').run('syntheticstudio', 'Synthetic studio', x.ctx.now);
    await importProposedRows(x, [pnl('2032-02','Income',100), pnl('2032-02','Travel',-20), pnl('2032-03','Income',120)]);
    const next = await importProposedRows(x, [pnl('2032-02','Income',110),pnl('2032-03','Income',120)]);
    assert.equal(next.status, 'imported');
    assert.deepEqual((await x.db.prepare('SELECT period,category,amount FROM pnl_lines ORDER BY period,category').all()).map(r => [r.period,r.category,r.amount]), [['2032-02','Income',110],['2032-03','Income',120]]);
    assert.equal((await x.db.prepare("SELECT count(*) n FROM superseded_rows WHERE reason IN ('revised','removed')").get()).n, 2);
  } finally { x.close(); }
});

test('month-precision tax revisions retain tax year basis, recipient and full source history', async () => {
  const x = await setup();
  try {
    const payment = amount => ({ target: 'tax_payment', kind: 'estimate', status: 'paid', datePrecision: 'month', fields: {
      jurisdiction: 'federal', payer: 'Synthetic payer', recipient: 'you', amount, taxYear: 2031, taxYearBasis: 'confirmed_tax_year', paymentDate: '2032-01-31',
    } });
    const first = await importProposedRows(x,[payment(250)]);
    const second = await importProposedRows(x,[payment(275)]);
    const stored = await x.db.prepare('SELECT * FROM tax_payments').get();
    assert.equal(stored.amount,275); assert.equal(stored.tax_year,2031);
    assert.equal(stored.date_precision,'month'); assert.equal(stored.tax_year_basis,'confirmed_tax_year');
    assert.equal(stored.date,'2032-01-31'); assert.equal(stored.file_id,second.fileId);
    const archived = await x.db.prepare("SELECT * FROM superseded_rows WHERE table_name='tax_payments' AND reason='revised'").get();
    assert.equal(JSON.parse(archived.row).amount,250); assert.equal(archived.file_id,first.fileId);
  } finally { x.close(); }
});

test('position authority and omissions belong to each resolved account and date', async () => {
  const { undoAction } = await import('../../src/actions/receipts.mjs');
  const x = await setup();
  try {
    await x.db.prepare("INSERT INTO accounts(id,name,inst,kind,owner,identity) VALUES ('account-second','Second account','Example bank','cash','you','synthetic-second')").run();
    const position = (accountId,asOf,symbol,value) => ({ target: 'position', fields: { accountId,asOf,symbol,quantity: 1,value } });
    const initial = [position('account-synthetic','2032-02-01','FIRST',100),position('account-synthetic','2032-02-01','OLD',20),position('account-second','2032-03-01','OTHER',50)];
    await importProposedRows(x,initial);
    const before = await x.db.prepare('SELECT * FROM positions ORDER BY id').all();
    const next = await importProposedRows(x,[position('account-synthetic','2032-02-01','FIRST',110)]);
    assert.equal(next.status,'imported');
    assert.deepEqual((await x.db.prepare('SELECT symbol,value FROM positions ORDER BY symbol').all()).map(r => [r.symbol,r.value]), [['FIRST',110],['OTHER',50]]);
    await undoAction(x.ctx,next.receipt.id,'write:imports');
    assert.deepEqual(await x.db.prepare('SELECT * FROM positions ORDER BY id').all(),before);
  } finally { x.close(); }
});


test('reinterpretation preserves owner category corrections and posting ids by source occurrence', async () => {
  const { setTransactionCategory, loadCategoryInputs } = await import('../../src/categories/store.mjs');
  const { resolveCategories } = await import('../../src/categories/resolve.mjs');
  const x = await setup();
  try {
    await approve(x, await upload(x, transactions()));
    const ids = (await x.db.prepare('SELECT id FROM transactions ORDER BY id').all()).map(r => r.id);
    await setTransactionCategory(x.db, ids[0], 'Groceries', { now: x.ctx.now });
    await setTransactionCategory(x.db, ids[1], 'Business', { now: x.ctx.now });
    const corrections = await x.db.prepare('SELECT * FROM transaction_category_corrections ORDER BY transaction_id').all();
    const layout = recipe(); layout.tables[0].fields.amount.transform = { op: 'sign', mode: 'negate' };
    await approve(x, await upload(x, transactions(), layout, { reinterpret: true }));
    assert.deepEqual((await x.db.prepare('SELECT id,amount FROM transactions ORDER BY id').all()).map(r => [r.id,r.amount]), ids.map(id => [id,12.25]));
    assert.deepEqual(await x.db.prepare('SELECT * FROM transaction_category_corrections ORDER BY transaction_id').all(), corrections);
    const resolved = resolveCategories(await loadCategoryInputs(x.db));
    assert.deepEqual(ids.map(id => resolved.get(id).category), ['Groceries','Business']);
  } finally { x.close(); }
});

test('older model exports cannot overwrite or remove newer P&L groups', async () => {
  const x = await setup();
  try {
    await x.db.prepare('INSERT INTO entity_aliases VALUES (?,?,?)').run('syntheticstudio','Synthetic studio',x.ctx.now);
    await importProposedRows(x,[pnl('2032-02','Income',200),pnl('2032-02','Software',-10),pnl('2032-12','Income',200)]);
    const before = await x.db.prepare('SELECT * FROM pnl_lines ORDER BY id').all();
    await importProposedRows(x,[pnl('2032-02','Income',100),pnl('2032-02','Travel',-5),pnl('2032-03','Income',100)]);
    assert.deepEqual(await x.db.prepare("SELECT * FROM pnl_lines WHERE period='2032-02' ORDER BY id").all(),before.filter(r => r.period==='2032-02'));
  } finally { x.close(); }
});

test('newer model exports revise and recategorize historical P&L and tax groups without rewriting other months', async () => {
  const { seedHistoricalRows } = await import('../helpers/historical-import.mjs');
  const x = await setup();
  const payment = (payer,amount,date) => ({ target:'tax_payment',kind:'estimate',status:'paid',datePrecision:'month',fields:{jurisdiction:'federal',payer,recipient:'you',amount,taxYear:2032,taxYearBasis:'confirmed_tax_year',paymentDate:date} });
  try {
    await x.db.prepare('INSERT INTO entity_aliases VALUES (?,?,?)').run('syntheticstudio','Synthetic studio',x.ctx.now);
    const old = await seedHistoricalRows(x,{ name:'historical.xlsx',bytes:Buffer.from('Synthetic historical source') },[
      {kind:'pnl_line',entity:'Synthetic studio',period:'2032-09',category:'Travel',amount:-20,locator:{sheet:'Business',cells:['C2']}},
      {kind:'pnl_line',entity:'Synthetic studio',period:'2032-08',category:'Income',amount:50,locator:{sheet:'Business',cells:['C3']}},
      {kind:'tax_payment',jurisdiction:'federal',payer:'Synthetic payer',sheetYear:2032,taxYear:2032,date:'2032-09-30',datePrecision:'month',taxYearBasis:'confirmed_tax_year',paymentKind:'paid',amount:100,locator:{sheet:'Taxes',cell:'C2'}},
    ],{parser:'historical',period:{from:'2032-01-01',to:'2032-10-31'}});
    await x.db.prepare('UPDATE files SET coverage=? WHERE id=?').run(JSON.stringify(['pnl:syntheticstudio:2032','tax:2032:federal:syntheticpayer']),old.fileId);
    await importProposedRows(x,[pnl('2032-09','Software',-25),pnl('2032-11','Income',150),payment('Synthetic payer',120,'2032-09-30'),payment('Synthetic payer',10,'2032-11-30')]);
    assert.deepEqual((await x.db.prepare('SELECT period,category,amount FROM pnl_lines ORDER BY period,category').all()).map(r=>[r.period,r.category,r.amount]),[['2032-08','Income',50],['2032-09','Software',-25],['2032-11','Income',150]]);
    assert.equal((await x.db.prepare("SELECT amount FROM tax_payments WHERE date='2032-09-30'").get()).amount,120);
    assert.ok((await x.db.prepare("SELECT count(*) n FROM superseded_rows WHERE file_id=?").get(old.fileId)).n>=2);
  } finally { x.close(); }
});


test('an unchanged observation advances authority using source coverage rather than upload time', async () => {
  const x = await setup();
  try {
    await x.db.prepare('INSERT INTO entity_aliases VALUES (?,?,?)').run('syntheticstudio','Synthetic studio',x.ctx.now);
    await importProposedRows(x,[pnl('2032-02','Income',100),pnl('2032-03','Income',100)]);
    await importProposedRows(x,[pnl('2032-02','Income',100),pnl('2032-12','Income',100)]);
    await importProposedRows(x,[pnl('2032-02','Income',50),pnl('2032-04','Income',100)]);
    assert.equal((await x.db.prepare("SELECT amount FROM pnl_lines WHERE period='2032-02'").get()).amount,100);
  } finally { x.close(); }
});


test('reinterpretation cannot discard a source occurrence with an owner correction', async () => {
  const { setTransactionCategory } = await import('../../src/categories/store.mjs');
  const x = await setup();
  try {
    await approve(x,await upload(x,transactions()));
    const last = (await x.db.prepare('SELECT max(id) id FROM transactions').get()).id;
    await setTransactionCategory(x.db,last,'Groceries',{now:x.ctx.now});
    const before = await x.db.prepare('SELECT * FROM transactions ORDER BY id').all();
    const staged = await upload(x,transactions(),recipe(),{reinterpret:true,change:proposal=>{
      proposal.rows.pop();
      const region = proposal.coverage.at(-1);
      region.disposition='excluded'; region.reason={refs:[region.refs.at(-1)],transform:{op:'identity'}};
    }});
    assert.equal(staged.status,'needs_clarification');
    assert.deepEqual(await x.db.prepare('SELECT * FROM transactions ORDER BY id').all(),before);
    assert.equal((await x.db.prepare('SELECT category FROM transaction_category_corrections WHERE transaction_id=?').get(last)).category,'Groceries');
  } finally { x.close(); }
});
