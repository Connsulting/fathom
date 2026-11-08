import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { tempDb } from './helpers/server.mjs';
import { setSetting } from '../src/store/db.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { refreshDependencies } from '../src/ingest/coverage.mjs';
import { computeFigures } from '../src/jobs/planner/figures.mjs';
import { loadPlanningData } from '../src/jobs/planner/data.mjs';
import { healthLine } from '../web/horizon/screens/home-model.js';
import * as missing from '../src/jobs/triggers/missing-data.mjs';
import * as steps from '../web/horizon/screens/rec-steps.js';
import { createScheduler } from '../src/jobs/scheduler.mjs';
import { createJobDispatcher } from '../src/jobs/dispatch.mjs';
import { deriveSteps } from '../src/shared/rec-steps.mjs';
import { planRun } from './helpers/plan.mjs';
import { householdArg } from '../src/platform/cli.mjs';

const clock = '2026-11-05';
const quiet = { log() {}, info() {} };
async function store(t) {
  const s = await tempDb();
  t.after(() => { s.close(); rmSync(s.dataDir, { recursive: true, force: true }); });
  await setSetting(s.db, 'mode', 'real');
  return s;
}
const context = async (data, db) => ({ refreshNeeds: db ? await refreshDependencies(db, computeFigures(data, {}, { clock, entities: [] }).figures, clock) : { accounts: [], sourceIds: new Set() }, clock, year: 2026, facts: {}, warnings: [], info: { blocked: [] }, data, freshness: data.freshness });

async function seedAccounts(db) {
  await db.prepare("INSERT INTO sources (id, label, kind, as_of) VALUES ('ing:bank', 'Synthetic bank', 'balances', '2026-11-04')").run();
  for (const [id, date] of [['fresh-account', '2026-11-04'], ['stale-account', '2026-08-01']]) {
    await db.prepare("INSERT INTO accounts (id, name, kind, source_id) VALUES (?, ?, 'checking', 'ing:bank')").run(id, id);
    await db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?, ?, 100)').run(id, date);
    await db.prepare('INSERT INTO transactions (account_id, date, amount) VALUES (?, ?, 1)').run(id, date);
  }
}

test('Home and missing-data identify the same stale account despite a newer household date', async t => {
  const { db } = await store(t);
  await seedAccounts(db);
  const sc = await buildScenario(db, { clock });
  const data = await loadPlanningData(db, clock);
  const gaps = missing.items(await context(data, db)).filter(i => i.code.startsWith('balances:'));
  assert.equal(healthLine({ accounts: sc.accounts }).staleAccounts, 1);
  const rec = missing.build(await context(data, db), missing.evaluate(await context(data, db)));
  assert.deepEqual(rec.tasks.filter(t => t.code?.startsWith('balances:')).map(t => t.accountIds), [['stale-account']]);
  assert.deepEqual(gaps.map(i => [i.code, i.accountIds]), [
    ['balances:stale-account', ['stale-account']],
  ]);
  await db.prepare("UPDATE balances SET date = '2026-11-04' WHERE account_id = 'stale-account'").run();
  const after = await loadPlanningData(db, clock);
  assert.equal(healthLine({ accounts: (await buildScenario(db, { clock })).accounts }).staleAccounts, 0);
  assert.equal(missing.items(await context(after, db)).filter(i => i.code.startsWith('balances:')).length, 0);
});

test('missing-data prose has no stored count while Steps renders progress from current task data', () => {
  const uploads = ['balances', 'transactions', 'pnl'].map(code => ({ code, task: `Upload ${code}`, kind: 'upload', noun: code, text: 'Data is out of date.' }));
  const hit = { items: uploads };
  const stored = missing.template({}, hit);
  assert.doesNotMatch(JSON.stringify(stored), /\d/);
  const before = missing.build({}, hit);
  const after = missing.build({}, { items: uploads.slice(0, 2) });
  assert.doesNotMatch(before.title, /\d/);
  assert.doesNotMatch(after.title, /\d/);
  steps.bind({ esc: String, T: String, icon: () => '', addBtn: () => '', api: { txt: String } });
  const html = rec => steps.html({ id: 'missing-data', ...rec, tasks: rec.tasks.map(t => ({ ...t, auto: true, done: false })) });
  assert.match(html(before), /0 of 3/);
  assert.match(html(after), /0 of 2/);
  assert.equal(missing.template({}, { items: uploads.slice(0, 2) }).summary, stored.summary);
});

