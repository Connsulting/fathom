// H2 AC2: a transient job failure retries once after retryMs (key `<period>+retry`, trigger retry)
// and the service reads retrying, then healthy. A failed retry, a non-transient failure, a paused
// household and a skipped paused run are never retried. SQLite busy and locked errors are
// recorded as store_locked. Every store is a temp migrated store; every clock is injected.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempDb } from '../helpers/server.mjs';
import { JOBS, localParts, periodKey, nextRunAt, createScheduler, JobFailure } from '../../src/jobs/scheduler.mjs';
import { serviceStatus } from '../../src/jobs/service-status.mjs';

const NY = 'America/New_York';
const RETRY_MS = 15 * 60000;
const MIN = 60000;
const ALL_ON = Object.freeze({ jobs: true, email: true, simplefin: true, engine: true });
const quiet = { log() {}, info() {}, warn() {}, error() {} };

async function store() {
  const t = await tempDb();
  return { ...t, async done() { try { await t.db.close(); } catch { /* closed */ } rmSync(t.dataDir, { recursive: true, force: true }); } };
}

const configOf = (dataDir) => ({ dataDir, clock: null, demo: false, engine: 'off', emailTransport: 'dev', publicUrl: null });

function clockAt(iso) {
  const c = { t: new Date(iso) };
  c.set = (next) => { c.t = new Date(next); };
  c.advance = (ms) => { c.t = new Date(c.t.getTime() + ms); };
  c.now = () => new Date(c.t);
  return c;
}

const runsOf = async (db, jobId) => (await db.prepare('SELECT * FROM job_runs WHERE job_id = ? ORDER BY id').all(jobId)).map((r) => ({ ...r }));
const keyAt = (jobId, iso) => periodKey(JOBS.find((j) => j.id === jobId).schedule, localParts(new Date(iso), NY));

function schedulerFor(t, { handlers, clock, holder = 'test-holder', allowed, retryMs = RETRY_MS } = {}) {
  return createScheduler({
    db: t.db, config: configOf(t.dataDir), engine: null, handlers, transport: null, now: clock.now, tickMs: 3600000, holder, log: quiet,
    ...(allowed ? { allowed } : {}),
    ...(retryMs != null ? { retryMs } : {}),
  });
}

const statusOf = async (t, s, clock, outbound = ALL_ON) => await serviceStatus({ db: t.db, outbound: { ...outbound }, engine: null, scheduler: s, now: clock.now() });

// 10:00 in New York: simplefin-sync (due 05:00 local) is due for 2026-11-05.
const START = '2026-11-05T15:00:00.000Z';

test('schedule() lists handled jobs with their next run and retryMs and writes nothing', async () => {
  const t = await store();
  try {
    const clock = clockAt(START);
    const s = schedulerFor(t, { handlers: { 'simplefin-sync': async () => ({}), plan: async () => ({}) }, clock });
    const out = s.schedule();
    assert.deepEqual(out.map((x) => x.id).sort(), ['plan', 'simplefin-sync']);
    for (const x of out) {
      const job = JOBS.find((j) => j.id === x.id);
      assert.equal(new Date(x.nextAt).toISOString(), nextRunAt(job.schedule, clock.now(), NY).toISOString(), `${x.id} nextAt`);
      assert.equal(x.retryMs, RETRY_MS, `${x.id} retryMs`);
    }
    assert.equal((await t.db.prepare('SELECT count(*) AS n FROM jobs').get()).n, 0, 'schedule() writes no job rows');
    assert.equal((await t.db.prepare('SELECT count(*) AS n FROM job_runs').get()).n, 0, 'schedule() claims nothing');
    const d = schedulerFor(t, { handlers: { plan: async () => ({}) }, clock, retryMs: null });
    assert.equal(d.schedule()[0].retryMs, 15 * MIN, 'retryMs defaults to 15 minutes');
  } finally { await t.done(); }
});

