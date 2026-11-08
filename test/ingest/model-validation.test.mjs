import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, recipe } from '../helpers/model-import.mjs';
import { resolveField } from '../../src/ingest/model-source.mjs';
import { applyLayout } from '../../src/ingest/model-layout.mjs';
import { validateImport } from '../../src/ingest/model-validation.mjs';

test('validation derives totals and duplicate counts through the actual persistence boundary without active writes', async () => {
  const x = await fixture();
  try {
    const s = await x.source(), p = applyLayout(s, recipe());
    const v = await validateImport(x.ctx, p, s);
    assert.equal(v.valid, true, JSON.stringify(v.errors));
    assert.equal(v.summary.totalStatus, 'totals_match');
    assert.equal(v.summary.rows, 2);
    assert.equal(v.summary.amount, -10);
    assert.equal(v.counts.rows.transaction, 2);
    assert.equal((await x.db.prepare('SELECT count(*) n FROM transactions').get()).n, 0);
    assert.equal((await x.db.prepare('SELECT count(*) n FROM sources').get()).n, 0);
  } finally { await x.close(); }
});

test('P&L grouping sums signed detail with every operand and its transform retained', async () => {
  const x = await fixture();
  try {
    await x.db.prepare("INSERT INTO entity_aliases (alias,entity,created_at) VALUES ('synthetic studio','Synthetic Studio','2032-03-01')").run();
    const s = await x.source('Entity,Period,Category,Amount,Basis\nSynthetic Studio,2032-03,Software,12.25,cash\nSynthetic Studio,2032-03,Software,2.25,cash\n');
    const layout = { schemaVersion: 1, currency: 'USD', tables: [{ sheet: null, headerRow: 1, target: 'pnl', attributes: { purpose: 'business' }, roles: [],
      fields: Object.fromEntries(['entity', 'period', 'category', 'amount', 'basis'].map((key, i) => [key, { columns: [i + 1],
        transform: key === 'amount' ? { op: 'sign', mode: 'negate' } : { op: 'trim' } }])) }] };
    const p = applyLayout(s, layout), original = structuredClone(p);
    const v = await validateImport(x.ctx, p, s);
    assert.equal(v.valid, true, JSON.stringify(v.errors));
    assert.equal(v.rows.length, 1); assert.equal(v.rows[0].amount, -14.5);
    assert.equal(resolveField(s, v.rows[0].locator.fields.amount), -14.5);
    assert.equal(v.rows[0].locator.derivedFrom.length, 10);
    assert.deepEqual(p, original);
  } finally { await x.close(); }
});

test('mismatch, missing regions, omitted amount refs, unknown identity and invalid dates fail closed', async () => {
  const x = await fixture();
  try {
    const s = await x.source();
    for (const change of [p => p.controls[0].rows.pop(), p => p.coverage.pop(), p => p.rows.pop(),
      p => p.rows[0].fields.accountId.refs = ['r3'], p => p.rows[0].fields.postedDate.refs = ['r2']]) {
      const p = applyLayout(s, recipe()); change(p);
      assert.equal((await validateImport(x.ctx, p, s)).valid, false);
    }
    const p = applyLayout(s, recipe());
    s.values.r6 = 'changed';
    assert.equal((await validateImport(x.ctx, p, s)).valid, false);
  } finally { await x.close(); }
});

test('a fully inventoried no-total layout says no sheet total to check', async () => {
  const x = await fixture();
  try {
    const s = await x.source('Account,Date,Amount USD,Description\naccount-synthetic,2032-03-02,-12.25,Synthetic purchase\n');
    const v = await validateImport(x.ctx, applyLayout(s, recipe()), s);
    assert.equal(v.valid, true);
    assert.equal(v.summary.totalStatus, 'no_sheet_total');
    assert.equal(v.summary.totalMessage, 'No sheet total to check');
  } finally { await x.close(); }
});

test('same account/day equal postings retain multiplicity and foreign account aliases remain unresolved', async () => {
  const x = await fixture();
  try {
    const s = await x.source('Account,Date,Amount USD,Description\naccount-synthetic,2032-03-02,-12.25,Synthetic purchase\naccount-synthetic,2032-03-02,-12.25,Synthetic purchase\n');
    const v = await validateImport(x.ctx, applyLayout(s, recipe()), s);
    assert.equal(v.valid, true);
    assert.equal(v.counts.rows.transaction, 2);
    await x.db.prepare("INSERT INTO accounts (id,name) VALUES ('account-other','Synthetic account')").run();
    const t = await x.source('Account,Date,Amount USD,Description\nSynthetic account,2032-03-02,-12.25,Synthetic purchase\n');
    assert.ok((await validateImport(x.ctx, applyLayout(t, recipe()), t)).errors.includes('account_unresolved'));
  } finally { await x.close(); }
});

test('each cited subtotal reconciles only the group selected by its source columns', async () => {
  const x = await fixture();
  try {
    const source = await x.source('Account,Date,Amount USD,Description\naccount-synthetic,2032-03-01,-3,Synthetic purchase\naccount-synthetic,2032-03-01,-3,Subtotal\naccount-synthetic,2032-04-01,-7,Synthetic purchase\naccount-synthetic,2032-04-01,-7,Subtotal\n');
    const layout = recipe(); layout.tables[0].roles = [{ column: 4, equals: 'Subtotal', disposition: 'control_total', amountColumn: 3, groupColumns: [1, 2] }];
    const p = applyLayout(source, layout), v = await validateImport(x.ctx, p, source);
    assert.equal(v.valid, true, JSON.stringify(v.errors)); assert.equal(p.controls.length, 2);
    assert.deepEqual(p.controls.map(c => c.rows), [[0], [1]]);
  } finally { await x.close(); }
});

test('model-selected rounding cannot hide contradictory control totals', async () => {
  const x = await fixture();
  try {
    const source = await x.source('Account,Date,Amount USD,Description\naccount-synthetic,2032-03-01,-3.25,Synthetic purchase\nTotal,,-3,Control total\n');
    const proposal = applyLayout(source, recipe()); proposal.controls[0].precision = 'dollar';
    assert.ok((await validateImport(x.ctx, proposal, source)).errors.includes('rounding_precision_unproven'));
  } finally { await x.close(); }
});
