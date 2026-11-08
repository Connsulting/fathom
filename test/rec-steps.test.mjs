// Product-managed rec steps: a step the product can verify completes itself from stored data, an
// unobservable step is one "I did this" control with Undo, and no rec renders a free checkbox.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { scratch } from './helpers/real-store.mjs';
import { planRun } from './helpers/plan.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { recAction } from '../src/api/handlers.mjs';
import { writeRec } from '../src/store/recs.mjs';
import { evaluateTriggers } from '../src/jobs/triggers/index.mjs';
import { deriveSteps, isVerifiable } from '../src/shared/rec-steps.mjs';
import * as recSteps from '../web/horizon/screens/rec-steps.js';
import { scenario as demoScenario } from '../demo/scenario.mjs';

const s = scratch('fathom-steps-');
after(() => s.cleanup());
const LATE = '2026-12-28';
const accounts = [{ id: 'stable-college', kind: '529', name: 'manual', mask: '3333', display_name: 'College fund' }];
const context = extra => ({ clock: '2026-11-05', year: 2026, facts: {}, owner: {}, fig: {}, names: {}, model: {}, data: { accounts }, packs: [], packStatus: {}, warnings: [], freshness: [], info: { blocked: [], confirm: {} }, ...extra });
const missingOf = sc => sc.recs.find(r => r.id === 'missing-data');

test('every missing-data step is verifiable: an answer step names its fact, an upload step its data code', () => {
  const ctx = context({ warnings: ['filing_status_assumed'], freshness: [{ id: 'bank', label: 'Bank statements', state: 'stale' }] });
  const rec = evaluateTriggers(ctx).find(h => h.rec.id === 'missing-data').rec;
  assert.ok(rec.tasks.length >= 2);
  assert.ok(rec.tasks.every(isVerifiable), JSON.stringify(rec.tasks));
  const answer = rec.tasks.find(t => t.kind === 'answer');
  assert.equal(answer.fact, 'household.filingStatus');
  const upload = rec.tasks.find(t => t.kind === 'upload');
  assert.equal(upload.code, 'bank');
  assert.ok(!rec.tasks.some(t => /Mark it done|Review the figures/.test(t.t)), 'no generic filler steps');
});

test('a verifiable step clears itself once its fact lands, with no checkbox state', () => {
  const tasks = [{ t: 'Tell us your filing status', kind: 'answer', fact: 'household.filingStatus' }, { t: 'Upload the latest bank statements', kind: 'upload', code: 'bank' }];
  const before = deriveSteps(tasks, [true, true], { facts: {}, accounts: [], open: ['bank'] });
  assert.deepEqual(before.map(x => [x.auto, x.done]), [[true, false], [true, false]], 'stored flags never complete a verifiable step');
  const answered = deriveSteps(tasks, [], { facts: { 'household.filingStatus': 'mfj' }, accounts: [], open: ['bank'] });
  assert.deepEqual(answered.map(x => x.done), [true, false]);
  const uploaded = deriveSteps(tasks, [], { facts: { 'household.filingStatus': 'mfj' }, accounts: [], open: [] });
  assert.deepEqual(uploaded.map(x => x.done), [true, true]);
});

test('an upload step completes itself when the file lands and stays listed as done', async () => {
  const db = await s.store();
  await planRun(db, { now: LATE });
  let rec = missingOf(buildScenario(db, { clock: LATE }));
  assert.ok(rec, 'stale sources raise the missing-data rec');
  const balances = rec.tasks.find(t => t.code === 'balances');
  assert.ok(balances && balances.kind === 'upload' && balances.auto && !balances.done, JSON.stringify(rec.tasks));
  const i = rec.tasks.indexOf(balances);
  assert.throws(() => writeRec(db, 'missing-data', 'step', { index: i, checked: true }, { now: LATE }), /completes itself/);
  // The upload lands: a balance as of yesterday makes the balances source current.
  db.prepare('UPDATE balances SET date = ? WHERE id = (SELECT max(id) FROM balances)').run('2026-12-27');
  await planRun(db, { now: LATE });
  rec = missingOf(buildScenario(db, { clock: LATE }));
  assert.ok(rec, 'other sources are still stale');
  const after = rec.tasks.find(t => t.code === 'balances');
  assert.ok(after, 'the cleared step is still listed');
  assert.equal(after.done, true);
  assert.ok(rec.tasks.some(t => t.code !== 'balances' && !t.done));
  assert.doesNotMatch(rec.title, /balances/i);
});

