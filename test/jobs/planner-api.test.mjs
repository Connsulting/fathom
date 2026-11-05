// AC1: the planning run through the scheduler's plan handler (test/helpers/plan.mjs), its job
// bookkeeping (written by the scheduler), the HTTP endpoint (POST /api/jobs/plan/run, the generic
// POST /api/jobs/:id/run), the CLI, serialization of concurrent runPlanning calls and idempotence.
// Refusals (demo store, missing store, a held lease) each have a working counterpart.

import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runPlanning, PlannerError, PLAN_JOB_ID } from '../../src/jobs/planner.mjs';
import { createScheduler, defaultHandlers, JOBS } from '../../src/jobs/scheduler.mjs';
import { createHandler, routes } from '../../src/api/router.mjs';
import { loadConfig } from '../../src/config.mjs';
import { openStore } from '../../src/server.mjs';
import { openDb, listTables, DB_FILE } from '../../src/store/db.mjs';
import { postJson, runCommand, TEST_OWNER } from '../helpers/server.mjs';
import { scratch, buildRealStore, dumpTables, activeRecIds, parseJson, PACKS_DIR } from '../helpers/real-store.mjs';
import { planRun, claimPlanRun } from '../helpers/plan.mjs';

const NOW = '2026-11-05';
const S = scratch();
after(() => S.cleanup());

const plan = (db, opts = {}) => planRun(db, { engine: opts.engine ?? null, now: opts.now ?? NOW, dataDir: opts.dataDir ?? null });
// Real mode admits only FATHOM_OWNER_LOGINS; postJson sends TEST_OWNER as Tailscale-User-Login.
const realConfig = dir => loadConfig({ FATHOM_DATA: dir, FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_CLOCK: NOW, FATHOM_OWNER_LOGINS: TEST_OWNER });

// Amounts from the synthetic dataset and its main results; none may leak into counts or notes.
const AMOUNTS = ['143175', '143,175', '171810', '171,810', '18000', '18,000', '25000', '25,000', '40000', '40,000', '50000', '50,000', '290147', '290,147', '6000', '15000'];
const leaks = text => AMOUNTS.filter(a => text.includes(a));

function demoStore() {
  const dir = S.dir();
  const db = openStore({ dataDir: dir, demo: 'auto' });
  return { dir, db: S.track(db) };
}

function allTables(db) {
  return dumpTables(db, listTables(db));
}

// The in-process router with the server's scheduler (default handlers, not started).
async function serve(db, config, engine = null) {
  const scheduler = createScheduler({ db, config, engine, handlers: defaultHandlers({ publicUrl: null }), tickMs: 3600000, log: { log() {} } });
  const server = http.createServer(createHandler({ db, config, engine, scheduler }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await scheduler.stop();
    },
  };
}