test('an employer gap renders the accepted Ask control', async () => {
  const data = { accounts: [], freshness: [], confirm: [
    { id: 4, kind: 'tax_year', status: 'pending' },
    { id: 21, kind: 'employer_relation', status: 'answered' },
    { id: 22, kind: 'employer_relation', status: 'pending' },
  ] };
  const ctx = await context(data);
  ctx.info.blocked = ['employer_relation_pending'];
  const hit = missing.evaluate(ctx);
  const task = missing.build(ctx, hit).tasks[0];
  assert.equal(task.fix.key, 'income.employerRelation');
  assert.equal(task.link, 'ask');
  steps.bind({ esc: String, T: String, icon: () => '', addBtn: () => '', api: { txt: String } });
  const rec = { id: 'missing-data', tasks: [{ ...task, auto: true, done: false }] };
  for (const html of [steps.html(rec), steps.nextHtml(rec)]) {
    assert.match(html, /data-tax-gap-fix=/);
    assert.match(html, /income.employerRelation/);
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
  await db.prepare("INSERT INTO job_lock (id, holder, expires_at) VALUES (1, 'other-scheduler', '2027-01-01T00:00:00Z')").run();
  await s.tick(); await s.tick();
  assert.equal(logs.length, 2);
  current = 'household-b';
  await s.tick(); await s.tick();
  assert.equal(logs.length, 4);
  assert.equal(errors.length, 0);
  await assert.rejects(s.runNow('plan'), e => e.code === 'locked');
  assert.equal(logs.length, 4);
  await db.prepare('DELETE FROM job_lock').run();
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
  let deadline;
  try {
    await Promise.race([s.stop(), new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('shutdown exceeded its bound')), 1000);
    })]);
  } finally { clearTimeout(deadline); }
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

test('the first planner run classifies a personal summary without creating a ledger confirmation', async t => {

  const { db } = await store(t);
  for (const category of ['Medical', 'Shopping', 'Groceries', 'HSA', 'Dining']) {
    await db.prepare('INSERT INTO pnl_lines (entity, period, category, amount) VALUES (?, ?, ?, ?)').run('Synthetic ledger', '2026-10', category, -100);
  }
  await planRun(db, { now: clock });
  const item = await db.prepare("SELECT id FROM confirm_items WHERE kind = 'fact_check' AND status = 'pending'").get();
  assert.equal(item, undefined);
  const fact = JSON.parse((await db.prepare("SELECT value FROM facts WHERE key='business.entities'").get()).value);
  assert.equal(fact.find(e => e.name === 'Synthetic ledger').type, 'personal');
  const sc = await buildScenario(db, { clock });
  assert.ok(!sc.recs.find(r => r.id === 'missing-data').tasks.some(t => t.kind === 'confirm'));
  assert.ok(sc.recs.some(r => r.assumptions?.some(a => a.key === 'business.entities' && a.path[0] === 'Synthetic ledger')));


});

test('a connection mapping without newer account data cannot make that account fresh', async t => {
  const { db } = await store(t);
  await seedAccounts(db);
  await db.prepare("INSERT INTO simplefin_connection (id, access_blob, connected_at) VALUES (1, 'synthetic', '2026-11-04')").run();
  await db.prepare("INSERT INTO simplefin_accounts (sf_key, account_id, status, name, created_at) VALUES ('synthetic-key', 'stale-account', 'mapped', 'Synthetic', '2026-11-04')").run();
  const sc = await buildScenario(db, { clock });
  assert.equal(sc.accounts.find(a => a.id === 'stale-account').fresh, 'stale');
  assert.equal(healthLine({ accounts: sc.accounts }).staleAccounts, 1);
  const data = await loadPlanningData(db, clock);
  assert.ok(!missing.items(await context(data, db)).some(i => i.accountIds?.includes('stale-account')), 'the feed remains stale, but a connected account needs no upload');
});

test('a named payroll blocker selects that employer rather than another question of the same kind', async () => {
  const data = { accounts: [], freshness: [], confirm: [
    { id: 11, kind: 'employer_relation', status: 'pending', context: { employer: 'Unrelated Employer' } },
    { id: 12, kind: 'employer_relation', status: 'pending', context: { employer: 'Relevant Employer' } },
  ] };
  const ctx = await context(data);
  ctx.info = { blocked: ['employer_relation_pending'], payrollBlocks: [{ code: 'employer_relation_pending', employer: 'Relevant Employer' }] };
  const task = missing.build(ctx, missing.evaluate(ctx)).tasks[0];
  assert.match(task.fix.prompt, /Relevant Employer/);
  assert.doesNotMatch(task.fix.prompt, /Unrelated Employer/);
});

test('an answered Confirm target cannot retarget a step to an unrelated pending employer', () => {
  const tasks = [{ t: 'Answer whether the employer is your own business in Confirm', kind: 'confirm', code: 'employer_relation_pending', confirmId: 12, link: 'confirm' }];
  const confirm = [
    { id: 11, kind: 'employer_relation', status: 'pending', context: { employer: 'Unrelated Employer' } },
    { id: 12, kind: 'employer_relation', status: 'answered', context: { employer: 'Relevant Employer' } },
  ];
  const step = deriveSteps(tasks, [], { confirm, open: ['employer_relation_pending'] })[0];
  assert.equal(step.confirmId, undefined);
  assert.equal(step.link, 'ask');
  confirm[1].status = 'pending';
  const reopened = deriveSteps(tasks, [], { confirm, open: ['employer_relation_pending'] })[0];
  assert.equal(reopened.confirmId, 12);
  assert.equal(reopened.link, 'confirm');
});
