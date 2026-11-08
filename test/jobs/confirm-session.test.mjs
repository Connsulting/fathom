// Fixes from a first real Confirm session: planner fact checks answerable and stale only when the
// notes fact changes (with the heal path for checks asked before context.stored existed), the
// plan job scheduled after confirm answers (debounced, immediate when the queue is empty), war
// games that could not be built recorded with a plain reason, and the server's keep-alive
// timeouts. All data is synthetic (test/helpers/real-store.mjs).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planRun } from '../helpers/plan.mjs';
import { scratch, addNotes, factRow, contentValue, createRealStore, SOLE_PROP, parseJson } from '../helpers/real-store.mjs';
import { answerItem, getItem, ask, ConfirmError, FACT_CHECK_OPTIONS } from '../../src/ingest/confirm.mjs';
import { answerConfirm, schedulePlan } from '../../src/api/ingest-handlers.mjs';
import { createScheduler } from '../../src/jobs/scheduler.mjs';
import { startServer, KEEP_ALIVE_TIMEOUT_MS, HEADERS_TIMEOUT_MS } from '../../src/server.mjs';
import { loadConfig } from '../../src/config.mjs';

const NOW = '2026-11-05';
const KEY = 'giving.annualEstimate';
const S = scratch('fathom-confirm-session-');
after(async () => await S.cleanup());

const plan = async db => planRun(db, { now: NOW });
const plannerChecks = async (db, key = KEY) => (await db.prepare("SELECT id, status, answer, subject, context FROM confirm_items WHERE kind = 'fact_check'").all())
  .map(r => ({ ...r, context: parseJson(r.context, {}) })).filter(r => r.context.src === 'planner' && r.context.key === key);
const notesFact = value => ({ facts: [{ key: KEY, value: String(value), confidence: 0.95 }] });
const NOTES_VALUE = 1;

// A store whose notes say the giving estimate is NOTES_VALUE while the data derives another value.
async function disagreeing() {
  const db = await S.store({ variant: {} });
  await addNotes(db, notesFact(NOTES_VALUE));
  const notes = await factRow(db, KEY);
  assert.ok(notes && notes.value === NOTES_VALUE && String(notes.src).startsWith('ing:notes:'), `notes fact stored: ${JSON.stringify(notes)}`);
  await plan(db);
  const pending = (await plannerChecks(db)).filter(c => c.status === 'pending');
  assert.equal(pending.length, 1, `one pending planner check: ${JSON.stringify(pending)}`);
  const [check] = pending;
  assert.notEqual(check.context.value, NOTES_VALUE, 'the derived value differs from the notes fact');
  assert.equal(check.context.stored, NOTES_VALUE, 'the check records the notes value it was asked against');
  return { db, check };
}

test('a planner check whose derived value differs from the notes fact is answered yes: the derived value is confirmed', async () => {
  const { db, check } = await disagreeing();
  const { item } = await answerItem(db, check.id, 'yes');
  assert.equal(item.status, 'answered');
  assert.equal(item.answer, 'yes');
  const fact = await factRow(db, KEY);
  assert.equal(fact.value, check.context.value);
  assert.equal(fact.confirmed, 1);
  await plan(db);
  assert.equal((await plannerChecks(db)).filter(c => c.status === 'pending').length, 0, 'a rerun asks nothing new');
});

test('a planner check whose derived value differs from the notes fact is answered no: the notes fact is kept', async () => {
  const { db, check } = await disagreeing();
  const before = await factRow(db, KEY);
  const { item } = await answerItem(db, check.id, 'no');
  assert.equal(item.answer, 'no');
  const fact = await factRow(db, KEY);
  assert.equal(fact.value, NOTES_VALUE);
  assert.equal(fact.src, before.src);
  await plan(db);
  assert.equal((await plannerChecks(db)).filter(c => c.status === 'pending').length, 0, 'a rerun asks nothing new');
  assert.equal((await factRow(db, KEY)).value, NOTES_VALUE);
});

