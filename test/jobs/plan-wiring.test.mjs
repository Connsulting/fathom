// The plan job is wired: planning runs only through the scheduler's default plan handler.
// Manual (runNow and POST /api/jobs/plan/run), scheduled (a tick at the nightly period) and ingest
// (trigger) runs on a real store each write exactly one job_runs row for plan, status ok, with the
// planner's counts as the note, and planner_recs reference that row. A held lease refuses a manual
// run (409 over HTTP). On a demo store a scheduled or ingest run is recorded skipped and plans
// nothing, and POST /api/jobs/plan/run answers 409 and changes nothing. runPlanning needs runId.
// Synthetic data only (test/helpers/real-store.mjs).

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.mjs';
import { openStore } from '../../src/server.mjs';
import { listTables } from '../../src/store/db.mjs';
import { runPlanning } from '../../src/jobs/planner.mjs';
import { createScheduler, defaultHandlers, SchedulerError } from '../../src/jobs/scheduler.mjs';
import { serveAppFixture } from '../helpers/server.mjs';
import { scratch, buildRealStore, dumpTables, parseJson, PACKS_DIR, CLOCK } from '../helpers/real-store.mjs';

const S = scratch('fathom-plan-wiring-');
after(() => S.cleanup());

const quiet = { log() {} };
const JOB_TABLES = new Set(['jobs', 'job_runs', 'job_lock']);
const realConfig = dir => loadConfig({ FATHOM_DATA: dir, FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_CLOCK: CLOCK });
const demoConfig = dir => loadConfig({ FATHOM_DATA: dir, FATHOM_ENGINE: 'off', FATHOM_CLOCK: CLOCK });

// 03:00 in New York on the store clock's date: the nightly plan period (02:00) of that day is due.
const NIGHTLY = '2026-11-05T08:00:00Z';

async function realStore() {
  const dir = S.dir();
  return { dir, db: S.track(await buildRealStore(dir)) };
}

function demoStore() {
  const dir = S.dir();
  const { db, platform } = openStore({ dataDir: dir, demo: 'auto' });
  S.track(platform);
  return { dir, db: S.track(db) };
}

function schedulerOn(db, config, { now = () => new Date(), holder } = {}) {
  return createScheduler({ db, config, handlers: { plan: defaultHandlers({ publicUrl: null }).plan }, now, tickMs: 3600000, log: quiet, ...(holder ? { holder } : {}) });
}

async function serve(db, config, scheduler) {
  return serveAppFixture({ authenticated: true, db, config, scheduler });
}

const planRuns = db => db.prepare("SELECT * FROM job_runs WHERE job_id = 'plan' ORDER BY id").all().map(r => ({ ...r }));
const planner = db => db.prepare('SELECT rec_id, first_run, last_run FROM planner_recs').all();
const nonJobTables = db => dumpTables(db, listTables(db).filter(t => !JOB_TABLES.has(t)));
const allTables = db => dumpTables(db, listTables(db));

// Exactly one plan run, ok, with the given trigger, a counts note, and every planner rec on it.
function assertOnePlanRun(db, trigger) {
  const runs = planRuns(db);
  assert.equal(runs.length, 1, 'exactly one job_runs row for plan');
  const [run] = runs;
  assert.equal(run.status, 'ok');
  assert.equal(run.trigger, trigger);
  assert.ok(run.finished_at && Number.isInteger(run.duration_ms));
  assert.equal(run.cost_usd, 0, 'engine off: no cost');
  const note = parseJson(run.note, null);
  assert.ok(note, 'a counts note');
  for (const k of ['factsDerived', 'factsWritten', 'figures', 'warnings']) assert.equal(typeof note[k], 'number', `note.${k}`);
  for (const k of ['active', 'new', 'updated', 'retired', 'unchanged']) assert.equal(typeof note.recs[k], 'number', `note.recs.${k}`);
  for (const k of ['model', 'template', 'kept']) assert.equal(typeof note.prose[k], 'number', `note.prose.${k}`);
  assert.ok(note.recs.active > 0, 'the run planned recs');
  assert.ok(!('byTrigger' in note), 'counts only: no per-trigger states');
  const recs = planner(db);
  assert.equal(recs.length, note.recs.active);
  for (const r of recs) {
    assert.equal(r.first_run, run.id, `${r.rec_id} first_run`);
    assert.equal(r.last_run, run.id, `${r.rec_id} last_run`);
  }
  return run;
}