describe('runPlanning', () => {
  test('AC1: runPlanning returns the result shape and PLAN_JOB_ID is plan', async () => {
    assert.equal(PLAN_JOB_ID, 'plan');
    const db = await S.store();
    const result = await plan(db);
    assert.equal(result.status, 'ok');
    assert.ok(Number.isInteger(result.runId));
    assert.equal(result.runId, result.run.id, 'the planner ran under the scheduler run');
    const c = result.counts;
    for (const k of ['factsDerived', 'factsWritten', 'figures', 'warnings']) assert.equal(typeof c[k], 'number', `counts.${k}`);
    for (const k of ['active', 'new', 'updated', 'retired', 'unchanged']) assert.equal(typeof c.recs[k], 'number', `counts.recs.${k}`);
    for (const k of ['model', 'template', 'kept']) assert.equal(typeof c.prose[k], 'number', `counts.prose.${k}`);
    assert.equal(c.recs.active, activeRecIds(db).length);
    assert.equal(c.recs.new, c.recs.active, 'first run: every active rec is new');
    assert.equal(c.prose.template, c.recs.active, 'no engine: template prose for every rec');
    for (const [id, v] of Object.entries(c.byTrigger)) assert.ok(['new', 'updated', 'unchanged', 'retired'].includes(v), `${id}: ${v}`);
    assert.equal(c.byTrigger['fed-q4-estimate'], 'new');
    assert.ok(Array.isArray(result.warnings) && result.warnings.every(w => typeof w === 'string'));
    assert.equal(c.warnings, result.warnings.length);
    assert.equal(typeof result.costUsd, 'number');
    assert.equal(result.costUsd, 0);
  });

  test('AC1: each run inserts the plan job once and one job_runs row with status ok and a counts-only note', async () => {
    const db = await S.store();
    const first = await plan(db);
    const second = await plan(db);
    const job = db.prepare("SELECT * FROM jobs WHERE id = 'plan'").get();
    assert.ok(job, 'jobs row plan');
    const def = JOBS.find(j => j.id === 'plan');
    assert.deepEqual([job.name, job.cadence, job.enabled], [def.name, def.cadence, 1], 'the scheduler writes the plan jobs row');
    assert.equal(db.prepare("SELECT count(*) AS n FROM jobs WHERE id = 'plan'").get().n, 1);
    const runs = db.prepare("SELECT * FROM job_runs WHERE job_id = 'plan' ORDER BY id").all();
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map(r => r.id), [first.runId, second.runId]);
    for (const r of runs) {
      assert.equal(r.status, 'ok');
      assert.ok(!Number.isNaN(Date.parse(r.started_at)) && !Number.isNaN(Date.parse(r.finished_at)), 'ISO timestamps');
      assert.ok(r.finished_at >= r.started_at);
      assert.equal(r.cost_usd, 0);
      const note = parseJson(r.note, null);
      assert.ok(note && typeof note === 'object', 'note is JSON');
      assert.deepEqual(leaks(r.note), [], 'note carries counts, never amounts');
    }
    assert.deepEqual(parseJson(runs[0].note).recs, first.counts.recs);
  });

  test('AC1: a failing run marks its job_runs row error with the class name only, and rethrows', async () => {
    const db = await S.store();
    // A data directory whose Your plans pack has a broken manifest: loading packs throws.
    const dataDir = S.dir();
    const broken = join(dataDir, 'packs', 'your-plans');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'manifest.json'), '{ not json');
    await assert.rejects(plan(db, { dataDir }));
    const run = db.prepare("SELECT * FROM job_runs WHERE job_id = 'plan' ORDER BY id DESC").get();
    assert.ok(run, 'the run was recorded');
    assert.equal(run.status, 'error');
    assert.ok(run.finished_at);
    assert.match(run.error_class, /^[A-Za-z_][A-Za-z0-9_]*$/, 'error_class is an identifier');
    assert.equal(run.note, null, 'a failed run has no note');
    for (const [col, v] of Object.entries(run)) assert.ok(!String(v ?? '').includes('your-plans'), `job_runs.${col} carries no message text from the failure`);
    // liveness: the same store plans fine with a valid pack directory
    assert.equal((await plan(db)).status, 'ok');
  });

  test('AC1: runPlanning refuses a demo store with PlannerError demo_store and changes nothing', async () => {
    const { db } = demoStore();
    const before = allTables(db);
    // The planner core directly: the refusal comes before any write, and claiming a job_runs row
    // would itself change the store, so the run id here is a placeholder.
    await assert.rejects(runPlanning(db, null, { now: NOW, packDirs: [PACKS_DIR], runId: 1 }), err => err instanceof PlannerError && err.code === 'demo_store');
    assert.deepEqual(allTables(db), before, 'demo store unchanged');
    // liveness: a real store is accepted
    assert.equal((await plan(await S.store())).status, 'ok');
  });

  test('AC1: two concurrent runs both complete and leave the same state as one run', async () => {
    const slow = { async call() { await new Promise(r => setTimeout(r, 2)); throw new Error('synthetic engine failure'); } };
    const one = await S.store();
    await plan(one, { engine: slow });
    const two = await S.store();
    // The planner core directly with two claimed runs: its per-db chain serializes them.
    const ids = [claimPlanRun(two), claimPlanRun(two)];
    const core = (runId) => runPlanning(two, slow, { now: NOW, packDirs: [PACKS_DIR], runId });
    const results = await Promise.all([core(ids[0]), core(ids[1])]);
    assert.deepEqual(results.map(r => r.status), ['ok', 'ok']);
    assert.notEqual(results[0].runId, results[1].runId);
    assert.deepEqual(results.map(r => r.runId), ids, 'each run carries the run id it was given');
    const firstRuns = [...new Set(two.prepare('SELECT first_run FROM planner_recs').all().map(r => r.first_run))];
    assert.deepEqual(firstRuns, [ids[0]], 'the first call ran first and created every planner rec');
    const tables = ['facts', 'figures', 'sources', 'recs', 'rec_events', 'planner_recs', 'content', 'deadlines', 'decisions', 'events', 'packs_state', 'conversations', 'messages'];
    // Timestamps, autoincrement ids and run ids differ between stores by construction.
    const omit = ['updated_at', 'ts', 'created_at', 'last_ingest_at', 'id', 'first_run', 'last_run'];
    assert.deepEqual(dumpTables(two, tables, { omit }), dumpTables(one, tables, { omit }));
  });

  test('AC1: a second run over the same data writes nothing that changes (idempotent)', async () => {
    const db = await S.store();
    await plan(db);
    const keepStamps = ['recs', 'figures'];
    const others = ['facts', 'sources', 'rec_events', 'planner_recs', 'content', 'deadlines', 'decisions', 'events', 'packs_state'];
    const snap = () => ({ ...dumpTables(db, keepStamps), ...dumpTables(db, others, { omit: ['updated_at'] }) });
    const before = snap();
    await new Promise(r => setTimeout(r, 15)); // a rewrite would get a new updated_at
    const second = await plan(db);
    assert.deepEqual(snap(), before);
    const c = second.counts;
    assert.deepEqual([c.recs.new, c.recs.updated, c.recs.retired], [0, 0, 0]);
    assert.equal(c.recs.unchanged, c.recs.active);
    assert.equal(c.factsWritten, 0);
    assert.equal(c.prose.model + c.prose.template, 0, 'prose kept, nothing regenerated');
    for (const v of Object.values(c.byTrigger)) assert.equal(v, 'unchanged');
  });
});

