// Scheduler (src/jobs/scheduler.mjs): period keys in the owner's timezone, due times, one attempt
// per (job, period), catch-up without backfill, the job_lock lease, concurrent runNow refusal,
// job_runs columns (no error message ever stored), triggers of an injected plan handler, the
// fixed clock, jobs() listing, and the default brief-email handler sending with the engine off.
// Every store is a temp migrated store; every clock is injected.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempDb } from '../helpers/server.mjs';
import { openDb, setSetting } from '../../src/store/db.mjs';
import { seedDemo } from '../../demo/seed.mjs';
import { createRuntimeEngine } from '../../src/engine/runtime.mjs';
import { JOBS, localParts, periodKey, createScheduler, SchedulerError, defaultHandlers } from '../../src/jobs/scheduler.mjs';

const NY = 'America/New_York';
const SENSITIVE = 'SENSITIVE-CANARY-4417 owner@example.invalid $9,999';

async function store() {
  const t = await tempDb();
  return { ...t, done() { try { t.db.close(); } catch { /* closed */ } rmSync(t.dataDir, { recursive: true, force: true }); } };
}

const configOf = (dataDir, extra = {}) => ({ dataDir, clock: null, demo: false, engine: 'off', emailTransport: 'dev', publicUrl: null, ...extra });

// A mutable injected clock.
function clockAt(iso) {
  const c = { t: new Date(iso) };
  c.set = (next) => { c.t = new Date(next); };
  c.now = () => new Date(c.t);
  return c;
}

// A handler that counts calls and records each ctx.
function counter(result = {}) {
  const calls = [];
  const fn = async (ctx) => { calls.push(ctx); return result; };
  fn.calls = calls;
  return fn;
}

function captureTransport() {
  const sent = [];
  return { name: 'capture', sent, async send(msg) { sent.push(msg); return { id: `capture-${sent.length}` }; } };
}

const runsOf = (db, jobId) => db.prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY id').all(jobId).map((r) => ({ ...r }));
const keyAt = (jobId, iso, tz = NY) => periodKey(JOBS.find((j) => j.id === jobId).schedule, localParts(new Date(iso), tz));

function schedulerFor(t, { handlers, clock, holder = 'test-holder', config, engine = null, transport = captureTransport(), db = t.db, leaseMs, drainMs } = {}) {
  return createScheduler({
    db, config: config || configOf(t.dataDir), engine, handlers, transport, now: clock.now, tickMs: 3600000, holder,
    ...(leaseMs ? { leaseMs } : {}),
    ...(drainMs ? { drainMs } : {}),
  });
}

test('JOBS defines the plan, brief-email, deadline-alerts, freshness, trash-purge and confirm-guess jobs with a schedule', () => {
  const ids = JOBS.map((j) => j.id);
  for (const id of ['plan', 'brief-email', 'deadline-alerts', 'freshness', 'trash-purge', 'confirm-guess']) assert.ok(ids.includes(id), `JOBS has ${id}`);
  for (const j of JOBS) {
    for (const k of ['id', 'name', 'cadence', 'does', 'schedule']) assert.ok(j[k] != null && j[k] !== '', `${j.id}.${k}`);
  }
});

test('AC4 JOBS defines the daily 03:00 Ask trash cleanup job', () => {
  const job = JOBS.find((j) => j.id === 'trash-purge');
  assert.ok(job, 'JOBS has trash-purge');
  assert.equal(job.name, 'Ask trash cleanup');
  assert.equal(job.cadence, 'Daily, 3:00 AM');
  assert.equal(job.does, 'Delete conversations that have been in Trash for 30 days.');
  assert.deepEqual({ ...job.schedule }, { every: 'day', hour: 3 });
});