describe('plan runs on a real store go through the scheduler', () => {
  test('manual: runNow writes one ok row with the counts note and planner_recs reference it', async () => {
    const { dir, db } = await realStore();
    const s = schedulerOn(db, { clock: CLOCK, dataDir: dir });
    try {
      const run = await s.runNow('plan');
      assert.equal(run.status, 'ok');
      assert.equal(assertOnePlanRun(db, 'manual').id, run.id);
      assert.match(run.periodKey, /^manual:/);
    } finally {
      await s.stop();
    }
  });

  test('manual: POST /api/jobs/plan/run with an enrolled session runs the plan job and answers {scenario, run, jobs}', async () => {
    const { dir, db } = await realStore();
    const config = realConfig(dir);
    const s = schedulerOn(db, config);
    const app = await serve(db, config, s);
    try {
      const r = await app.postJson('/api/jobs/plan/run', {});
      assert.equal(r.status, 200, r.text.slice(0, 300));
      assert.deepEqual(Object.keys(r.json).sort(), ['jobs', 'run', 'scenario']);
      const run = assertOnePlanRun(db, 'manual');
      assert.equal(r.json.run.id, run.id);
      assert.equal(r.json.run.status, 'ok');
      assert.equal(r.json.run.note.recs.active, parseJson(run.note).recs.active);
      assert.equal(r.json.scenario.live.mode, 'real');
      assert.ok(r.json.scenario.recs.some(x => x.id === 'fed-q4-estimate'), 'the fresh scenario carries planner recs');
      assert.equal(r.json.jobs.find(j => j.id === 'plan').lastRun.id, run.id);
    } finally {
      await app.close();
      await s.stop();
    }
  });

  test('scheduled: a tick at the nightly period writes one ok row keyed by that date', async () => {
    const { dir, db } = await realStore();
    const s = schedulerOn(db, { clock: null, dataDir: dir }, { now: () => new Date(NIGHTLY) });
    try {
      await s.tick();
      const run = assertOnePlanRun(db, 'scheduled');
      assert.equal(run.period_key, '2026-11-05');
      await s.tick();
      assert.equal(planRuns(db).length, 1, 'one attempt per period');
    } finally {
      await s.stop();
    }
  });

  test('ingest: trigger(plan, ingest) writes one ok row', async () => {
    const { dir, db } = await realStore();
    const s = schedulerOn(db, { clock: CLOCK, dataDir: dir });
    try {
      const run = await s.trigger('plan', 'ingest');
      assert.ok(run, 'the trigger ran');
      assert.equal(assertOnePlanRun(db, 'ingest').id, run.id);
      assert.match(run.periodKey, /^ingest:/);
    } finally {
      await s.stop();
    }
  });

  test('a manual run while another scheduler holds the lease is refused, 409 over HTTP; liveness after release', async () => {
    const { dir, db } = await realStore();
    const config = realConfig(dir);
    const other = createScheduler({ db, config, handlers: {}, tickMs: 3600000, holder: 'other-holder', log: quiet });
    await other.tick();
    const s = schedulerOn(db, config, { holder: 'server-holder' });
    const app = await serve(db, config, s);
    try {
      await assert.rejects(s.runNow('plan'), e => e instanceof SchedulerError && e.code === 'locked');
      const r = await app.postJson('/api/jobs/plan/run', {});
      assert.equal(r.status, 409, r.text.slice(0, 300));
      assert.equal(r.json.error, 'another scheduler holds the job lock');
      assert.equal(planRuns(db).length, 0, 'nothing ran');
      assert.equal(planner(db).length, 0, 'nothing planned');
      await other.stop();
      const ok = await app.postJson('/api/jobs/plan/run', {});
      assert.equal(ok.status, 200, ok.text.slice(0, 300));
      assertOnePlanRun(db, 'manual');
    } finally {
      await app.close();
      await s.stop();
      await other.stop();
    }
  });
});

describe('plan runs on a demo store', () => {
  test('scheduled and ingest runs are recorded skipped and change no planner tables', async () => {
    const { dir, db } = demoStore();
    const before = nonJobTables(db);
    const s = schedulerOn(db, { clock: null, dataDir: dir }, { now: () => new Date(NIGHTLY) });
    try {
      await s.tick();
      const ingest = await s.trigger('plan', 'ingest');
      assert.equal(ingest.status, 'skipped');
    } finally {
      await s.stop();
    }
    const runs = planRuns(db);
    assert.deepEqual(runs.map(r => [r.trigger, r.status]), [['scheduled', 'skipped'], ['ingest', 'skipped']]);
    for (const r of runs) assert.equal(r.note, null);
    assert.deepEqual(nonJobTables(db), before, 'only the job tables changed');
  });

  test('POST /api/jobs/plan/run answers 409 with the error text and changes nothing', async () => {
    const { dir, db } = demoStore();
    const config = demoConfig(dir);
    const s = schedulerOn(db, config);
    const app = await serve(db, config, s);
    const before = allTables(db);
    try {
      const r = await app.postJson('/api/jobs/plan/run', {});
      assert.equal(r.status, 409);
      assert.equal(r.json.error, 'planning runs on real stores only');
      assert.deepEqual(allTables(db), before, 'demo store unchanged');
    } finally {
      await app.close();
      await s.stop();
    }
  });
});

test('runPlanning without runId throws TypeError and changes nothing', async () => {
  const { db } = await realStore();
  const before = allTables(db);
  for (const opts of [{ now: CLOCK, packDirs: [PACKS_DIR] }, { now: CLOCK, packDirs: [PACKS_DIR], runId: '1' }, undefined]) {
    assert.throws(() => runPlanning(db, null, opts), TypeError);
  }
  assert.deepEqual(allTables(db), before);
});
