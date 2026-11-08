// H2 AC1: the shared service status model. One table of rows (job error classes, skip reasons,
// outbound flags, engine reasons, resolver stop causes and SimpleFIN connection rows); each row maps
// to a state, a plain cause and one existing control, through serviceStatus over a temp store, through
// GET /api/jobs (listJobs) and the scenario (scenarioOf) for a household context, and through the
// rendered surface helper statusHtml. A new code is one line in ROWS. All data is synthetic.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempDb, tempInstance } from './helpers/server.mjs';
import { setSetting } from '../src/store/db.mjs';
import { setOutbound } from '../src/platform/outbound.mjs';
import { JOBS } from '../src/jobs/scheduler.mjs';
import { serviceStatus, isTransient } from '../src/jobs/service-status.mjs';
import { listJobs } from '../src/api/email-handlers.mjs';
import { scenarioOf } from '../src/api/scenario.mjs';
import * as view from '../web/horizon/screens/service-status.js';

const NOW = '2026-11-08T15:00:00.000Z';
const RAN_AT = '2026-11-08T14:00:00.000Z';
const RAN_END = '2026-11-08T14:00:02.000Z';
const NEXT_AT = '2026-11-09T07:00:00.000Z';
const RETRY_MS = 15 * 60000;
const ALL_ON = Object.freeze({ jobs: true, email: true, simplefin: true, engine: true });

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The screen route that owns each service (plan: go).
const GO = {
  'job:plan': 'engine', 'job:freshness': 'engine', 'job:trash-purge': 'engine', 'job:confirm-guess': 'engine',
  'job:brief-email': 'email', 'job:deadline-alerts': 'email', 'job:simplefin-sync': 'money',
  engine: 'engine', email: 'email', simplefin: 'money',
};

const engineStatus = (over = {}) => ({ mode: 'fake', on: true, credentialState: 'loaded', funded: true, capUsd: 200, spentUsd: 0, ...over });
const fakeEngine = (over = {}) => ({ status: () => engineStatus(over), isOn: () => over.on !== false, async init() {} });
const fakeScheduler = () => ({ schedule: () => JOBS.map((j) => ({ id: j.id, nextAt: NEXT_AT, retryMs: RETRY_MS })) });

// Row builders. Each row: { name, runs, outbound, setting, engine, sf, pick, state, control, arg, code, cause, api }.
const run = (jobId, status, { errorClass = null, note = null, periodKey = '2026-11-08' } = {}) => ({ jobId, status, errorClass, note, periodKey });
const jobErr = (jobId, errorClass, state, control, arg, extra = {}) => ({
  name: `job ${jobId} error ${errorClass}`, runs: [run(jobId, 'error', { errorClass })], pick: (s) => s.jobs[jobId],
  state, control, arg, code: errorClass, api: true, ...extra,
});
const stop = (code, state, control, arg, extra = {}) => ({
  name: `confirm-guess stopped by ${code}`,
  runs: [run('confirm-guess', 'ok', { note: { batches: 1, items: 2, guessed: 0, stopped: true, stoppedBy: { [code]: true } } })],
  pick: (s) => s.jobs['confirm-guess'], state, control, arg, ...extra,
});
const eng = (name, over, state, control, arg, code, setting) => ({
  name: `engine ${name}`, engine: fakeEngine(over), setting, pick: (s) => s.engine, state, control, arg, code,
});
const sfRow = (status, errorCode, state, control) => ({
  name: `simplefin connection ${status} ${errorCode ?? ''}`.trim(), sf: { status, errorCode }, pick: (s) => s.simplefin, state, control,
});