test('period keys: monthly brief on the 1st at 07:00 local, daily plan 02:00, daily alerts 07:00, daily trash-purge 03:00, weekly freshness Monday 06:00', () => {
  // America/New_York is UTC-5 in December and after Nov 1 2026.
  assert.equal(keyAt('brief-email', '2026-12-01T11:59:00Z'), '2026-11');
  assert.equal(keyAt('brief-email', '2026-12-01T12:00:00Z'), '2026-12');
  assert.equal(keyAt('brief-email', '2027-01-01T11:59:00Z'), '2026-12', 'year boundary');
  assert.equal(keyAt('brief-email', '2027-01-01T12:00:00Z'), '2027-01');
  assert.equal(keyAt('plan', '2026-11-05T06:59:00Z'), '2026-11-04');
  assert.equal(keyAt('plan', '2026-11-05T07:00:00Z'), '2026-11-05');
  assert.equal(keyAt('deadline-alerts', '2026-11-05T11:59:00Z'), '2026-11-04');
  assert.equal(keyAt('deadline-alerts', '2026-11-05T12:00:00Z'), '2026-11-05');
  assert.equal(keyAt('trash-purge', '2026-11-05T07:59:00Z'), '2026-11-04', 'trash-purge before 03:00 local');
  assert.equal(keyAt('trash-purge', '2026-11-05T08:00:00Z'), '2026-11-05', 'trash-purge at 03:00 local');
  // 2026-11-09 is a Monday; the key is that Monday's date.
  assert.equal(keyAt('freshness', '2026-11-09T10:59:00Z'), '2026-11-02');
  assert.equal(keyAt('freshness', '2026-11-09T11:00:00Z'), '2026-11-09');
  assert.equal(keyAt('freshness', '2026-11-05T12:00:00Z'), '2026-11-02', 'Thursday keys to the Monday before');
});

test('period keys depend on the zone: UTC and Asia/Tokyo differ from New York at the same instant', () => {
  // 11:59 UTC on the 1st is 06:59 in New York (not yet due) but past 07:00 in UTC.
  assert.equal(keyAt('brief-email', '2026-12-01T11:59:00Z', 'UTC'), '2026-12');
  // Tokyo is UTC+9: 07:00 on Dec 1 there is 22:00 UTC on Nov 30.
  assert.equal(keyAt('brief-email', '2026-11-30T21:59:00Z', 'Asia/Tokyo'), '2026-11');
  assert.equal(keyAt('brief-email', '2026-11-30T22:00:00Z', 'Asia/Tokyo'), '2026-12');
});

test('the scheduler reads settings.timezone, defaults to America/New_York and falls back on an invalid zone', async () => {
  const cases = [
    { tz: undefined, now: '2026-12-01T11:59:00Z', want: '2026-11' },
    { tz: undefined, now: '2026-12-01T12:00:00Z', want: '2026-12' },
    { tz: 'Asia/Tokyo', now: '2026-11-30T22:00:00Z', want: '2026-12' },
    { tz: 'Not/AZone', now: '2026-12-01T11:59:00Z', want: '2026-11' },
    { tz: 'Not/AZone', now: '2026-12-01T12:00:00Z', want: '2026-12' },
  ];
  for (const c of cases) {
    const t = await store();
    try {
      if (c.tz) setSetting(t.db, 'timezone', c.tz);
      const h = counter();
      const s = schedulerFor(t, { handlers: { 'brief-email': h }, clock: clockAt(c.now) });
      await s.tick();
      const rows = runsOf(t.db, 'brief-email');
      assert.equal(rows.length, 1, `${c.tz} at ${c.now}`);
      assert.equal(rows[0].period_key, c.want, `${c.tz} at ${c.now}`);
      assert.equal(h.calls[0].periodKey, c.want);
    } finally { t.done(); }
  }
});

test('brief-email is due at 07:00 local on the 1st and not before; local time decides, not UTC midnight', async () => {
  const t = await store();
  try {
    const clock = clockAt('2026-12-01T00:30:00Z'); // Nov 30, 19:30 in New York
    const h = counter();
    const s = schedulerFor(t, { handlers: { 'brief-email': h }, clock });
    await s.tick();
    assert.deepEqual(runsOf(t.db, 'brief-email').map((r) => r.period_key), ['2026-11'], 'past UTC midnight, still November locally');
    clock.set('2026-12-01T11:59:00Z');
    await s.tick();
    assert.equal(h.calls.length, 1, '06:59 local: not yet due');
    clock.set('2026-12-01T12:00:00Z');
    await s.tick();
    assert.deepEqual(runsOf(t.db, 'brief-email').map((r) => r.period_key), ['2026-11', '2026-12']);
    assert.equal(h.calls.length, 2);
  } finally { t.done(); }
});

