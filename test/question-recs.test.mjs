import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIRM_TASKS, ANSWER_SHAPES, questionFor } from '../src/jobs/triggers/common.mjs';
import { triggers, evaluateTriggers } from '../src/jobs/triggers/index.mjs';
import { writeProse } from '../src/jobs/planner/prose.mjs';

const accounts = [{ id: 'stable-college', kind: '529', name: 'manual', mask: '7939', display_name: 'College fund' }];

test('every confirm task has a declared, usable answer shape', () => {
  for (const key of Object.keys(CONFIRM_TASKS)) {
    assert.ok(ANSWER_SHAPES[key], key);
    const q = questionFor([key], { accounts, facts: {}, names: {} });
    assert.ok(q.fields.length, key);
    for (const f of q.fields) assert.ok(['boolean', 'number', 'date', 'choice'].includes(f.type), key);
  }
  assert.throws(() => questionFor(['unknown.key'], { accounts, facts: {} }), /answer shape/i);
});

const context = extra => ({ clock: '2026-11-05', year: 2026, facts: {}, owner: {}, fig: {}, names: {}, model: {}, data: { accounts }, packs: [], packStatus: {}, warnings: [], freshness: [], info: { blocked: [], confirm: {} }, ...extra });

test('mixed missing data keeps upload steps and its summary beside the answer form', async () => {
  const ctx = context({ warnings: ['filing_status_assumed'], freshness: [{ id: 'bank', label: 'Bank statements', state: 'stale' }] });
  const hit = evaluateTriggers(ctx).find(h => h.rec.id === 'missing-data');
  assert.equal(hit.rec.title, 'Bring your data up to date');
  assert.ok(hit.rec.tasks.some(t => /Upload the latest bank statements/.test(t.t)));
  assert.equal(hit.rec.question.primary, false);
  assert.deepEqual(hit.rec.question.keys, ['household.filingStatus']);
  const prose = await writeProse(hit, ctx);
  assert.match(prose.fields.summary, /data is missing or out of date/);
});

test('missing data leaves the Virginia answers on their existing recommendation', () => {
  const ctx = context({ facts: { 'accounts.has529': true, 'household.state': 'VA' }, info: { blocked: [], confirm: {}, va529: { accounts: 1, missing: ['College fund'] }, vaBlocked: 'va529_answers_missing', heldReasons: ['va529_answers_missing'] }, freshness: [{ id: 'bank', label: 'Bank statements', state: 'stale' }] });
  const hits = evaluateTriggers(ctx);
  assert.ok(hits.find(h => h.rec.id === 'va529').rec.question);
  const missing = hits.find(h => h.rec.id === 'missing-data').rec;
  assert.equal(missing.question, undefined);
  assert.ok(missing.tasks.some(t => /Upload/.test(t.t)));
  ctx.freshness = [];
  assert.equal(evaluateTriggers(ctx).find(h => h.rec.id === 'missing-data'), undefined);
});

test('a secondary catch-up answer keeps the figured action and asks only its participant', () => {
  const ctx = context({ facts: { 'income.sCorp': true, 'retirement.solo401k': true, 'household.filingStatus': 'mfj' }, fig: { 'room.solo401k.employee': { v: 1000, kind: 'm', label: 'Employee room' } }, info: { blocked: [], confirm: {}, solo: { person: 'owner', kind: 'scorp' }, retireCatchUp: 'retirement.priorYearFicaWages' } });
  const rec = evaluateTriggers(ctx).find(h => h.rec.id === 'year-end-retirement').rec;
  assert.match(rec.title, /^Fill your retirement room/);
  assert.ok(rec.tasks.some(t => /Elect the deferral/.test(t.t)));
  assert.equal(rec.question.primary, false);
  assert.equal(rec.question.fields.length, 1);
  assert.deepEqual(rec.question.fields[0].path, ['owner']);
});

test('accounts recognized as college savings by name have answer controls', () => {
  const q = questionFor(['accounts.va529'], { accounts: [{ id: 'named-plan', kind: 'taxable', name: '529 College Savings' }], facts: {} });
  assert.match(q.title, /529 College Savings/);
  assert.equal(q.fields.length, 3);
  assert.deepEqual(q.fields[0].path, ['named-plan', 'virginiaPlan']);
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
  assert.equal(recs.find(r => r.id === 'new-child').question.primary, false);
  assert.ok(recs.find(r => r.id === 'new-child').tasks.some(t => /health coverage/.test(t.t)));
  for (const t of triggers) {
    if (!['va529', 'year-end-retirement', 'solo401k-setup', 'scorp-salary', 'invoice-deferral', 'hsa-room'].includes(t.id)) continue;
    for (const key of Object.keys(CONFIRM_TASKS)) {
      const built = t.build(ctx, { confirm: [key], grounding: [] });
      assert.ok(built.tasks.every(x => !/Run planning again/.test(x.t)));
    }
  }
});
