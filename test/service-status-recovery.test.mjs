// H2 review regressions: the Engine screen poll (F1), pauses that were since lifted (F2), the
// SimpleFIN block showing its sync job (F3) and the confirm-guess budget stop under the cap (F4).
// All data is synthetic.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempDb } from './helpers/server.mjs';
import { JOBS } from '../src/jobs/scheduler.mjs';
import { serviceStatus } from '../src/jobs/service-status.mjs';
import * as engineScreen from '../web/horizon/screens/engine.js';
import * as simplefin from '../web/horizon/screens/simplefin.js';
import * as statusView from '../web/horizon/screens/service-status.js';
import { forEachSeries } from '../src/shared/series.mjs';

const NOW = '2026-11-08T15:00:00.000Z';
const RAN_AT = '2026-11-08T14:00:00.000Z';
const RAN_END = '2026-11-08T14:00:02.000Z';
const NEXT_AT = '2026-11-09T07:00:00.000Z';
const ALL_ON = Object.freeze({ jobs: true, email: true, simplefin: true, engine: true });

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/* ---------- F1: the Engine screen poll ---------- */

function bindEngine({ running = false, route = 'engine' } = {}) {
  const state = { refreshes: 0, route };
  const services = { jobs: { plan: { key: 'job:plan', state: 'healthy', running } } };
  engineScreen.bind({
    esc,
    api: { s: { live: { services } }, refresh() { state.refreshes += 1; } },
    routeNow: () => ({ name: state.route }),
  });
  return state;
}

function pollCase(name, fn) {
  test(`F1 engine poll: ${name}`, () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      engineScreen.reset();
      fn();
    } finally {
      engineScreen.reset();
      mock.timers.reset();
    }
  });
}

pollCase('an idle plan re-reads after 30000 ms, not before', async () => {
  const st = bindEngine();
  engineScreen.schedulePoll();
  await mock.timers.tick(29999);
  assert.equal(st.refreshes, 0, 'no refresh before 30000 ms');
  await mock.timers.tick(1);
  assert.equal(st.refreshes, 1, 'one refresh at 30000 ms');
});

pollCase('a running plan re-reads after 5000 ms', async () => {
  const st = bindEngine({ running: true });
  engineScreen.schedulePoll();
  await mock.timers.tick(4999);
  assert.equal(st.refreshes, 0, 'no refresh before 5000 ms');
  await mock.timers.tick(1);
  assert.equal(st.refreshes, 1, 'one refresh at 5000 ms');
});

pollCase('no refresh when the route is no longer the Engine screen at fire time', async () => {
  const st = bindEngine({ running: true });
  engineScreen.schedulePoll();
  st.route = 'home';
  await mock.timers.tick(60000);
  assert.equal(st.refreshes, 0);
});

pollCase('calling schedulePoll twice keeps exactly one pending timer', async () => {
  const st = bindEngine();
  engineScreen.schedulePoll();
  engineScreen.schedulePoll();
  await mock.timers.tick(30000);
  assert.equal(st.refreshes, 1, 'one refresh, not two');
  await mock.timers.tick(30000);
  assert.equal(st.refreshes, 1, 'the fired timer does not re-arm itself');
});

pollCase('reset clears the pending timer', async () => {
  const st = bindEngine({ running: true });
  engineScreen.schedulePoll();
  engineScreen.reset();
  await mock.timers.tick(60000);
  assert.equal(st.refreshes, 0);
});

/* ---------- store fixtures for F2 and F4 ---------- */

const engineStatus = (over = {}) => ({ mode: 'fake', on: true, credentialState: 'loaded', funded: true, capUsd: 200, spentUsd: 0, ...over });
const fakeEngine = (over = {}) => ({ status: () => engineStatus(over), isOn: () => over.on !== false, async init() {} });
const fakeScheduler = () => ({ schedule: () => JOBS.map((j) => ({ id: j.id, nextAt: NEXT_AT, retryMs: 15 * 60000 })) });