const ROWS = [
  // Job error classes: transient ones retry with Run now.
  jobErr('simplefin-sync', 'simplefin_network', 'retrying', 'run_job', 'simplefin-sync'),
  jobErr('brief-email', 'email_network', 'retrying', 'run_job', 'brief-email'),
  jobErr('deadline-alerts', 'email_rate_limited', 'retrying', 'run_job', 'deadline-alerts'),
  jobErr('plan', 'store_locked', 'retrying', 'run_job', 'plan'),
  jobErr('freshness', 'TimeoutError', 'retrying', 'run_job', 'freshness'),
  { name: 'job freshness interrupted', runs: [run('freshness', 'interrupted', { errorClass: 'interrupted' })], pick: (s) => s.jobs.freshness,
    state: 'retrying', control: 'run_job', arg: 'freshness', code: 'interrupted', cause: /interrupted/i, api: true },
  // SimpleFIN access problems need a reconnect.
  jobErr('simplefin-sync', 'simplefin_revoked', 'needs_you', 'reconnect'),
  jobErr('simplefin-sync', 'simplefin_payment_required', 'needs_you', 'reconnect'),
  jobErr('simplefin-sync', 'simplefin_auth', 'needs_you', 'reconnect'),
  jobErr('simplefin-sync', 'simplefin_bad_access', 'needs_you', 'reconnect'),
  // Email configuration problems point at the test email.
  jobErr('brief-email', 'email_missing_config', 'needs_you', 'test_email'),
  jobErr('brief-email', 'email_missing_credential', 'needs_you', 'test_email'),
  jobErr('deadline-alerts', 'email_auth', 'needs_you', 'test_email'),
  jobErr('deadline-alerts', 'email_recipient_unverified', 'needs_you', 'test_email'),
  // A code bug needs a person, with Run now as the control.
  jobErr('plan', 'TypeError', 'needs_you', 'run_job', 'plan', { cause: /failed/i }),
  // Skip reasons.
  // A skip while SimpleFIN is paused reads paused while the pause holds (a lifted pause: service-status-recovery).
  { name: 'simplefin-sync skipped while paused', runs: [run('simplefin-sync', 'skipped', { note: { paused: true } })], outbound: { simplefin: false },
    pick: (s) => s.jobs['simplefin-sync'], state: 'paused', control: 'resume', arg: 'simplefin', api: true },
  { name: 'simplefin-sync skipped with no connection', runs: [run('simplefin-sync', 'skipped', { note: { connected: false } })],
    pick: (s) => s.jobs['simplefin-sync'], state: 'healthy', control: null, api: true },
  // Outbound flags.
  { name: 'outbound jobs off pauses every job', outbound: { jobs: false }, pick: (s) => Object.values(s.jobs), all: true,
    state: 'paused', control: 'resume', arg: 'jobs', code: 'paused', nextAttemptAt: null, cause: /paused/i, api: true },
  { name: 'outbound email off', outbound: { email: false }, pick: (s) => s.email, state: 'paused', control: 'resume', arg: 'email', api: true },
  { name: 'outbound simplefin off with a connection', outbound: { simplefin: false }, sf: { status: 'ok', errorCode: null },
    pick: (s) => s.simplefin, state: 'paused', control: 'resume', arg: 'simplefin', api: true },
  { name: 'outbound engine off', outbound: { engine: false }, pick: (s) => s.engine, state: 'paused', control: 'resume', arg: 'engine', code: 'paused', api: true },
  // Engine reasons, in engineReason order.
  eng('setting off', { on: false }, 'paused', 'engine_on', undefined, 'engine_off', { on: false }),
  eng('mode off', { mode: 'off', on: false }, 'paused', 'refresh', undefined, 'not_configured'),
  eng('credential not loaded', { mode: 'live', credentialState: 'failed' }, 'needs_you', 'refresh', undefined, 'credential_unavailable'),
  eng('instance not funded', { mode: 'live', funded: false }, 'needs_you', 'refresh', undefined, 'funding_unavailable'),
  eng('cap reached', { capUsd: 10, spentUsd: 10 }, 'paused', 'cap', undefined, 'funding_exhausted'),
  // Resolver stop causes on the latest confirm-guess run.
  // Each stop reads as current while its cause holds (lifted causes: service-status-recovery).
  stop('engine_paused', 'paused', 'resume', 'engine', { outbound: { engine: false } }),
  stop('engine_off', 'paused', 'engine_on', undefined, { engine: fakeEngine({ on: false }), setting: { on: false } }),
  stop('funding_unavailable', 'needs_you', 'refresh'),
  stop('budget', 'paused', 'cap', undefined, { engine: fakeEngine({ capUsd: 10, spentUsd: 10 }) }),
  // SimpleFIN connection row.
  sfRow('error', 'network', 'retrying', 'sync_now'),
  sfRow('reconnect', 'revoked', 'needs_you', 'reconnect'),
  sfRow('ok', null, 'healthy', null),
];

function ensureJobRows(db) {
  const ins = db.prepare("INSERT OR IGNORE INTO jobs (id, name, cadence, does, cost, next_label, last_label, enabled, sort) VALUES (?, ?, ?, ?, NULL, '', '', 1, ?)");
  JOBS.forEach((j, i) => ins.run(j.id, j.name, j.cadence, j.does, 100 + i));
}

function resetStore(db) {
  db.exec("DELETE FROM job_runs; DELETE FROM simplefin_connection; DELETE FROM email_sends; DELETE FROM settings WHERE key = 'engine'");
}