test('idempotence: two ticks in one period run once; a failed run is not retried that period; the next period runs', async () => {
  const t = await store();
  try {
    const clock = clockAt('2026-11-05T15:00:00Z');
    const ok = counter();
    const s = schedulerFor(t, { handlers: { 'deadline-alerts': ok }, clock });
    await s.tick();
    await s.tick();
    assert.equal(ok.calls.length, 1);
    assert.equal(runsOf(t.db, 'deadline-alerts').length, 1);

    const t2 = await store();
    try {
      let calls = 0;
      const failing = async () => { calls += 1; const e = new Error(SENSITIVE); e.code = 'E_SYNTH'; throw e; };
      const c2 = clockAt('2026-11-05T15:00:00Z');
      const s2 = schedulerFor(t2, { handlers: { 'deadline-alerts': failing }, clock: c2 });
      await s2.tick();
      await s2.tick();
      assert.equal(calls, 1, 'failed period is not retried');
      const rows = runsOf(t2.db, 'deadline-alerts');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'error');
      c2.set('2026-11-06T15:00:00Z');
      await s2.tick();
      assert.equal(calls, 2, 'the next period runs');
      assert.deepEqual(runsOf(t2.db, 'deadline-alerts').map((r) => r.period_key), ['2026-11-05', '2026-11-06']);
    } finally { t2.done(); }
  } finally { t.done(); }
});

test('catch-up: after several missed periods one tick runs exactly once, for the latest period', async () => {
  const t = await store();
  try {
    const clock = clockAt('2026-11-01T15:00:00Z');
    const daily = counter();
    const monthly = counter();
    const s = schedulerFor(t, { handlers: { 'deadline-alerts': daily, 'brief-email': monthly }, clock });
    await s.tick();
    clock.set('2027-02-10T15:00:00Z'); // many days and three months missed
    await s.tick();
    await s.tick();
    assert.deepEqual(runsOf(t.db, 'deadline-alerts').map((r) => r.period_key), ['2026-11-01', '2027-02-10']);
    assert.deepEqual(runsOf(t.db, 'brief-email').map((r) => r.period_key), ['2026-11', '2027-02']);
    assert.equal(daily.calls.length, 2);
    assert.equal(monthly.calls.length, 2);
  } finally { t.done(); }
});

test('lock: only the lease holder runs; runNow on the other is locked; an expired lease is taken over', async () => {
  const t = await store();
  const dbB = openDb(t.file);
  try {
    const clockA = clockAt('2026-11-05T15:00:00Z');
    const clockB = clockAt('2026-11-05T15:00:00Z');
    const a = counter();
    const b = counter();
    const sa = schedulerFor(t, { handlers: { freshness: a }, clock: clockA, holder: 'holder-a' });
    const sb = schedulerFor(t, { handlers: { 'brief-email': b }, clock: clockB, holder: 'holder-b', db: dbB });
    await sa.tick();
    assert.equal(a.calls.length, 1, 'the first scheduler takes the lease and runs');
    await sb.tick();
    assert.equal(b.calls.length, 0, 'the second scheduler has no lease and runs nothing');
    assert.equal(runsOf(t.db, 'brief-email').length, 0);
    await assert.rejects(() => sb.runNow('brief-email'), (e) => e instanceof SchedulerError && e.code === 'locked');
    assert.equal(b.calls.length, 0);

    clockB.set(new Date(clockB.t.getTime() + 6 * 60000)); // past the 5 minute lease
    await sb.tick();
    assert.equal(b.calls.length, 1, 'expired lease is taken over');
    assert.equal(dbB.prepare('SELECT holder FROM job_lock').get().holder, 'holder-b');
    await assert.rejects(() => sa.runNow('freshness'), (e) => e instanceof SchedulerError && e.code === 'locked');
  } finally {
    dbB.close();
    t.done();
  }
});

test('concurrent runNow of the same job is refused with code running and yields one job_runs row', async () => {
  const t = await store();
  try {
    let release;
    let entered;
    const gate = new Promise((r) => { release = r; });
    const started = new Promise((r) => { entered = r; });
    const slow = async () => { entered(); await gate; return {}; };
    const s = schedulerFor(t, { handlers: { freshness: slow }, clock: clockAt('2026-11-05T15:00:00Z') });
    const first = s.runNow('freshness');
    await started;
    await assert.rejects(() => s.runNow('freshness'), (e) => e instanceof SchedulerError && e.code === 'running');
    release();
    await first;
    const rows = runsOf(t.db, 'freshness');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'ok');
    // Liveness: once finished, another manual run is accepted.
    await s.runNow('freshness');
    assert.equal(runsOf(t.db, 'freshness').length, 2);
  } finally { t.done(); }
});