test('a planner check goes stale only when the notes fact changes, and the next run asks it again', async () => {
  const { db, check } = await disagreeing();
  await db.prepare('UPDATE facts SET value = ? WHERE key = ?').run(JSON.stringify(NOTES_VALUE + 1), KEY);
  assert.throws(async () => await answerItem(db, check.id, 'yes'), e => e instanceof ConfirmError && e.code === 'stale');
  assert.equal((await getItem(db, check.id)).status, 'pending', 'a stale refusal changes nothing');
  await plan(db);
  const again = await getItem(db, check.id);
  assert.equal(again.status, 'pending');
  assert.equal(again.context.stored, NOTES_VALUE + 1, 'asked again against the current notes value');
  assert.ok(!again.question.includes(KEY), 'the comparison retains the notes value without exposing its fact key');
  assert.match(again.question, new RegExp(`notes say ${NOTES_VALUE + 1}\\.`));
  assert.equal((await answerItem(db, check.id, 'no')).item.answer, 'no');
});

test('heal: a pending planner check asked before context.stored existed is refused as stale, then re-asked with the field', async () => {
  const { db, check } = await disagreeing();
  const { stored, ...old } = check.context;
  void stored;
  await db.prepare('UPDATE confirm_items SET context = ? WHERE id = ?').run(JSON.stringify(old), check.id);
  assert.throws(async () => await answerConfirm({ db, config: {}, params: { id: String(check.id) }, body: { answer: 'yes' } }),
    e => e.status === 409 && e.code === 'stale');
  await plan(db);
  const healed = await getItem(db, check.id);
  assert.equal(healed.status, 'pending');
  assert.equal(healed.context.stored, NOTES_VALUE);
  assert.equal((await plannerChecks(db)).filter(c => c.status === 'pending').length, 1, 'one pending check, no duplicate');
  const { item } = await answerItem(db, check.id, 'yes');
  assert.equal(item.answer, 'yes');
  assert.equal((await factRow(db, KEY)).value, check.context.value);
});

test('a pending planner check for a key with no disagreement left is closed as superseded', async () => {
  const { db, check } = await disagreeing();
  await db.prepare('DELETE FROM facts WHERE key = ?').run(KEY);
  await plan(db);
  const closed = await getItem(db, check.id);
  assert.equal(closed.status, 'answered');
  assert.equal(closed.answer, 'superseded');
});

// ---------------------------------------------------------------- war games not built

test('a war game the planner could not build is recorded with a plain reason and what unlocks it', async () => {
  const db = await S.store({ variant: { entities: [SOLE_PROP] } });
  await plan(db);
  const wg = await contentValue(db, 'wargame');
  assert.ok(wg && !wg.salary, 'no salary war game without an S corp');
  const nb = wg.notBuilt && wg.notBuilt.salary;
  assert.ok(nb, `salary not-built reason stored: ${JSON.stringify(wg)}`);
  assert.equal(nb.code, 'scorp_missing');
  assert.equal(nb.text, 'Salary war game needs an S corp with profit on file.');
  assert.equal(nb.unlock, 'files');
  assert.deepEqual(nb.fix, { screen: 'upload', kind: 'pnl', label: 'Upload the S corp profit and loss' });
  for (const r of Object.values(wg.notBuilt)) assert.doesNotMatch(r.text, /\d/, 'no figures in the reason');
});

test('a built war game has no not-built reason', async () => {
  const db = await S.store({ variant: {} });
  await plan(db);
  const wg = await contentValue(db, 'wargame');
  assert.ok(wg.salary, 'the salary war game is built');
  assert.ok(!(wg.notBuilt && wg.notBuilt.salary));
});

// ---------------------------------------------------------------- plan after answers