test('an unobservable step is one "I did this" with its time and actor, and Undo reverses it', async () => {
  const db = await s.store();
  await planRun(db);
  const id = buildScenario(db).recs.find(r => r.tasks?.some(t => !isVerifiable(t)) && !r.question?.primary).id;
  const ctx = body => ({ db, config: { clock: '2026-11-05' }, params: { id }, body });
  let rec = buildScenario(db).recs.find(r => r.id === id);
  const i = rec.tasks.findIndex(t => t.kind === 'manual');
  assert.equal(rec.tasks[i].done, false);
  rec = recAction(ctx({ action: 'task', arg: i })).scenario.recs.find(r => r.id === id);
  assert.equal(rec.tasks[i].done, true);
  assert.equal(rec.tasks[i].doneBy, 'ui');
  assert.match(rec.tasks[i].doneAt, /^\d{4}-\d{2}-\d{2}T/);
  rec = recAction(ctx({ action: 'task', arg: i })).scenario.recs.find(r => r.id === id);
  assert.equal(rec.tasks[i].done, false);
  assert.equal(rec.tasks[i].doneAt, undefined);
  const events = db.prepare("SELECT action, arg, actor FROM rec_events WHERE rec_id = ? AND action LIKE 'step_%' ORDER BY id").all(id);
  assert.deepEqual(events.map(e => e.action), ['step_did', 'step_undo']);
  assert.equal(events[0].arg, rec.tasks[i].t);
});

const kit = {
  esc: v => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`),
  T: v => String(v ?? ''), icon: n => `<svg data-i="${n}"></svg>`, addBtn: () => '', api: { txt: v => String(v ?? '') },
};

function assertNoCheckbox(html, where) {
  assert.doesNotMatch(html, /type="checkbox"|role="checkbox"|aria-pressed|aria-checked/, `${where} renders a checkbox`);
}

test('no rec renders a free checkbox: open steps carry a control, done ones say how they finished', async () => {
  recSteps.bind(kit);
  const db = await s.store();
  await planRun(db, { now: LATE });
  const recs = [...buildScenario(db, { clock: LATE }).recs, ...demoScenario.recs.map(r => ({ ...r, tasks: deriveSteps(r.tasks || [], (r.tasks || []).map(t => !!t.done), {}) }))];
  assert.ok(recs.some(r => r.id === 'missing-data'));
  for (const r of recs) {
    const html = recSteps.html(r);
    assertNoCheckbox(html, r.id);
    for (const [i, t] of (r.tasks || []).entries()) {
      const li = html.split('<li').find(x => x.includes(`data-step="${i}"`));
      assert.ok(li, `${r.id} step ${i} is rendered`);
      if (t.auto && !t.done) assert.match(li, /data-upload-open|data-step-answer|data-go=|data-ask-next/, `${r.id} step ${i} has its control`);
      if (!t.auto && !t.done) assert.match(li, /data-act="task"[^>]*>I did this</, `${r.id} step ${i} offers I did this`);
      if (!t.auto && t.done) assert.match(li, /data-act="task"[^>]*>Undo</, `${r.id} step ${i} offers Undo`);
      if (t.auto) assert.doesNotMatch(li, /data-act="task"/, `${r.id} step ${i} is product-managed`);
    }
  }
});

test('the missing-data rec shows an upload button inline and a done step after the file lands', () => {
  recSteps.bind(kit);
  const html = recSteps.html({ id: 'missing-data', tasks: [
    { t: 'Upload the latest account balances', kind: 'upload', code: 'balances', noun: 'the latest account balances', auto: true, done: true },
    { t: 'Upload the latest business profit and loss', kind: 'upload', code: 'pnl', noun: 'the latest business profit and loss', auto: true, done: false },
    { t: 'Tell us your filing status', kind: 'answer', fact: 'household.filingStatus', auto: true, done: false },
  ] });
  assert.match(html, /1 of 3/);
  assert.match(html, /<input type="file"[^>]*data-upload/);
  assert.match(html, /data-step-answer="missing-data"/);
  assert.match(html, /Done automatically/);
});
