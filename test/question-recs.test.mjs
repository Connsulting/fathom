import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIRM_TASKS, ANSWER_SHAPES, questionFor } from '../src/jobs/triggers/common.mjs';
import { triggers, evaluateTriggers } from '../src/jobs/triggers/index.mjs';

const accounts = [{ id: 'stable-college', kind: '529', name: 'manual', mask: '7939', display_name: 'College fund' }];

test('every confirm task has a declared, usable answer shape', () => {
  for (const key of Object.keys(CONFIRM_TASKS)) {
    assert.ok(ANSWER_SHAPES[key], key);
    const q = questionFor([key], { accounts, facts: {}, names: {} });
    assert.ok(q.fields.length, key);
    for (const f of q.fields) assert.ok(['boolean', 'number', 'date', 'choice', 'account'].includes(f.type), key);
  }
  assert.throws(() => questionFor(['unknown.key'], { accounts, facts: {} }), /answer shape/i);
});

test('an emitted key without an answer shape fails through the trigger catalog', () => {
  assert.throws(() => evaluateTriggers({ clock: '2026-11-05', year: 2026, facts: { 'benefits.hsa': true }, owner: {}, fig: {}, names: {}, data: { accounts }, packs: [], packStatus: {}, warnings: [], freshness: [], info: { blocked: [], confirm: { hsa: ['unknown.key'] } } }), /answer shape/i);
});

test('Virginia questions name display labels and use stable account ids', () => {
  const q = questionFor(['accounts.va529'], { accounts, facts: {} });
  assert.match(q.title, /College fund/);
  assert.match(q.fields[0].label, /Is College fund a Virginia plan\?/);
  assert.deepEqual(q.fields[0].path, ['stable-college', 'virginiaPlan']);
  assert.equal(q.fields[2].unit, 'USD');
  const no = questionFor(['accounts.va529'], { accounts, facts: { 'accounts.va529': { 'stable-college': { virginiaPlan: false } } } });
  assert.equal(no.fields[0].value, false);
});

test('trigger question branches carry controls and never a manual replan step', () => {
  const ctx = { clock: '2026-11-05', year: 2026, facts: { 'accounts.has529': true, 'household.state': 'VA', 'household.expectingChild': true }, owner: {}, fig: {}, names: {}, data: { accounts }, packs: [], packStatus: {}, warnings: [], freshness: [], info: { blocked: [], confirm: {}, va529: { accounts: 1, missing: ['College fund'] } } };
  const recs = evaluateTriggers(ctx).map(h => h.rec);
  const va = recs.find(r => r.id === 'va529');
  assert.ok(va.question.fields.length);
  assert.match(va.title, /College fund/);
  assert.equal(va.tasks.length, 0);
  assert.ok(recs.find(r => r.id === 'new-child').question.fields.some(f => f.type === 'date'));
  for (const t of triggers) {
    if (!['va529', 'year-end-retirement', 'solo401k-setup', 'scorp-salary', 'invoice-deferral', 'hsa-room'].includes(t.id)) continue;
    for (const key of Object.keys(CONFIRM_TASKS)) {
      const built = t.build(ctx, { confirm: [key], grounding: [] });
      assert.ok(built.tasks.every(x => !/Run planning again/.test(x.t)));
    }
  }
});