function countingScheduler(db, opts = {}) {
  const runs = [];
  const s = createScheduler({
    db, config: { clock: NOW }, tickMs: 3600000, holder: `test-soon-${process.pid}-${Math.random()}`, log: { log() {} },
    handlers: { plan: async ctx => { runs.push(ctx.trigger); return { note: { ok: 1 } }; } }, ...opts,
  });
  return { s, runs };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

test('soon debounces a burst of triggers into one run recorded with its trigger', async () => {
  const db = S.track(await createRealStore(S.dir(), { clock: NOW }));
  const { s, runs } = countingScheduler(db, { debounceMs: 80 });
  try {
    for (let i = 0; i < 5; i++) { assert.equal(s.soon('plan', 'confirm'), true); await wait(10); }
    assert.equal(runs.length, 0, 'nothing runs during the burst');
    await wait(250);
    assert.deepEqual(runs, ['confirm'], 'one run after the burst');
    const row = await db.prepare("SELECT trigger, period_key, status FROM job_runs WHERE job_id = 'plan' ORDER BY id DESC LIMIT 1").get();
    assert.equal(row.trigger, 'confirm');
    assert.match(row.period_key, /^confirm:/);
    assert.equal(row.status, 'ok');
  } finally {
    await s.stop();
  }
});

test('soon with immediate runs at once and cancels a pending debounce', async () => {
  const db = S.track(await createRealStore(S.dir(), { clock: NOW }));
  const { s, runs } = countingScheduler(db, { debounceMs: 80 });
  try {
    s.soon('plan', 'confirm');
    s.soon('plan', 'confirm', { immediate: true });
    await wait(30);
    assert.deepEqual(runs, ['confirm']);
    await wait(150);
    assert.deepEqual(runs, ['confirm'], 'the pending debounce was replaced');
  } finally {
    await s.stop();
  }
});

test('stop drops a pending debounced trigger', async () => {
  const db = S.track(await createRealStore(S.dir(), { clock: NOW }));
  const { s, runs } = countingScheduler(db, { debounceMs: 50 });
  s.soon('plan', 'confirm');
  await s.stop();
  await wait(120);
  assert.deepEqual(runs, []);
  assert.equal(s.soon('plan', 'confirm'), false, 'nothing is scheduled after stop');
});

test('a confirm answer schedules the plan debounced, and immediately once the queue is empty', async () => {
  const db = S.track(await createRealStore(S.dir(), { clock: NOW }));
  const calls = [];
  const scheduler = { soon: (jobId, reason, opts) => calls.push([jobId, reason, !!(opts && opts.immediate)]) };
  for (const n of [1, 2]) {
    await ask(db, { kind: 'fact_check', subject: `test|household.k${n}|true`, question: 'Synthetic question?', options: FACT_CHECK_OPTIONS,
      context: { key: `household.k${n}`, value: true, src: 'test' } });
  }
  const ids = (await db.prepare("SELECT id FROM confirm_items WHERE status = 'pending' ORDER BY id").all()).map(r => r.id);
  const ctx = id => ({ db, config: {}, scheduler, params: { id: String(id) }, body: { answer: 'yes' } });
  await answerConfirm(ctx(ids[0]));
  assert.deepEqual(calls, [['plan', 'confirm', false]], 'one item still pending: debounced');
  await answerConfirm(ctx(ids[1]));
  assert.deepEqual(calls[1], ['plan', 'confirm', true], 'queue empty: immediate');
  await db.prepare("UPDATE settings SET value = '\"demo\"' WHERE key = 'mode'").run();
  await schedulePlan({ db, scheduler });
  assert.equal(calls.length, 2, 'a demo store schedules nothing');
});

// ---------------------------------------------------------------- server timeouts

test('the server keeps idle connections longer than a reverse proxy does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fathom-timeouts-'));
  let app;
  try {
    app = await startServer({ ...loadConfig({ FATHOM_DATA: dir, FATHOM_DEMO: '1', FATHOM_ENGINE: 'off' }), port: 0 });
    assert.equal(app.server.keepAliveTimeout, 65000);
    assert.equal(app.server.headersTimeout, 66000);
    assert.equal(KEEP_ALIVE_TIMEOUT_MS, 65000);
    assert.ok(HEADERS_TIMEOUT_MS > KEEP_ALIVE_TIMEOUT_MS);
    const res = await fetch(`${app.url}/api/confirm/999999`);
    assert.equal(res.status, 404);
  } finally {
    if (app) await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