test('job_runs rows carry status, period_key, trigger, duration_ms and an identifier-only error_class', async () => {
  const t = await store();
  try {
    class SyntheticFailure extends Error {}
    const handlers = {
      'brief-email': async () => ({ costUsd: 0, note: JSON.stringify({ sent: 1 }) }),
      'deadline-alerts': async () => { const e = new Error(SENSITIVE); e.code = 'E_SYNTH'; throw e; },
      freshness: async () => { throw new SyntheticFailure(SENSITIVE); },
      plan: async () => ({ status: 'skipped' }),
    };
    const s = schedulerFor(t, { handlers, clock: clockAt('2026-11-09T15:00:00Z') });
    await s.tick();
    const all = t.db.prepare('SELECT * FROM job_runs ORDER BY id').all().map((r) => ({ ...r }));
    assert.equal(all.length, 4);
    const by = Object.fromEntries(all.map((r) => [r.job_id, r]));
    assert.equal(by['brief-email'].status, 'ok');
    assert.equal(by['deadline-alerts'].status, 'error');
    assert.equal(by.freshness.status, 'error');
    assert.equal(by.plan.status, 'skipped');
    assert.equal(by['deadline-alerts'].error_class, 'E_SYNTH');
    assert.match(by.freshness.error_class, /^[A-Za-z_][A-Za-z0-9_]*$/);
    assert.equal(by['brief-email'].error_class, null);
    for (const r of all) {
      assert.equal(r.trigger, 'scheduled');
      assert.ok(Number.isInteger(r.duration_ms) && r.duration_ms >= 0, `${r.job_id} duration_ms`);
      assert.ok(r.finished_at, `${r.job_id} finished_at`);
      assert.ok(r.period_key, `${r.job_id} period_key`);
      for (const [col, v] of Object.entries(r)) {
        assert.ok(!String(v ?? '').includes('SENSITIVE-CANARY'), `job_runs.${col} carries no error message`);
        assert.ok(!String(v ?? '').includes('owner@example.invalid'), `job_runs.${col} carries no address`);
      }
    }
  } finally { t.done(); }
});

test('unknown job id is unknown_job; jobs() lists only jobs with a handler; trigger without a handler is a no-op', async () => {
  const t = await store();
  try {
    const s = schedulerFor(t, { handlers: { freshness: counter() }, clock: clockAt('2026-11-05T15:00:00Z') });
    await assert.rejects(() => s.runNow('no-such-job'), (e) => e instanceof SchedulerError && e.code === 'unknown_job');
    await s.tick();
    assert.deepEqual(s.jobs().map((j) => j.id), ['freshness']);
    await s.trigger('plan', 'ingest');
    assert.equal(runsOf(t.db, 'plan').length, 0, 'no plan handler: nothing runs');
    assert.ok(t.db.prepare("SELECT 1 AS x FROM jobs WHERE id = 'freshness'").get(), 'ensureJobs wrote the jobs row');
  } finally { t.done(); }
});

