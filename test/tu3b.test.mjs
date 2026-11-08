import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tempDb } from './helpers/server.mjs';
import { setSetting } from '../src/store/db.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { loadPlanningData } from '../src/jobs/planner/data.mjs';
import { healthLine } from '../web/horizon/screens/home-model.js';
import * as missing from '../src/jobs/triggers/missing-data.mjs';
import * as steps from '../web/horizon/screens/rec-steps.js';
import { createScheduler } from '../src/jobs/scheduler.mjs';
import { createJobDispatcher } from '../src/jobs/dispatch.mjs';
import { householdArg } from '../src/platform/cli.mjs';

const clock = '2026-11-05';
const quiet = { log() {}, info() {} };
async function store(t) {
  const s = await tempDb();
  t.after(() => { s.close(); rmSync(s.dataDir, { recursive: true, force: true }); });
  setSetting(s.db, 'mode', 'real');
  return s;
}
const context = data => ({ clock, year: 2026, facts: {}, warnings: [], info: { blocked: [] }, data, freshness: data.freshness });

function seedAccounts(db) {
  db.prepare("INSERT INTO sources (id, label, kind, as_of) VALUES ('ing:bank', 'Synthetic bank', 'balances', '2026-11-04')").run();
  for (const [id, date] of [['fresh-account', '2026-11-04'], ['stale-account', '2026-08-01']]) {
    db.prepare("INSERT INTO accounts (id, name, kind, source_id) VALUES (?, ?, 'checking', 'ing:bank')").run(id, id);
    db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?, ?, 100)').run(id, date);
    db.prepare('INSERT INTO transactions (account_id, date, amount) VALUES (?, ?, 1)').run(id, date);
  }
}

test('Home and missing-data identify the same stale account despite a newer household date', async t => {
  const { db } = await store(t);
  seedAccounts(db);
  const sc = buildScenario(db, { clock });
  const data = loadPlanningData(db, clock);
  const gaps = missing.items(context(data)).filter(i => ['balances', 'transactions'].includes(i.code));
  assert.equal(healthLine({ accounts: sc.accounts }).staleAccounts, 1);
  assert.deepEqual(gaps.map(i => [i.code, i.accountIds]), [
    ['balances', ['stale-account']], ['transactions', ['stale-account']],
  ]);
  db.prepare("UPDATE balances SET date = '2026-11-04' WHERE account_id = 'stale-account'").run();
  const after = loadPlanningData(db, clock);
  assert.equal(healthLine({ accounts: buildScenario(db, { clock }).accounts }).staleAccounts, 0);
  assert.equal(missing.items(context(after)).filter(i => ['balances', 'transactions'].includes(i.code)).length, 0);
});

test('missing-data stored template has no count while its data-derived title changes', () => {
  const uploads = ['balances', 'transactions', 'pnl'].map(code => ({ code, task: `Upload ${code}`, kind: 'upload', noun: code, text: 'Data is out of date.' }));
  const hit = { items: uploads };
  const stored = missing.template({}, hit);
  assert.doesNotMatch(JSON.stringify(stored), /\d/);
  assert.match(missing.build({}, hit).title, /3 files/);
  assert.match(missing.build({}, { items: uploads.slice(0, 2) }).title, /2 files/);
  assert.equal(missing.template({}, { items: uploads.slice(0, 2) }).summary, stored.summary);
});

test('a Confirm step carries the matching pending item and renders its exact destination', () => {
  const data = { accounts: [], freshness: [], confirm: [
    { id: 4, kind: 'tax_year', status: 'pending' },
    { id: 21, kind: 'employer_relation', status: 'answered' },
    { id: 22, kind: 'employer_relation', status: 'pending' },
  ] };
  const ctx = context(data);
  ctx.info.blocked = ['employer_relation_pending'];
  const hit = missing.evaluate(ctx);
  const task = missing.build(ctx, hit).tasks[0];
  assert.equal(task.confirmId, 22);
  steps.bind({ esc: String, T: String, icon: () => '', addBtn: () => '', api: { txt: String } });
  const rec = { id: 'missing-data', tasks: [{ ...task, auto: true, done: false }] };
  for (const html of [steps.html(rec), steps.nextHtml(rec)]) {
    assert.match(html, /href="#\/confirm\/22"/);
    assert.match(html, /data-go="confirm" data-id="22"/);
  }
});

test('storage numbering and email CLI documentation match the current contracts', () => {
  const spec = readFileSync(new URL('../docs/plans/storage-port.md', import.meta.url), 'utf8');
  assert.doesNotMatch(spec, /migration \d+ is next free/);
  assert.match(spec, /numbered in merge order/);
  assert.match(spec, /highest.*src\/store\/migrations/s);
  assert.deepEqual(householdArg(['--household', 'synthetic-household']), { householdId: 'synthetic-household', rest: [] });
  for (const path of ['../README.md', '../docs/architecture.md', '../docs/development.md']) {
    const text = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(text, /npm run email:test -- --household <id>/, path);
    assert.doesNotMatch(text, /npm run email:test(?! -- --household)/, path);
  }
});

test('lock refusal logs once per job and household at info level, then work can resume', async t => {
  const { db } = await store(t);
  const logs = [], errors = [];
  let current = 'household-a', n = 0;
  const s = createScheduler({ db, now: () => new Date(`${clock}T12:00:00Z`), household: () => ({ householdId: current }),
    handlers: { plan: async () => { n++; }, freshness: async () => {} }, holder: 'this-scheduler',
    log: { info: (...args) => logs.push(args), log: (...args) => errors.push(args) } });
  t.after(() => s.stop());
  db.prepare("INSERT INTO job_lock (id, holder, expires_at) VALUES (1, 'other-scheduler', '2027-01-01T00:00:00Z')").run();
  await s.tick(); await s.tick();
  assert.equal(logs.length, 2);
  current = 'household-b';
  await s.tick(); await s.tick();
  assert.equal(logs.length, 4);
  assert.equal(errors.length, 0);
  await assert.rejects(s.runNow('plan'), e => e.code === 'locked');
  assert.equal(logs.length, 4);
  db.prepare('DELETE FROM job_lock').run();
  assert.equal((await s.runNow('plan')).status, 'ok');
  assert.equal(n, 1);
});

test('shutdown of work queued behind occupied dispatcher slots is bounded and never starts it', async t => {
  const { db } = await store(t);
  const dispatcher = createJobDispatcher();
  const releases = [];
  const blockers = ['other-a', 'other-b'].map(id => dispatcher.run(id, () => new Promise(resolve => releases.push(resolve))));
  let calls = 0;
  const s = createScheduler({ db, dispatcher, household: () => ({ householdId: 'queued-household' }), drainMs: 30,
    handlers: { plan: async () => { calls++; } }, log: quiet });
  const queued = assert.rejects(s.runNow('plan'), e => e.code === 'locked');
  const start = performance.now();
  await Promise.race([s.stop(), new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('shutdown exceeded its bound')), 1000); timer.unref();
  })]);
  assert.ok(performance.now() - start < 1000);
  assert.equal(calls, 0);
  releases.forEach(resolve => resolve());
  await Promise.all([...blockers, queued]);
  assert.equal(calls, 0);
  const live = createScheduler({ db, dispatcher, household: () => ({ householdId: 'live-household' }), handlers: { plan: async () => { calls++; } }, log: quiet });
  assert.equal((await live.runNow('plan')).status, 'ok');
  assert.equal(calls, 1);
  await live.stop();
});