async function ensureJobRows(db) {
  const ins = db.prepare("INSERT OR IGNORE INTO jobs (id, name, cadence, does, cost, next_label, last_label, enabled, sort) VALUES (?, ?, ?, ?, NULL, '', '', 1, ?)");
  await forEachSeries(JOBS, async (j, i) => await ins.run(j.id, j.name, j.cadence, j.does, 100 + i));
}

async function resetStore(db) {
  await db.applySchema('DELETE FROM job_runs; DELETE FROM simplefin_connection; DELETE FROM email_sends');
}

async function addRun(db, jobId, status, { errorClass = null, note = null } = {}) {
  await db.prepare(`INSERT INTO job_runs (job_id, started_at, finished_at, status, period_key, trigger, duration_ms, error_class, cost_usd, note)
    VALUES (?, ?, ?, ?, '2026-11-08', 'scheduled', 2000, ?, 0, ?)`)
    .run(jobId, RAN_AT, RAN_END, status, errorClass, note ? JSON.stringify(note) : null);
}

async function addSend(db, status, errorCode) {
  await db.prepare(`INSERT INTO email_sends (ts, kind, subject, status, error_code, transport, recipients, message_id, job_run_id)
    VALUES (?, 'test', 'Synthetic test email', ?, ?, 'dev', 1, NULL, NULL)`).run(RAN_END, status, errorCode);
}

async function withStore(t) {
  const store = await tempDb();
  t.after(async () => { try { await store.db.close(); } catch { /* closed */ } rmSync(store.dataDir, { recursive: true, force: true }); });
  await ensureJobRows(store.db);
  return store.db;
}

const status = async (db, { outbound = {}, engine = fakeEngine() } = {}) =>
  await serviceStatus({ db, outbound: { ...ALL_ON, ...outbound }, engine, scheduler: fakeScheduler(), now: new Date(NOW) });

/* ---------- F2: a pause that has been lifted is not current ---------- */

test('F2 brief-email: a latest email_paused error is healthy once outbound email is on', async (t) => {
  const db = await withStore(t);
  await resetStore(db);
  await addRun(db, 'brief-email', 'error', { errorClass: 'email_paused' });
  const out = await status(db);
  assert.equal(out.jobs['brief-email'].state, 'healthy');
});

test('F2 email: a latest failed paused send is healthy when email is on and paused when it is off', async (t) => {
  const db = await withStore(t);
  await resetStore(db);
  await addSend(db, 'failed', 'paused');
  assert.equal((await status(db)).email.state, 'healthy');
  assert.equal((await status(db, { outbound: { email: false } })).email.state, 'paused');
});

test('F2 simplefin-sync: a run skipped while paused is healthy when simplefin is on and paused when off', async (t) => {
  const db = await withStore(t);
  await resetStore(db);
  await addRun(db, 'simplefin-sync', 'skipped', { note: { paused: true } });
  assert.equal((await status(db)).jobs['simplefin-sync'].state, 'healthy');
  assert.equal((await status(db, { outbound: { simplefin: false } })).jobs['simplefin-sync'].state, 'paused');
});

test('F2 confirm-guess: an engine_paused stop is healthy when engine calls are on and paused when off', async (t) => {
  const db = await withStore(t);
  await resetStore(db);
  await addRun(db, 'confirm-guess', 'ok', { note: { stopped: true, stoppedBy: { engine_paused: true } } });
  assert.equal((await status(db)).jobs['confirm-guess'].state, 'healthy');
  assert.equal((await status(db, { outbound: { engine: false } })).jobs['confirm-guess'].state, 'paused');
});