test('plan handler: scheduled, manual and ingest triggers each run through the scheduler with the lock held', async () => {
  const t = await store();
  try {
    const seen = [];
    const plan = async (ctx) => {
      const lock = t.db.prepare('SELECT holder FROM job_lock').get();
      seen.push({ trigger: ctx.trigger, periodKey: ctx.periodKey, jobRunId: ctx.jobRunId, holder: lock && lock.holder });
      return {};
    };
    const clock = clockAt('2026-11-05T15:00:00Z');
    const s = schedulerFor(t, { handlers: { plan }, clock, holder: 'plan-holder' });
    await s.tick();
    clock.set('2026-11-05T15:01:00Z');
    await s.runNow('plan');
    clock.set('2026-11-05T15:02:00Z');
    await s.trigger('plan', 'ingest');
    for (let i = 0; i < 50 && runsOf(t.db, 'plan').length < 3; i++) await new Promise((r) => setTimeout(r, 20));
    const rows = runsOf(t.db, 'plan');
    assert.equal(rows.length, 3, 'one job_runs row per trigger');
    assert.deepEqual(rows.map((r) => r.trigger), ['scheduled', 'manual', 'ingest']);
    assert.equal(rows[0].period_key, '2026-11-05');
    assert.match(rows[1].period_key, /^manual:\d{4}-\d{2}-\d{2}T/);
    assert.match(rows[2].period_key, /^ingest:\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(seen.map((x) => x.holder), ['plan-holder', 'plan-holder', 'plan-holder'], 'lock held for every trigger');
    assert.deepEqual(seen.map((x) => x.jobRunId), rows.map((r) => r.id), 'ctx.jobRunId is the scheduler row');
    assert.ok(rows.every((r) => r.status === 'ok'));
  } finally { t.done(); }
});

// A plan handler whose runs wait on a promise the test resolves.
function gatedPlan() {
  const g = { started: [], gates: [], release(i = g.gates.length - 1) { g.gates[i](); } };
  g.handler = async (ctx) => {
    g.started.push(ctx.trigger);
    await new Promise((r) => { g.gates.push(r); });
    return {};
  };
  return g;
}
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

test('trigger when idle runs immediately', async () => {
  const t = await store();
  try {
    const plan = counter();
    const s = schedulerFor(t, { handlers: { plan }, clock: clockAt('2026-11-05T15:00:00Z') });
    const run = await s.trigger('plan', 'ingest');
    assert.equal(run.trigger, 'ingest');
    assert.equal(plan.calls.length, 1);
  } finally { t.done(); }
});

test('trigger during a plan run queues exactly one ingest rerun after it finishes', async () => {
  const t = await store();
  try {
    const g = gatedPlan();
    const clock = clockAt('2026-11-05T15:00:00Z');
    const s = schedulerFor(t, { handlers: { plan: g.handler }, clock });
    const first = s.runNow('plan');
    await settle();
    assert.deepEqual(g.started, ['manual']);
    const queued = s.trigger('plan', 'ingest');
    await assert.doesNotReject(queued);
    clock.set('2026-11-05T15:00:05Z');
    await settle();
    assert.deepEqual(g.started, ['manual'], 'the rerun waits for the current run');
    g.release(0);
    await first;
    for (let i = 0; i < 50 && g.started.length < 2; i++) await settle(20);
    assert.deepEqual(g.started, ['manual', 'ingest'], 'one ingest rerun starts after the run finishes');
    g.release(1);
    await settle();
    assert.equal(g.started.length, 2, 'no further run');
    const rows = runsOf(t.db, 'plan');
    assert.deepEqual(rows.map((r) => r.trigger), ['manual', 'ingest']);
    assert.ok(rows.every((r) => r.status === 'ok'));
  } finally { t.done(); }
});

test('several triggers during one plan run coalesce into a single rerun; trigger never rejects', async () => {
  const t = await store();
  try {
    const g = gatedPlan();
    const clock = clockAt('2026-11-05T15:00:00Z');
    const s = schedulerFor(t, { handlers: { plan: g.handler }, clock });
    const first = s.trigger('plan', 'ingest');
    await settle();
    assert.deepEqual(g.started, ['ingest']);
    const extra = [s.trigger('plan', 'ingest'), s.trigger('plan', 'ingest'), s.trigger('plan', 'ingest')];
    clock.set('2026-11-05T15:00:05Z');
    g.release(0);
    await first;
    for (let i = 0; i < 50 && g.started.length < 2; i++) await settle(20);
    assert.deepEqual(g.started, ['ingest', 'ingest'], 'exactly one more run');
    g.release(1);
    await Promise.all(extra.map((p) => assert.doesNotReject(p)));
    await settle(80);
    assert.equal(g.started.length, 2, 'the coalesced triggers did not add runs');
    assert.equal(runsOf(t.db, 'plan').length, 2);
  } finally { t.done(); }
});

test('fixed clock: config.clock makes every period of that date due, whatever now says', async () => {
  const t = await store();
  try {
    const handlers = { 'brief-email': counter(), 'deadline-alerts': counter(), freshness: counter(), plan: counter(), 'trash-purge': counter() };
    const s = schedulerFor(t, { handlers, clock: clockAt('2020-01-01T00:00:00Z'), config: configOf(t.dataDir, { clock: '2026-11-05' }) });
    await s.tick();
    const keys = Object.fromEntries(t.db.prepare('SELECT job_id, period_key FROM job_runs').all().map((r) => [r.job_id, r.period_key]));
    assert.deepEqual(keys, { 'brief-email': '2026-11', 'deadline-alerts': '2026-11-05', freshness: '2026-11-02', plan: '2026-11-05', 'trash-purge': '2026-11-05' });
    assert.equal(handlers['brief-email'].calls[0].clock, '2026-11-05', 'ctx.clock is the fixed date');
  } finally { t.done(); }
});

test('jobs() returns lastRun and next for each handled job; runs() lists recent runs', async () => {
  const t = await store();
  try {
    const s = schedulerFor(t, { handlers: { 'brief-email': counter(), freshness: counter() }, clock: clockAt('2026-11-05T15:00:00Z') });
    const before = s.jobs();
    assert.deepEqual(before.map((j) => j.id).sort(), ['brief-email', 'freshness']);
    for (const j of before) assert.ok(!j.lastRun, `${j.id} has no last run yet`);
    await s.tick();
    for (const j of s.jobs()) {
      for (const k of ['name', 'cadence', 'does']) assert.equal(typeof j[k], 'string', `${j.id}.${k}`);
      assert.ok(j.lastRun, `${j.id} lastRun after a run`);
      assert.equal(typeof j.next, 'string');
      assert.ok(j.next.length > 0, `${j.id} next label`);
      assert.ok(Date.parse(j.nextAt) > Date.parse('2026-11-05T15:00:00Z'), `${j.id} nextAt is after now`);
    }
    const brief = s.jobs().find((j) => j.id === 'brief-email');
    assert.equal(new Date(brief.nextAt).toISOString(), '2026-12-01T12:00:00.000Z', 'next brief: Dec 1 07:00 New York');
    assert.equal(s.runs({ limit: 1 }).length, 1);
    assert.equal(s.runs({ limit: 10 }).length, 2);
  } finally { t.done(); }
});

test('start() and stop() leave no timer running', async () => {
  const t = await store();
  try {
    const s = schedulerFor(t, { handlers: { freshness: counter() }, clock: clockAt('2026-11-05T15:00:00Z') });
    s.start();
    s.stop();
  } finally { t.done(); }
});

test('engine off: the default brief-email handler still sends the brief through the transport', async () => {
  const t = await store();
  try {
    seedDemo(t.db);
    setSetting(t.db, 'engine', { on: false });
    const config = configOf(t.dataDir, { clock: '2026-11-05', engine: 'fake', demo: true });
    const engine = createRuntimeEngine({ db: t.db, config });
    await engine.init();
    const spendBefore = t.db.prepare('SELECT count(*) AS n FROM spend_ledger').get().n;
    const transport = captureTransport();
    const handlers = defaultHandlers({ publicUrl: null });
    assert.deepEqual(Object.keys(handlers).sort(), ['brief-email', 'confirm-guess', 'deadline-alerts', 'freshness', 'plan', 'simplefin-sync', 'trash-purge']);
    const s = schedulerFor(t, { handlers, clock: clockAt('2026-11-05T15:00:00Z'), config, engine, transport });
    await s.runNow('brief-email');
    assert.equal(transport.sent.length, 1, 'the brief went out');
    const msg = transport.sent[0];
    for (const k of ['subject', 'text', 'html']) assert.ok(typeof msg[k] === 'string' && msg[k].length > 0, k);
    const rows = runsOf(t.db, 'brief-email');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'ok');
    const send = t.db.prepare("SELECT * FROM email_sends WHERE kind = 'brief'").all();
    assert.equal(send.length, 1);
    assert.equal(send[0].status, 'sent');
    assert.equal(t.db.prepare('SELECT count(*) AS n FROM spend_ledger').get().n, spendBefore, 'no model spend with the engine off');
  } finally { t.done(); }
});