describe('POST /api/jobs/plan/run', () => {
  test('AC1: the route is the generic job run route in the route table', () => {
    assert.ok(routes.some(r => r.method === 'POST' && r.path === '/api/jobs/:id/run'));
    assert.ok(!routes.some(r => r.path === '/api/jobs/plan/run'), 'no dedicated plan route');
  });

  test('AC1: on a real store the endpoint plans and returns the scenario with planner recs and the run', async () => {
    const dir = S.dir();
    const db = S.track(await buildRealStore(dir));
    const app = await serve(db, realConfig(dir));
    try {
      const r = await postJson(app.baseUrl, '/api/jobs/plan/run', {});
      assert.equal(r.status, 200, r.text.slice(0, 300));
      assert.equal(r.json.run.status, 'ok');
      assert.equal(r.json.run.jobId, 'plan');
      assert.ok(Number.isInteger(r.json.run.id));
      assert.ok(Array.isArray(r.json.jobs) && r.json.jobs.some(j => j.id === 'plan'), 'jobs lists the plan job');
      const ids = r.json.scenario.recs.map(x => x.id);
      for (const id of ['fed-q4-estimate', 'scorp-salary', 'va529']) assert.ok(ids.includes(id), `scenario has ${id}`);
      assert.equal(r.json.scenario.live.mode, 'real');
      assert.ok(r.json.scenario.fig['tax.fed.paid'], 'scenario carries planner figures');
      assert.equal(db.prepare("SELECT count(*) AS n FROM job_runs WHERE job_id = 'plan' AND status = 'ok'").get().n, 1);
    } finally {
      await app.close();
    }
  });

  test('AC1: on a demo store the endpoint answers 409 and changes nothing', async () => {
    const { dir, db } = demoStore();
    const before = allTables(db);
    const app = await serve(db, loadConfig({ FATHOM_DATA: dir, FATHOM_ENGINE: 'off' }));
    try {
      const r = await postJson(app.baseUrl, '/api/jobs/plan/run', {});
      assert.equal(r.status, 409);
      assert.equal(r.json.error, 'planning runs on real stores only');
    } finally {
      await app.close();
    }
    assert.deepEqual(allTables(db), before);
  });
});