test('a transient failure retries once after retryMs and reads retrying, then healthy', async () => {
  const t = await store();
  try {
    const clock = clockAt(START);
    let calls = 0;
    const handler = async () => { calls += 1; if (calls === 1) throw new JobFailure('simplefin_network'); return { note: {} }; };
    const s = schedulerFor(t, { handlers: { 'simplefin-sync': handler }, clock });
    const key = keyAt('simplefin-sync', START);

    await s.tick();
    let rows = await runsOf(t.db, 'simplefin-sync');
    assert.equal(rows.length, 1, 'tick 1 records one run');
    assert.equal(rows[0].status, 'error');
    assert.equal(rows[0].error_class, 'simplefin_network');
    assert.equal(rows[0].period_key, key);

    let svc = (await statusOf(t, s, clock)).jobs['simplefin-sync'];
    assert.equal(svc.state, 'retrying');
    assert.equal(svc.code, 'simplefin_network');
    assert.equal(svc.nextAttemptAt, new Date(Date.parse(rows[0].finished_at) + RETRY_MS).toISOString(), 'next attempt is finished_at + retryMs');
    assert.ok(svc.since, 'a retrying service carries since');

    clock.advance(RETRY_MS - MIN);
    await s.tick();
    assert.equal((await runsOf(t.db, 'simplefin-sync')).length, 1, 'no retry before retryMs elapses');
    assert.equal(calls, 1);

    clock.advance(2 * MIN);
    await s.tick();
    rows = await runsOf(t.db, 'simplefin-sync');
    assert.equal(rows.length, 2, 'exactly one retry after retryMs');
    assert.equal(rows[1].period_key, `${key}+retry`);
    assert.equal(rows[1].trigger, 'retry');
    assert.equal(rows[1].status, 'ok');
    assert.equal(calls, 2);

    svc = (await statusOf(t, s, clock)).jobs['simplefin-sync'];
    assert.equal(svc.state, 'healthy');
    assert.equal(svc.cause, null);
    assert.equal(svc.since, null);
    assert.ok([rows[1].started_at, rows[1].finished_at].includes(svc.lastSuccessAt), 'lastSuccessAt is the ok retry');

    clock.advance(RETRY_MS * 4);
    await s.tick();
    assert.equal((await runsOf(t.db, 'simplefin-sync')).length, 2, 'a successful retry is not run again');
  } finally { await t.done(); }
});

test('a retry that also fails is not retried again in the same period', async () => {
  const t = await store();
  try {
    const clock = clockAt(START);
    let calls = 0;
    const s = schedulerFor(t, { handlers: { 'simplefin-sync': async () => { calls += 1; throw new JobFailure('simplefin_network'); } }, clock });
    await s.tick();
    clock.advance(RETRY_MS + MIN);
    await s.tick();
    let rows = await runsOf(t.db, 'simplefin-sync');
    assert.equal(rows.length, 2);
    assert.equal(rows[1].status, 'error');
    assert.match(rows[1].period_key, /\+retry$/);
    clock.advance(RETRY_MS + MIN);
    await s.tick();
    clock.advance(RETRY_MS * 4);
    await s.tick();
    rows = await runsOf(t.db, 'simplefin-sync');
    assert.equal(rows.length, 2, 'the failed retry is never retried');
    assert.equal(calls, 2);
    assert.ok(rows.every((r) => !/\+retry\+retry/.test(r.period_key)));
  } finally { await t.done(); }
});

test('a non-transient failure (a code bug) is never retried and needs a person', async () => {
  const t = await store();
  try {
    const clock = clockAt(START);
    let calls = 0;
    const s = schedulerFor(t, { handlers: { 'simplefin-sync': async () => { calls += 1; throw new TypeError('synthetic bug'); } }, clock });
    await s.tick();
    clock.advance(RETRY_MS + MIN);
    await s.tick();
    clock.advance(RETRY_MS * 4);
    await s.tick();
    const rows = await runsOf(t.db, 'simplefin-sync');
    assert.equal(rows.length, 1, 'no retry');
    assert.equal(rows[0].error_class, 'TypeError');
    assert.equal(calls, 1);
    const svc = (await statusOf(t, s, clock)).jobs['simplefin-sync'];
    assert.equal(svc.state, 'needs_you');
    assert.equal(svc.control?.id, 'run_job');
  } finally { await t.done(); }
});