const realClock = { now: () => new Date() };
const lockRow = (db) => db.prepare('SELECT holder FROM job_lock').get();
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} still pending after ${ms}ms`)), ms))]);

test('ensureJobs inserts a jobs row for every JOBS entry via tick, start and jobs(), while jobs() lists only handled jobs', async () => {
  for (const how of ['tick', 'start', 'jobs']) {
    const t = await store();
    try {
      const s = schedulerFor(t, { handlers: { freshness: counter() }, clock: clockAt('2026-11-05T15:00:00Z') });
      if (how === 'tick') await s.tick();
      if (how === 'start') {
        s.start();
        for (let i = 0; i < 50 && t.db.prepare('SELECT count(*) AS n FROM jobs').get().n < JOBS.length; i++) await settle(20);
      }
      if (how === 'jobs') s.jobs();
      const ids = t.db.prepare('SELECT id FROM jobs').all().map((r) => r.id).sort();
      assert.deepEqual(ids, JOBS.map((j) => j.id).sort(), `${how}: every JOBS entry has a row, plan included`);
      assert.deepEqual(s.jobs().map((j) => j.id), ['freshness'], `${how}: jobs() lists only handled jobs`);
      await s.stop();
    } finally { t.done(); }
  }
});

test('lease renewal: a long run keeps the lock past leaseMs so a second scheduler cannot take it; then liveness after stop', async () => {
  const t = await store();
  const dbB = openDb(t.file);
  try {
    const leaseMs = 200;
    const g = gatedPlan();
    const plan = counter();
    const sa = schedulerFor(t, { handlers: { plan: g.handler }, clock: realClock, holder: 'holder-a', leaseMs });
    const sb = schedulerFor(t, { handlers: { plan }, clock: realClock, holder: 'holder-b', db: dbB, leaseMs });
    const first = sa.runNow('plan');
    await settle(30);
    assert.equal(g.started.length, 1);
    await settle(leaseMs * 3);
    await assert.rejects(() => sb.runNow('plan'), (e) => e instanceof SchedulerError && e.code === 'locked');
    await sb.tick();
    assert.equal(plan.calls.length, 0, 'the second scheduler ran nothing');
    assert.equal(lockRow(dbB).holder, 'holder-a');
    g.release(0);
    await first;
    await sa.stop();
    const run = await sb.runNow('plan');
    assert.equal(run.status, 'ok', 'liveness: the second scheduler runs once the first is done');
    assert.equal(plan.calls.length, 1);
  } finally {
    dbB.close();
    t.done();
  }
});

test('stop() waits for the running handler and its final job_runs row before releasing the lease', async () => {
  const t = await store();
  try {
    const g = gatedPlan();
    const other = counter();
    const s = schedulerFor(t, { handlers: { plan: g.handler, freshness: other }, clock: realClock, holder: 'stop-holder', leaseMs: 60000, drainMs: 5000 });
    const first = s.runNow('plan');
    await settle(30);
    assert.equal(g.started.length, 1);
    const queued = await s.trigger('plan', 'ingest');
    assert.equal(queued, null);
    let resolved = false;
    const stopping = s.stop().then(() => { resolved = true; });
    await settle(150);
    assert.equal(resolved, false, 'stop is pending while the handler runs');
    assert.equal(runsOf(t.db, 'plan')[0].status, 'running');
    assert.equal(lockRow(t.db).holder, 'stop-holder', 'the lease is held until the handler finishes');
    await s.tick();
    assert.equal(other.calls.length, 0, 'tick runs nothing after stop begins');
    await assert.rejects(() => s.runNow('freshness'), (e) => e instanceof SchedulerError && e.code === 'locked');
    g.release(0);
    await withTimeout(stopping, 2000, 'stop');
    await first;
    const rows = runsOf(t.db, 'plan');
    assert.equal(rows[0].status, 'ok');
    assert.ok(rows[0].finished_at, 'finished_at set');
    assert.equal(t.db.prepare("SELECT count(*) AS n FROM job_lock WHERE holder = 'stop-holder'").get().n, 0, 'lease released');
    await settle(100);
    assert.equal(g.started.length, 1, 'the queued rerun was dropped');
    assert.equal(runsOf(t.db, 'plan').length, 1);
  } finally { t.done(); }
});

test('stop() is bounded by drainMs: a handler that never finishes does not hold it, and the lease is released', async () => {
  const t = await store();
  try {
    const hung = async () => { await new Promise(() => {}); };
    const s = schedulerFor(t, { handlers: { plan: hung }, clock: realClock, holder: 'hung-holder', leaseMs: 60000, drainMs: 100 });
    s.runNow('plan').catch(() => {});
    await settle(30);
    assert.equal(lockRow(t.db).holder, 'hung-holder');
    await withTimeout(s.stop(), 2000, 'stop');
    assert.equal(lockRow(t.db), undefined, 'lease released after the drain timeout');
  } finally { t.done(); }
});

test('stop() with nothing running resolves promptly and releases the lease', async () => {
  const t = await store();
  try {
    const s = schedulerFor(t, { handlers: { freshness: counter() }, clock: realClock, holder: 'idle-holder', leaseMs: 60000 });
    await s.runNow('freshness');
    assert.equal(lockRow(t.db).holder, 'idle-holder');
    await withTimeout(s.stop(), 500, 'stop');
    assert.equal(lockRow(t.db), undefined);
  } finally { t.done(); }
});
