// AC4 (plan feat-confirm-context, Interfaces, Fixture): the household fixture asks fewer questions.
// Measured on main (fresh real store, engine off, the three files in one ingestFiles call): 14
// pending = account_owner 7, account_kind 4, near_duplicate 3. On this branch the two exact
// cross-format duplicates and the two positions account kinds are answered by Fathom and listed
// under decided; with the household names known before the import, owners resolve from the
// source's holder names too. Every value here is synthetic.

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { src } from '../helpers/server.mjs';
import { fixture, realStore, offEngine, one, NOW } from '../helpers/ingest.mjs';

let P;
let C;
let F;
let FR;
before(async () => {
  P = await src('src/ingest/pipeline.mjs');
  C = await src('src/ingest/confirm.mjs');
  F = await src('src/store/facts.mjs');
  FR = await src('src/ingest/freshness.mjs');
});

const AGG_FILE = 'aggregator-household.csv';
const CHASE_FILE = 'Chase4455_Activity_20261031.csv';
const household = () => [AGG_FILE, CHASE_FILE, 'positions-household.csv'].map((name) => fixture(`household/${name}`, 'text/csv'));

async function withHousehold(fn, { names = false } = {}) {
  const s = await realStore();
  try {
    if (names) {
      F.upsertFact(s.db, { key: 'household.names', value: { me: 'Avery Example', spouse: 'Blair Example' }, src: 'you', asOf: NOW.slice(0, 10), confirmed: true, now: NOW });
    }
    await P.ingestFiles(s.db, household(), s.opts(await offEngine()));
    return await fn(s);
  } finally { s.close(); }
}

const acct = async (db, mask, inst) => (await one(db, "SELECT id FROM accounts WHERE mask = ? AND coalesce(inst, '') = ?", mask, inst)).id;
const byKind = (items) => items.reduce((out, i) => ({ ...out, [i.kind]: (out[i.kind] ?? 0) + 1 }), {});
const textOf = (evidence) => (typeof evidence === 'string' ? evidence : evidence?.text);

test('no names known: 12 pending including three source categories and 5 decided for the owner', async () => withHousehold(async (s) => {
  const state = FR.ingestState(s.db);
  const pending = C.pendingItems(s.db);
  assert.equal(pending.length, 12);
  assert.deepEqual(byKind(pending), { account_owner: 7, account_kind: 1, near_duplicate: 1, category_mapping: 3 });
  const kindSubjects = pending.filter((i) => i.kind === 'account_kind').map((i) => i.subject).sort();
  assert.deepEqual(kindSubjects, [await acct(s.db, '5566', 'Example Credit Union')], 'Rainy Day');

  assert.equal(state.pending, 12);
  assert.deepEqual(state.items.filter(i=>i.kind==='category_mapping').map(i=>i.context.category).sort(), ['Auto','Dining','Utilities']);
  assert.equal(state.decided.length, 5);
  const rules = state.decided.map((d) => d.rule).sort();
  assert.deepEqual(rules, ['account_name', 'cross_format_duplicate', 'cross_format_duplicate', 'shared_mask', 'shared_mask']);
  for (const d of state.decided) {
    assert.equal(typeof d.id, 'number');
    assert.equal(typeof d.question, 'string');
    assert.equal(typeof d.answerLabel, 'string');
    assert.equal(d.final, null, 'a fresh auto answer is undoable');
    const text = textOf(d.evidence);
    assert.ok(typeof text === 'string' && text.length > 0, 'decided entries carry evidence');
    if (d.rule === 'cross_format_duplicate') {
      assert.deepEqual([d.kind, d.answer], ['near_duplicate', 'same']);
      assert.ok(text.includes(AGG_FILE) && text.includes(CHASE_FILE), `names both files: ${text}`);
    } else if (d.rule === 'account_name') {
      assert.deepEqual([d.kind, d.answer], ['account_kind', 'card']);
      assert.ok(text.includes('Rewards Card'));
    } else {
      assert.deepEqual([d.kind, d.answer], ['account_kind', 'taxable']);
      const { mask } = await one(s.db, 'SELECT a.mask FROM accounts a JOIN confirm_items ci ON ci.subject = a.id WHERE ci.id = ?', d.id);
      assert.ok(text.includes(mask), `names the shared mask ${mask}: ${text}`);
    }
  }
}));

test('names known before the import: 6 pending including three source categories, the only owner question is Rainy Day', async () => withHousehold(async (s) => {
  const state = FR.ingestState(s.db);
  const pending = C.pendingItems(s.db);
  assert.equal(pending.length, 6);
  assert.deepEqual(byKind(pending), { account_owner: 1, account_kind: 1, near_duplicate: 1, category_mapping: 3 });
  const owner = pending.find((i) => i.kind === 'account_owner');
  assert.equal(owner.subject, await acct(s.db, '5566', 'Example Credit Union'), 'Rainy Day, held by both, stays a question');
  assert.equal(state.pending, 6);
}, { names: true }));