describe('npm run plan (src/jobs/plan-cli.mjs)', () => {
  const cli = env => runCommand(process.execPath, ['src/jobs/plan-cli.mjs'], { env: { FATHOM_ENGINE: 'off', FATHOM_CLOCK: NOW, ...env } });

  test('AC1: the CLI plans a real store, exits 0 and prints counts without amounts', async () => {
    const dir = S.dir();
    (await buildRealStore(dir)).close();
    const out = await cli({ FATHOM_DATA: dir });
    assert.equal(out.code, 0, out.stderr);
    const counts = out.stdout.split('\n').map(l => parseJson(l.trim(), null)).find(x => x && typeof x === 'object' && x.recs);
    assert.ok(counts, `stdout has the counts JSON: ${out.stdout.slice(0, 300)}`);
    assert.ok(counts.recs.active > 0);
    assert.deepEqual(leaks(out.stdout + out.stderr), [], 'no amounts from the dataset');
    const db = S.track(openDb(join(dir, DB_FILE)));
    assert.equal(db.prepare("SELECT count(*) AS n FROM job_runs WHERE job_id = 'plan' AND status = 'ok'").get().n, 1);
  });

  test('AC1: the CLI exits 2 on a demo store and leaves it unchanged', async () => {
    const { dir, db } = demoStore();
    const before = allTables(db);
    db.close();
    const out = await cli({ FATHOM_DATA: dir });
    assert.equal(out.code, 2);
    const again = S.track(openDb(join(dir, DB_FILE)));
    assert.deepEqual(allTables(again), before);
  });

  test('AC1: the CLI exits 2 when there is no store and does not create one', async () => {
    const dir = S.dir();
    const out = await cli({ FATHOM_DATA: dir });
    assert.equal(out.code, 2);
    assert.equal(existsSync(join(dir, DB_FILE)), false);
  });

  test('the CLI exits 3 while another process holds the job lease, and plans once it is released', async () => {
    const dir = S.dir();
    const db = S.track(await buildRealStore(dir));
    // Another scheduler (as the running server would) takes the lease on its tick.
    const holder = createScheduler({ db, config: { clock: NOW, dataDir: dir }, handlers: {}, tickMs: 3600000, holder: 'server-holder', log: { log() {} } });
    await holder.tick();
    assert.equal(db.prepare('SELECT holder FROM job_lock').get().holder, 'server-holder');
    const out = await cli({ FATHOM_DATA: dir });
    assert.equal(out.code, 3, out.stderr);
    assert.match(out.stderr, /Run now/);
    assert.match(out.stderr, /POST \/api\/jobs\/plan\/run/);
    assert.equal(db.prepare("SELECT count(*) AS n FROM job_runs WHERE job_id = 'plan'").get().n, 0, 'nothing ran');
    // liveness: once the lease is released the CLI plans
    await holder.stop();
    const again = await cli({ FATHOM_DATA: dir });
    assert.equal(again.code, 0, again.stderr);
    assert.equal(db.prepare("SELECT count(*) AS n FROM job_runs WHERE job_id = 'plan' AND status = 'ok'").get().n, 1);
  });
});