test('F2 confirm-guess: an engine_off stop is healthy when the engine is on and paused with engine_on when off', async (t) => {
  const db = await withStore(t);
  await resetStore(db);
  await addRun(db, 'confirm-guess', 'ok', { note: { stopped: true, stoppedBy: { engine_off: true } } });
  assert.equal((await status(db, { engine: fakeEngine({ on: true }) })).jobs['confirm-guess'].state, 'healthy');
  const off = (await status(db, { engine: fakeEngine({ on: false }) })).jobs['confirm-guess'];
  assert.equal(off.state, 'paused');
  assert.equal(off.control?.id, 'engine_on');
});

/* ---------- F3: the SimpleFIN block shows the sync job ---------- */

const SF_JOB = {
  key: 'job:simplefin-sync', label: 'Bank and brokerage sync', state: 'retrying', code: 'interrupted',
  cause: 'The last run was interrupted before it finished. It runs again automatically.',
  lastSuccessAt: null, nextAttemptAt: null, since: RAN_AT, go: 'money',
  control: { id: 'run_job', label: 'Run now', arg: 'simplefin-sync' },
};
const SF_SERVICE = { key: 'simplefin', label: 'SimpleFIN connection', state: 'healthy', code: null, cause: null, lastSuccessAt: null, nextAttemptAt: null, since: null, control: null, go: 'money' };

function sfKit(jobState) {
  return {
    esc,
    btn: (label, attrs) => `<button ${attrs}>${label}</button>`,
    icon: () => '',
    plural: (n, w) => `${n} ${w}s`,
    goA: () => '',
    root: null,
    draw() {},
    api: {
      s: {
        live: {
          simplefin: { connected: true, accounts: 2, lastSyncAt: '2026-11-01T10:00:00Z', status: 'ok', errorCode: null, messages: [] },
          services: { simplefin: { ...SF_SERVICE }, jobs: { 'simplefin-sync': jobState } },
        },
        engine: { jobs: [] },
      },
    },
  };
}

test('F3 simplefin block: a healthy connection still shows a non-healthy sync job with its cause', () => {
  const kit = sfKit({ ...SF_JOB });
  statusView.bind(kit);
  simplefin.bind(kit);
  simplefin.reset();
  const html = simplefin.block();
  assert.ok(html.includes('data-svc="job:simplefin-sync"'), 'the sync job status is shown');
  assert.ok(html.includes(esc(SF_JOB.cause)), 'the interrupted cause is shown');
});

test('F3 simplefin block: no status element when the connection and the sync job are healthy', () => {
  const kit = sfKit({ ...SF_JOB, state: 'healthy', code: null, cause: null, since: null, control: null });
  statusView.bind(kit);
  simplefin.bind(kit);
  simplefin.reset();
  const html = simplefin.block();
  assert.ok(!html.includes('data-svc'), 'no data-svc element');
});

/* ---------- F4: a budget stop under the cap is not a cap problem ---------- */

test('F4 confirm-guess: a budget stop with the engine under its cap offers Run now and does not tell the owner to raise the cap', async (t) => {
  const db = await withStore(t);
  await resetStore(db);
  await addRun(db, 'confirm-guess', 'ok', { note: { stopped: true, stoppedBy: { budget: true } } });
  const job = (await status(db, { engine: fakeEngine({ capUsd: 200, spentUsd: 5 }) })).jobs['confirm-guess'];
  assert.equal(job.state, 'paused');
  assert.equal(job.code, 'budget');
  assert.equal(job.control?.id, 'run_job');
  assert.match(job.cause, /run/i, 'the cause mentions this run');
  assert.doesNotMatch(job.cause, /raise|higher cap/i, 'the cause does not tell the owner to raise the cap');
});

test('F4 confirm-guess: a budget stop with the cap reached keeps the cap control', async (t) => {
  const db = await withStore(t);
  await resetStore(db);
  await addRun(db, 'confirm-guess', 'ok', { note: { stopped: true, stoppedBy: { budget: true } } });
  const job = (await status(db, { engine: fakeEngine({ capUsd: 10, spentUsd: 10 }) })).jobs['confirm-guess'];
  assert.equal(job.state, 'paused');
  assert.equal(job.control?.id, 'cap');
});