function seed(db, row) {
  ensureJobRows(db);
  const ins = db.prepare(`INSERT INTO job_runs (job_id, started_at, finished_at, status, period_key, trigger, duration_ms, error_class, cost_usd, note)
    VALUES (?, ?, ?, ?, ?, 'scheduled', 2000, ?, 0, ?)`);
  for (const r of row.runs || []) ins.run(r.jobId, RAN_AT, RAN_END, r.status, r.periodKey, r.errorClass, r.note ? JSON.stringify(r.note) : null);
  if (row.sf) {
    db.prepare(`INSERT INTO simplefin_connection (id, access_blob, connected_at, last_sync_at, status, error_code, messages, accounts)
      VALUES (1, 'synthetic-sealed-blob', '2026-11-01T12:00:00.000Z', ?, ?, ?, '[]', 2)`).run(RAN_END, row.sf.status, row.sf.errorCode);
  }
  if (row.setting) setSetting(db, 'engine', row.setting);
}

const asList = (x) => (Array.isArray(x) ? x : [x]);

// Asserts one service object against its row, then renders it with statusHtml.
function check(svc, row, where) {
  const at = `${row.name} (${where})`;
  assert.ok(svc && typeof svc === 'object', `${at}: a service object`);
  assert.equal(svc.state, row.state, `${at}: state`);
  assert.ok(typeof svc.key === 'string' && svc.key.length, `${at}: key`);
  assert.ok(typeof svc.label === 'string' && svc.label.length, `${at}: label`);
  assert.equal(svc.go, GO[svc.key], `${at}: go for ${svc.key}`);
  if (row.code !== undefined) assert.equal(svc.code, row.code, `${at}: code`);
  if (Object.hasOwn(row, 'nextAttemptAt')) assert.equal(svc.nextAttemptAt, row.nextAttemptAt, `${at}: nextAttemptAt`);
  if (row.state === 'healthy') {
    assert.equal(svc.cause, null, `${at}: healthy has no cause`);
    assert.equal(svc.since, null, `${at}: healthy has no since`);
  } else {
    assert.equal(typeof svc.cause, 'string', `${at}: cause`);
    assert.match(svc.cause, /^[A-Z].{15,}[.]$/s, `${at}: the cause is a plain sentence`);
    assert.notEqual(svc.cause, svc.code, `${at}: the cause is not the raw code`);
    if (svc.code) assert.notEqual(svc.cause.trim(), String(svc.code), `${at}: the cause is not the raw code`);
    if (row.cause) assert.match(svc.cause, row.cause, `${at}: cause wording`);
  }
  if (row.control === null) assert.equal(svc.control, null, `${at}: no control`);
  else {
    assert.ok(svc.control && typeof svc.control === 'object', `${at}: a control`);
    assert.equal(svc.control.id, row.control, `${at}: control id`);
    assert.ok(typeof svc.control.label === 'string' && svc.control.label.length, `${at}: control label`);
    if (row.arg !== undefined) assert.equal(svc.control.arg, row.arg, `${at}: control arg`);
  }
  // The rendered surface.
  view.bind({ esc, api: { s: { live: {} } } });
  const html = view.statusHtml(svc);
  assert.equal(typeof html, 'string', `${at}: statusHtml returns html`);
  assert.ok(html.includes(`data-svc="${esc(svc.key)}"`), `${at}: data-svc`);
  assert.ok(html.includes(`data-svc-state="${row.state}"`), `${at}: data-svc-state`);
  assert.ok(html.includes(view.STATE_LABEL[row.state]), `${at}: the state label`);
  assert.match(html, /Last success/, `${at}: Last success label`);
  assert.match(html, /Next attempt/, `${at}: Next attempt label`);
  if (svc.cause) assert.ok(html.includes(esc(svc.cause)), `${at}: the cause text`);
  const acts = html.match(/data-svc-act="/g) || [];
  if (row.control === null) assert.equal(acts.length, 0, `${at}: no control rendered`);
  else {
    assert.equal(acts.length, 1, `${at}: exactly one control rendered`);
    assert.ok(html.includes(`data-svc-act="${row.control}"`), `${at}: the control rendered`);
    if (svc.control.arg != null) assert.ok(html.includes(`data-svc-arg="${esc(svc.control.arg)}"`), `${at}: the control arg rendered`);
  }
}

test('STATE_LABEL names the four states in plain words', () => {
  assert.deepEqual({ ...view.STATE_LABEL }, { healthy: 'Healthy', retrying: 'Retrying', paused: 'Paused', needs_you: 'Needs you' });
});

test('isTransient: network, rate limit, lock and timeout classes retry; access, config and code bugs do not', () => {
  for (const c of ['simplefin_network', 'simplefin_bad_response', 'email_network', 'email_rate_limited', 'store_locked', 'TimeoutError', 'AbortError', 'synthetic_ECONNRESET'])
    assert.equal(isTransient(c), true, c);
  for (const c of ['simplefin_revoked', 'simplefin_payment_required', 'simplefin_auth', 'simplefin_bad_access', 'email_missing_config',
    'email_missing_credential', 'email_auth', 'email_recipient_unverified', 'TypeError', 'Error', null, undefined, ''])
    assert.equal(isTransient(c), false, String(c));
});

test('every table row maps to a state, a plain cause and an existing control through serviceStatus and statusHtml', async (t) => {
  const store = await tempDb();
  t.after(() => { try { store.db.close(); } catch { /* closed */ } rmSync(store.dataDir, { recursive: true, force: true }); });
  for (const row of ROWS) {
    resetStore(store.db);
    seed(store.db, row);
    const out = await serviceStatus({
      db: store.db, outbound: { ...ALL_ON, ...(row.outbound || {}) }, engine: row.engine ?? fakeEngine(), scheduler: fakeScheduler(), now: new Date(NOW),
    });
    assert.ok(out && typeof out === 'object', `${row.name}: serviceStatus returns an object`);
    for (const k of ['jobs', 'email', 'engine', 'simplefin', 'attention']) assert.ok(Object.hasOwn(out, k), `${row.name}: has ${k}`);
    const picked = asList(row.pick(out));
    if (row.all) assert.deepEqual(Object.keys(out.jobs).sort(), JOBS.map((j) => j.id).sort(), `${row.name}: every scheduled job is listed`);
    for (const svc of picked) check(svc, row, 'serviceStatus');
  }
});

test('job keys are job:<id> and the other services are email, engine and simplefin', async (t) => {
  const store = await tempDb();
  t.after(() => { try { store.db.close(); } catch { /* closed */ } rmSync(store.dataDir, { recursive: true, force: true }); });
  const out = await serviceStatus({ db: store.db, outbound: { ...ALL_ON }, engine: fakeEngine(), scheduler: fakeScheduler(), now: new Date(NOW) });
  for (const j of JOBS) assert.equal(out.jobs[j.id].key, `job:${j.id}`);
  assert.equal(out.email.key, 'email');
  assert.equal(out.engine.key, 'engine');
  assert.equal(out.simplefin.key, 'simplefin');
  for (const svc of [...Object.values(out.jobs), out.email, out.engine, out.simplefin]) assert.equal(svc.state, 'healthy', svc.key);
  assert.equal(out.attention, null, 'nothing needs attention when all is healthy');
  const none = await serviceStatus({ db: store.db, outbound: { ...ALL_ON }, engine: fakeEngine(), scheduler: null, now: new Date(NOW) });
  assert.deepEqual(none.jobs, {}, 'no scheduler lists no jobs');
});

test('job and outbound rows reach GET /api/jobs (listJobs) and the scenario (scenarioOf) for a household', { timeout: 60000 }, async (t) => {
  const instance = await tempInstance();
  const handlers = Object.fromEntries(JOBS.map((j) => [j.id, async () => ({})]));
  const config = { dataDir: instance.dataDir, engine: 'off', clock: '2026-11-08', emailTransport: 'dev' };
  const household = await instance.household(config, { handlers, now: () => new Date(NOW) });
  t.after(async () => {
    try { await household.close(); } catch { /* closed */ }
    instance.close();
    rmSync(instance.dataDir, { recursive: true, force: true });
  });
  const ctx = {
    household, db: household.db, config: household.config, engine: household.engine, scheduler: household.scheduler,
    transport: household.transport, platform: instance.platform, params: {}, body: null,
  };
  const apiRows = ROWS.filter((r) => r.api);
  assert.ok(apiRows.length >= 10, 'job and outbound rows are driven through the API');
  for (const row of apiRows) {
    resetStore(household.db);
    setOutbound(instance.platform, instance.householdId, { ...ALL_ON });
    if (row.outbound) setOutbound(instance.platform, instance.householdId, row.outbound);
    seed(household.db, row);
    const body = await listJobs(ctx);
    assert.ok(body.services && typeof body.services === 'object', `${row.name}: GET /api/jobs carries services`);
    for (const svc of asList(row.pick(body.services))) check(svc, row, 'listJobs');
    const scenario = await scenarioOf(ctx);
    assert.ok(scenario.live.services && typeof scenario.live.services === 'object', `${row.name}: scenario.live.services`);
    for (const svc of asList(row.pick(scenario.live.services))) check(svc, row, 'scenarioOf');
  }
  setOutbound(instance.platform, instance.householdId, { ...ALL_ON });
});
