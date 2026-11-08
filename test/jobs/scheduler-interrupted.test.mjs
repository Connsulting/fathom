// H2 AC3: a job_runs row left `running` by a holder that died is recovered: the next tick that
// holds the lease marks it interrupted (finished_at set, error_class interrupted), the service reads
// retrying with an interrupted cause, and after retryMs the job runs again (`<period>+retry`) and
// reads healthy. A run still in flight in this process, or under a live lease held elsewhere, is
// never marked interrupted. Every store is a temp migrated store; every clock is injected.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempDb } from '../helpers/server.mjs';
import { JOBS, localParts, periodKey, createScheduler } from '../../src/jobs/scheduler.mjs';
import { serviceStatus } from '../../src/jobs/service-status.mjs';

const NY = 'America/New_York';
const RETRY_MS = 15 * 60000;
const MIN = 60000;
const ALL_ON = Object.freeze({ jobs: true, email: true, simplefin: true, engine: true });
const quiet = { log() {}, info() {}, warn() {}, error() {} };
const JOB = 'deadline-alerts';
// 10:00 in New York: deadline-alerts (due 07:00 local) is due for 2026-11-05.
const NOW = '2026-11-05T15:00:00.000Z';
const STALE_START = '2026-11-05T12:00:30.000Z';
const STALE_LEASE = '2026-11-05T12:05:30.000Z';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise((r) => setImmediate(r));

async function store() {
  const t = await tempDb();
  return { ...t, done() { try { t.db.close(); } catch { /* closed */ } rmSync(t.dataDir, { recursive: true, force: true }); } };
}

function clockAt(iso) {
  const c = { t: new Date(iso) };
  c.advance = (ms) => { c.t = new Date(c.t.getTime() + ms); };
  c.now = () => new Date(c.t);
  return c;
}

const runsOf = (db, jobId) => db.prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY id').all(jobId).map((r) => ({ ...r }));
const keyAt = (jobId, iso) => periodKey(JOBS.find((j) => j.id === jobId).schedule, localParts(new Date(iso), NY));

function schedulerFor(t, { handlers, clock, holder = 'holder-new' }) {
  return createScheduler({
    db: t.db, config: { dataDir: t.dataDir, clock: null, engine: 'off', emailTransport: 'dev', publicUrl: null },
    engine: null, handlers, transport: null, now: clock.now, tickMs: 3600000, holder, retryMs: RETRY_MS, log: quiet,
  });
}

function ensureJobRows(db) {
  const ins = db.prepare("INSERT OR IGNORE INTO jobs (id, name, cadence, does, cost, next_label, last_label, enabled, sort) VALUES (?, ?, ?, ?, NULL, '', '', 1, ?)");
  JOBS.forEach((j, i) => ins.run(j.id, j.name, j.cadence, j.does, 100 + i));
}

// A run claimed by a holder that died: running, never finished, its lease long expired.
function abandoned(db, { leaseExpires = STALE_LEASE, holder = 'holder-dead' } = {}) {
  ensureJobRows(db);
  const id = db.prepare(`INSERT INTO job_runs (job_id, started_at, status, period_key, trigger) VALUES (?, ?, 'running', ?, 'scheduled') RETURNING id`)
    .get(JOB, STALE_START, keyAt(JOB, NOW)).id;
  db.prepare('INSERT INTO job_lock (id, holder, expires_at) VALUES (1, ?, ?)').run(holder, leaseExpires);
  return id;
}

const statusOf = (t, s, clock) => serviceStatus({ db: t.db, outbound: { ...ALL_ON }, engine: null, scheduler: s, now: clock.now() });

test('an abandoned running row is marked interrupted, reads retrying, then runs again and reads healthy', async () => {
  const t = await store();
  try {
    const clock = clockAt(NOW);
    const id = abandoned(t.db);
    let calls = 0;
    const s = schedulerFor(t, { handlers: { [JOB]: async () => { calls += 1; return { note: { alerts: 0 } }; } }, clock });

    await s.tick();
    const row = t.db.prepare('SELECT * FROM job_runs WHERE id = ?').get(id);
    assert.equal(row.status, 'interrupted', 'the abandoned row is interrupted');
    assert.equal(row.error_class, 'interrupted');
    assert.ok(row.finished_at, 'finished_at is set');
    assert.ok(Date.parse(row.finished_at) >= Date.parse(STALE_START));
    assert.equal(t.db.prepare('SELECT holder FROM job_lock WHERE id = 1').get().holder, 'holder-new', 'the tick holds the lease');

    const svc = (await statusOf(t, s, clock)).jobs[JOB];
    assert.equal(svc.state, 'retrying', 'the interrupted run is visible as retrying');
    assert.equal(svc.code, 'interrupted');
    assert.match(svc.cause, /interrupted/i);
    assert.equal(svc.control?.id, 'run_job');
    assert.equal(svc.control?.arg, JOB);
    assert.ok(svc.nextAttemptAt, 'the next automatic attempt is named');

    clock.advance(RETRY_MS + MIN);
    await s.tick();
    const rows = runsOf(t.db, JOB);
    assert.equal(rows.length, 2, 'the job runs again once');
    assert.equal(rows[1].period_key, `${keyAt(JOB, NOW)}+retry`);
    assert.equal(rows[1].trigger, 'retry');
    assert.equal(rows[1].status, 'ok');
    assert.equal(calls, 1);
    const after = (await statusOf(t, s, clock)).jobs[JOB];
    assert.equal(after.state, 'healthy');
    assert.equal(after.cause, null);
  } finally { t.done(); }
});

test('a run still in flight in this process is not marked interrupted by a tick', async () => {
  const t = await store();
  try {
    const clock = clockAt(NOW);
    const gate = deferred();
    let started = 0;
    const s = schedulerFor(t, { handlers: { [JOB]: async () => { started += 1; await gate.promise; return {}; } }, clock });
    const manual = s.runNow(JOB);
    for (let i = 0; i < 50 && !started; i++) await turn();
    assert.equal(started, 1, 'the manual run is in its handler');
    const mine = runsOf(t.db, JOB);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].status, 'running');

    clock.advance(MIN);
    await s.tick();
    const during = t.db.prepare('SELECT * FROM job_runs WHERE id = ?').get(mine[0].id);
    assert.equal(during.status, 'running', 'this process\'s own run is not interrupted');
    assert.equal(during.error_class, null);
    assert.equal(runsOf(t.db, JOB).length, 1, 'the tick skips a job already running here');

    gate.resolve();
    const done = await manual;
    assert.equal(done.status, 'ok');
    assert.equal(t.db.prepare('SELECT status FROM job_runs WHERE id = ?').get(mine[0].id).status, 'ok');
  } finally { t.done(); }
});

test('a running row under a live lease held by another holder is left alone', async () => {
  const t = await store();
  try {
    const clock = clockAt(NOW);
    const id = abandoned(t.db, { holder: 'holder-alive', leaseExpires: '2026-11-05T15:04:00.000Z' });
    const s = schedulerFor(t, { handlers: { [JOB]: async () => ({}) }, clock });
    await s.tick();
    assert.equal(t.db.prepare('SELECT status FROM job_runs WHERE id = ?').get(id).status, 'running', 'no lease, no recovery');
    assert.equal(runsOf(t.db, JOB).length, 1);
  } finally { t.done(); }
});