test('SQLite busy (5) and locked (6) errors are recorded as store_locked and retried', async () => {
  for (const errcode of [5, 6]) {
    const t = await store();
    try {
      const clock = clockAt(START);
      let calls = 0;
      const handler = async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('synthetic store busy'), { code: 'ERR_SQLITE_ERROR', errcode });
        return {};
      };
      const s = schedulerFor(t, { handlers: { 'simplefin-sync': handler }, clock });
      await s.tick();
      assert.equal((await runsOf(t.db, 'simplefin-sync'))[0].error_class, 'store_locked', `errcode ${errcode}`);
      assert.equal((await statusOf(t, s, clock)).jobs['simplefin-sync'].state, 'retrying');
      clock.advance(RETRY_MS + MIN);
      await s.tick();
      const rows = await runsOf(t.db, 'simplefin-sync');
      assert.equal(rows.length, 2, `errcode ${errcode} retried`);
      assert.equal(rows[1].status, 'ok');
    } finally { await t.done(); }
  }
});

test('a paused household claims nothing, reads paused for every job and never retries', async () => {
  const t = await store();
  try {
    const clock = clockAt(START);
    let on = false;
    let calls = 0;
    const handlers = {
      'simplefin-sync': async () => { calls += 1; throw new JobFailure('simplefin_network'); },
      plan: async () => { calls += 1; return {}; },
    };
    const s = schedulerFor(t, { handlers, clock, allowed: () => on });
    await s.tick();
    assert.equal((await t.db.prepare('SELECT count(*) AS n FROM job_runs').get()).n, 0, 'nothing is claimed while paused');
    assert.equal(calls, 0);
    const out = await statusOf(t, s, clock, { ...ALL_ON, jobs: false });
    assert.deepEqual(Object.keys(out.jobs).sort(), ['plan', 'simplefin-sync']);
    for (const svc of Object.values(out.jobs)) {
      assert.equal(svc.state, 'paused', svc.key);
      assert.equal(svc.code, 'paused', svc.key);
      assert.equal(svc.nextAttemptAt, null, svc.key);
      assert.deepEqual({ id: svc.control?.id, arg: svc.control?.arg }, { id: 'resume', arg: 'jobs' }, svc.key);
    }

    // A transient failure recorded while on, then paused: the due retry does not run.
    on = true;
    await s.tick();
    assert.equal((await runsOf(t.db, 'simplefin-sync')).length, 1);
    on = false;
    clock.advance(RETRY_MS + MIN);
    await s.tick();
    assert.equal((await runsOf(t.db, 'simplefin-sync')).length, 1, 'no retry while paused');
    assert.equal((await statusOf(t, s, clock, { ...ALL_ON, jobs: false })).jobs['simplefin-sync'].state, 'paused');
  } finally { await t.done(); }
});

test('a skipped run while SimpleFIN is paused reads paused and is never retried', async () => {
  const t = await store();
  try {
    const clock = clockAt(START);
    let calls = 0;
    const s = schedulerFor(t, { handlers: { 'simplefin-sync': async () => { calls += 1; return { status: 'skipped', note: { paused: true } }; } }, clock });
    await s.tick();
    clock.advance(RETRY_MS + MIN);
    await s.tick();
    clock.advance(RETRY_MS * 4);
    await s.tick();
    const rows = await runsOf(t.db, 'simplefin-sync');
    assert.equal(rows.length, 1, 'no +retry row for a skipped run');
    assert.equal(rows[0].status, 'skipped');
    assert.equal(calls, 1);
    const svc = (await statusOf(t, s, clock, { ...ALL_ON, simplefin: false })).jobs['simplefin-sync'];
    assert.equal(svc.state, 'paused');
    assert.deepEqual({ id: svc.control?.id, arg: svc.control?.arg }, { id: 'resume', arg: 'simplefin' });
  } finally { await t.done(); }
});
