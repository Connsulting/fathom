// The stable confirm-guess scheduler entry now records resolver answers. Fixtures are synthetic.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempDb, serveAppFixture } from '../helpers/server.mjs';
import { realStore, count, all } from '../helpers/ingest.mjs';
import { setSetting } from '../../src/store/db.mjs';
import { seedDemo } from '../../demo/seed.mjs';
import { createRuntimeEngine } from '../../src/engine/runtime.mjs';
import { ask, KIND_OPTIONS } from '../../src/ingest/confirm.mjs';
import { JOBS, localParts, periodKey, createScheduler, defaultHandlers } from '../../src/jobs/scheduler.mjs';

const JOB = 'confirm-guess';
const NOW = '2026-11-05T15:00:00.000Z';
const quiet = { log() {} };
const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) return false;
    await settle();
  }
  return true;
}

const pad = (i) => String(i).padStart(2, '0');
const marker = (i) => `Q${pad(i)}Q`;

// Queue n synthetic account_kind questions with no file.
async function queue(db, n, { start = 1 } = {}) {
  const ids = [];
  for (let i = start; i < start + n; i++) {
    await db.prepare('INSERT INTO accounts (id,name,inst,mask) VALUES (?,?,?,?)').run(`acct-job-synthetic-${pad(i)}`, `Synthetic account ${marker(i)}`, 'Example Bank', String(6000 + i));
    const r = await ask(db, {
      kind: 'account_kind', subject: `acct-job-synthetic-${pad(i)}`, question: `What kind of account is Synthetic account ${marker(i)}?`,
      options: KIND_OPTIONS, context: { last4: String(6000 + i) }, now: NOW,
    });
    assert.equal(r.queued, true);
    ids.push(r.id);
  }
  return ids;
}

// A live-mode stub engine: each call guesses every item's first option with a fixed basis code
// and costs costs[n - 1]. failAt: call n throws. hold: the first call waits for release().
function liveEngine({ costs = [], failAt = null, hold = false } = {}) {
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  return {
    mode: 'live',
    isOn: () => true,
    calls,
    release: () => release(),
    async init() {},
    async call(req) {
      calls.push(structuredClone(req));
      const n = calls.length;
      if (failAt === n) { const e = new Error('synthetic model failure'); e.name = 'SyntheticEngineError'; throw e; }
      if (hold && n === 1) await gate;
      const { items } = JSON.parse(req.messages[0].content);
      const answers = items.filter(i => i.kind === 'account_kind').map((i) => ({ item: i.id, option: i.options[0].id, basis: 'account_name', refs: [`accounts:${i.context.accountId ?? i.subject ?? `acct-job-synthetic-${pad(Number(i.question.match(/Q(\d+)Q/)[1]))}`}`] }));
      return { text: JSON.stringify({ answers }), model: 'stub-live', costUsd: costs[n - 1] ?? 0 };
    },
    async extract() { throw new Error('no extraction in this test'); },
  };
}

const offRuntime = async (db) => await createRuntimeEngine({ db, config: { engine: 'off' } });
const jobHandlers = () => ({ [JOB]: defaultHandlers({ publicUrl: null })[JOB] });

function schedulerFor(db, { engine, handlers = jobHandlers(), now = () => new Date(NOW), config = {} } = {}) {
  return createScheduler({ db, config: { clock: null, ...config }, engine, handlers, now, tickMs: 3600000, holder: 'guess-holder', log: quiet, household: () => ({ outbound: { enabled: () => true }, funded: () => true }) });
}

const runsOf = async (db) => await all(db, 'SELECT * FROM job_runs WHERE job_id = ? ORDER BY id', JOB);
const noteOf = (row) => (row.note == null ? null : JSON.parse(row.note));
const near = (a, b) => Math.abs(a - b) < 1e-9;

async function withStore(fn) {
  const t = await tempDb();
  await setSetting(t.db, 'mode', 'real');
  try { return await fn(t); } finally {
    try { await t.db.close(); } catch { /* closed */ }
    rmSync(t.dataDir, { recursive: true, force: true });
  }
}

describe('the confirm-guess job definition', () => {
  test('JOBS has the confirm-guess entry: daily at 3:00 AM', () => {
    const job = JOBS.find((j) => j.id === JOB);
    assert.ok(job, 'JOBS has confirm-guess');
    assert.deepEqual({ ...job, schedule: { ...job.schedule } }, {
      id: JOB, name: 'Resolve open questions', cadence: 'Daily, 3:00 AM',
      does: 'Answer supported choices from stored evidence, with Undo.', schedule: { every: 'day', hour: 3 },
    });
    for (const id of ['plan', 'brief-email', 'deadline-alerts', 'freshness']) assert.ok(JOBS.some((j) => j.id === id), `JOBS still has ${id}`);
  });

  test('defaultHandlers has a confirm-guess handler', () => {
    assert.equal(typeof defaultHandlers({ publicUrl: null })[JOB], 'function');
  });

  test('the period starts at 03:00 New York', () => {
    const key = (iso) => periodKey(JOBS.find((j) => j.id === JOB).schedule, localParts(new Date(iso), 'America/New_York'));
    assert.equal(key('2026-11-05T07:59:00Z'), '2026-11-04');
    assert.equal(key('2026-11-05T08:00:00Z'), '2026-11-05');
  });

  test('jobs() lists confirm-guess with a next label at the next 03:00', async () => withStore(async (t) => {
    const s = schedulerFor(t.db, { engine: await offRuntime(t.db), handlers: defaultHandlers({ publicUrl: null }) });
    try {
      const job = s.jobs().find((j) => j.id === JOB);
      assert.ok(job, 'jobs() lists confirm-guess');
      assert.equal(job.name, 'Resolve open questions');
      assert.equal(job.cadence, 'Daily, 3:00 AM');
      assert.equal(typeof job.next, 'string');
      assert.ok(job.next.length > 0, 'a next label');
      assert.equal(job.nextAt, '2026-11-06T08:00:00.000Z', 'next run: 03:00 New York the following day');
      assert.ok((await t.db.prepare('SELECT next_label FROM jobs WHERE id = ?').get(JOB)).next_label, 'the jobs row has a next label');
    } finally { await s.stop(); }
  }));

  test('a tick at 03:30 New York runs it once for that date', async () => withStore(async (t) => {
    const s = schedulerFor(t.db, { engine: await offRuntime(t.db), now: () => new Date('2026-11-05T08:30:00Z') });
    try {
      await s.tick();
      await s.tick();
      const rows = await runsOf(t.db);
      assert.equal(rows.length, 1, 'one attempt per period');
      assert.equal(rows[0].trigger, 'scheduled');
      assert.equal(rows[0].period_key, '2026-11-05');
    } finally { await s.stop(); }
  }));
});

describe('the default confirm-guess handler', () => {
  test('runNow stores a guess for every pending question and writes an ok row with the cost sum and counts note', async () => withStore(async (t) => {
    const ids = await queue(t.db, 25);
    const engine = liveEngine({ costs: [0.5, 0.25] });
    const s = schedulerFor(t.db, { engine });
    try {
      const run = await s.runNow(JOB);
      assert.equal(run.status, 'ok');
      assert.equal(engine.calls.length, 2, '25 items in batches of 20');
      assert.ok(engine.calls.every((req) => req.purpose === 'job'));
      const rows = await all(t.db, `SELECT a.item_id, ci.answer AS option_id, a.rule, a.created_at AS ts FROM confirm_auto a JOIN confirm_items ci ON ci.id=a.item_id ORDER BY a.item_id`);
      assert.deepEqual(rows.map((r) => r.item_id), ids, 'a guess row for every pending question');
      for (const r of rows) {
        assert.equal(r.option_id, KIND_OPTIONS[0].id);
        assert.equal(r.rule, 'resolver');
        assert.equal(r.ts, NOW, 'guesses carry the run time');
      }
      const [row] = await runsOf(t.db);
      assert.equal(row.id, run.id);
      assert.equal(row.status, 'ok');
      assert.equal(row.trigger, 'manual');
      assert.equal(row.error_class, null);
      assert.ok(near(row.cost_usd, 0.75), `cost_usd is the batch sum, got ${row.cost_usd}`);
      assert.deepEqual(noteOf(row), { batches: 2, items: 25, guessed: 25, stopped: false });
      assert.deepEqual(run.note, { batches: 2, items: 25, guessed: 25, stopped: false });
      for (const id of ids) {
        assert.equal((await t.db.prepare('SELECT status FROM confirm_items WHERE id = ?').get(id)).status, 'answered', 'a grounded choice answers the question');
      }
    } finally { await s.stop(); }
  }));

  test('an engine error stops the run: still ok, with the cost spent so far and stopped true', async () => withStore(async (t) => {
    await queue(t.db, 25);
    const engine = liveEngine({ costs: [0.5, 0.25], failAt: 2 });
    const s = schedulerFor(t.db, { engine });
    try {
      const run = await s.runNow(JOB);
      assert.equal(run.status, 'ok', 'a stopped run is not an error');
      assert.equal(engine.calls.length, 2, 'no call after the failure');
      assert.equal(await count(t.db, 'confirm_auto'), 20, 'the first batch is kept');
      const [row] = await runsOf(t.db);
      assert.equal(row.status, 'ok');
      assert.equal(row.error_class, null);
      assert.ok(near(row.cost_usd, 0.5), `cost_usd is the cost spent before the stop, got ${row.cost_usd}`);
      assert.deepEqual(noteOf(row), { batches: 1, items: 20, guessed: 20, stopped: true });
      assert.ok(!String(row.note).includes('synthetic model failure'), 'no message in the note');
    } finally { await s.stop(); }
  }));

  test('engine off: the run is skipped with the pending count, no guess, no spend', async () => withStore(async (t) => {
    await queue(t.db, 2);
    const s = schedulerFor(t.db, { engine: await offRuntime(t.db) });
    try {
      const run = await s.runNow(JOB);
      assert.equal(run.status, 'skipped');
      const [row] = await runsOf(t.db);
      assert.equal(row.status, 'skipped');
      assert.deepEqual(noteOf(row), { pending: 2 });
      assert.equal(await count(t.db, 'confirm_auto'), 0);
      assert.equal(await count(t.db, 'spend_ledger'), 0);
    } finally { await s.stop(); }
  }));

  test('engine setting off on a live engine: skipped and the engine is never called', async () => withStore(async (t) => {
    await queue(t.db, 2);
    const engine = { ...liveEngine(), isOn: () => false };
    const s = schedulerFor(t.db, { engine });
    try {
      const run = await s.runNow(JOB);
      assert.equal(run.status, 'skipped');
      assert.equal(await count(t.db, 'confirm_auto'), 0);
    } finally { await s.stop(); }
  }));

  test('nothing pending: skipped with pending 0 and no engine call', async () => withStore(async (t) => {
    const engine = liveEngine();
    const s = schedulerFor(t.db, { engine });
    try {
      const run = await s.runNow(JOB);
      assert.equal(run.status, 'skipped');
      assert.deepEqual(run.note, { pending: 0 });
      assert.equal(engine.calls.length, 0);
    } finally { await s.stop(); }
  }));

  test('a demo store with the fake engine: skipped, no guess and no ledger row', async () => {
    const t = await tempDb();
    try {
      await seedDemo(t.db);
      const engine = await createRuntimeEngine({ db: t.db, config: { engine: 'fake', demo: true } });
      await engine.init();
      const spend = await count(t.db, 'spend_ledger');
      const guesses = await count(t.db, 'confirm_auto');
      const s = schedulerFor(t.db, { engine, handlers: defaultHandlers({ publicUrl: null }), config: { demo: true } });
      try {
        const run = await s.runNow(JOB);
        assert.equal(run.status, 'skipped');
      } finally { await s.stop(); }
      assert.equal(await count(t.db, 'spend_ledger'), spend, 'no ledger row');
      assert.equal(await count(t.db, 'confirm_auto'), guesses, 'no guess');
      assert.deepEqual((await runsOf(t.db)).map((r) => r.status), ['skipped']);
    } finally {
      try { await t.db.close(); } catch { /* closed */ }
      rmSync(t.dataDir, { recursive: true, force: true });
    }
  });
});

// The job handler passes no fake script, so a fake-mode runtime engine would be skipped as not_live.
// This wrapper reports live and injects the next scripted response into each call, so the real
// runtime engine and spend_ledger run underneath the job.
async function scriptedRuntime(db, scripts) {
  const rt = await createRuntimeEngine({ db, config: { engine: 'fake' }, now: () => new Date(NOW) });
  let n = 0;
  return {
    mode: 'live',
    isOn: async () => await rt.isOn(),
    init: () => rt.init(),
    call: async (req) => await rt.call({ ...req, fake: [scripts[n++] ?? { text: JSON.stringify({ answers: [] }), costUsd: 0 }] }),
    extract: async (req) => await rt.extract(req),
  };
}
const confirmSpend = async (db) => Number((await db.prepare("SELECT coalesce(sum(cost_usd), 0) AS s FROM spend_ledger WHERE purpose = 'job'").get()).s);

describe('confirm-guess job cost equals the confirm ledger spend, failed calls included', () => {
  const empty = JSON.stringify({ answers: [] });

  test('a non-JSON response costing 0.05: cost_usd is 0.05, the run is ok and stopped', async () => withStore(async (t) => {
    await queue(t.db, 2);
    const s = schedulerFor(t.db, { engine: await scriptedRuntime(t.db, [{ text: 'not json', costUsd: 0.05 }]) });
    try {
      const before = await confirmSpend(t.db);
      const run = await s.runNow(JOB);
      assert.equal(run.status, 'ok');
      const [row] = await runsOf(t.db);
      assert.equal(row.status, 'ok');
      assert.equal(noteOf(row).stopped, true);
      assert.ok(near(row.cost_usd, 0.05), `cost_usd ${row.cost_usd}`);
      assert.ok(near(row.cost_usd, await confirmSpend(t.db) - before));
    } finally { await s.stop(); }
  }));

  test('a ledger-recorded failing call: cost_usd equals the ledger delta', async () => withStore(async (t) => {
    await queue(t.db, 25);
    const s = schedulerFor(t.db, { engine: await scriptedRuntime(t.db, [{ text: empty, costUsd: 0.5 }, { text: '', status: 'error_max_turns', costUsd: 0.25 }]) });
    try {
      const before = await confirmSpend(t.db);
      const run = await s.runNow(JOB);
      assert.equal(run.status, 'ok');
      const [row] = await runsOf(t.db);
      assert.equal(noteOf(row).stopped, true);
      assert.equal(noteOf(row).batches, 1);
      assert.ok(near(await confirmSpend(t.db) - before, 0.75), 'both calls were recorded in the ledger');
      assert.ok(near(row.cost_usd, await confirmSpend(t.db) - before), `cost_usd ${row.cost_usd}`);
    } finally { await s.stop(); }
  }));

  test('a normal two-batch run: cost_usd equals the ledger delta and the batch cost sum', async () => withStore(async (t) => {
    await queue(t.db, 25);
    const s = schedulerFor(t.db, { engine: await scriptedRuntime(t.db, [{ text: empty, costUsd: 0.5 }, { text: empty, costUsd: 0.25 }]) });
    try {
      const before = await confirmSpend(t.db);
      const run = await s.runNow(JOB);
      assert.equal(run.status, 'ok');
      const [row] = await runsOf(t.db);
      assert.deepEqual(noteOf(row), { batches: 2, items: 25, guessed: 0, stopped: false });
      assert.ok(near(row.cost_usd, 0.75), `cost_usd ${row.cost_usd}`);
      assert.ok(near(row.cost_usd, await confirmSpend(t.db) - before));
    } finally { await s.stop(); }
  }));
});

describe('confirm-guess triggers', () => {
  test('trigger(confirm-guess, ingest) when idle runs it with an ingest key', async () => withStore(async (t) => {
    await queue(t.db, 2);
    const engine = liveEngine({ costs: [0.125] });
    const s = schedulerFor(t.db, { engine });
    try {
      const run = await s.trigger(JOB, 'ingest');
      assert.ok(run, 'the trigger ran');
      assert.equal(run.status, 'ok');
      assert.equal(run.trigger, 'ingest');
      assert.match(run.periodKey, /^ingest:/);
      assert.equal(await count(t.db, 'confirm_auto'), 2);
    } finally { await s.stop(); }
  }));

  test('triggers during a running job coalesce into exactly one rerun', async () => withStore(async (t) => {
    await queue(t.db, 3);
    const engine = liveEngine({ hold: true, costs: [0.25, 0.125] });
    const s = schedulerFor(t.db, { engine });
    try {
      const first = s.runNow(JOB);
      assert.ok(await waitFor(() => engine.calls.length === 1), 'the first run calls the engine');
      const extra = [s.trigger(JOB, 'ingest'), s.trigger(JOB, 'ingest'), s.trigger(JOB, 'ingest')];
      for (const p of extra) assert.equal(await p, null, 'a trigger during a run resolves null');
      const [late] = await queue(t.db, 1, { start: 4 });
      await settle(50);
      assert.equal((await runsOf(t.db)).length, 1, 'no second run while one is running');
      engine.release();
      const run = await first;
      assert.equal(run.status, 'ok');
      assert.ok(await waitFor(async () => (await runsOf(t.db)).length === 2 && (await runsOf(t.db)).every((r) => r.status !== 'running')), 'one rerun follows');
      await settle(100);
      const rows = await runsOf(t.db);
      assert.deepEqual(rows.map((r) => r.trigger), ['manual', 'ingest'], 'the coalesced triggers made one rerun');
      assert.ok(await t.db.prepare('SELECT 1 AS x FROM confirm_auto WHERE item_id = ?').get(late), 'the question queued meanwhile is guessed');
      assert.equal(await count(t.db, 'confirm_auto'), 4);
      assert.equal(engine.calls.length, 2, 'every question is sent exactly once');
      const sent = engine.calls.map((req) => req.messages[0].content);
      assert.equal(sent.filter((x) => x.includes(marker(4))).length, 1);
      assert.ok(sent[0].includes(marker(1))); // Later batches also carry answered history.
    } finally { await s.stop(); }
  }));
});

describe('confirm-guess over the jobs API', () => {
  async function serve(st, engine) {
    const config = { ...st.config };
    const scheduler = schedulerFor(st.db, { engine, config });
    const app = await serveAppFixture({ authenticated: true, db: st.db, config, engine, scheduler });
    return { ...app, async close() { await app.close(); await scheduler.stop(); } };
  }

  test('GET /api/jobs lists confirm-guess; POST /api/jobs/confirm-guess/run runs it and stores guesses', async () => {
    const st = await realStore();
    const ids = await queue(st.db, 2);
    const engine = liveEngine({ costs: [0.125] });
    const app = await serve(st, engine);
    try {
      const list = await app.request({ path: '/api/jobs' });
      assert.equal(list.status, 200, list.text.slice(0, 300));
      const job = list.json.jobs.find((j) => j.id === JOB);
      assert.ok(job, 'GET /api/jobs lists confirm-guess');
      assert.equal(job.name, 'Resolve open questions');
      assert.equal(typeof job.next, 'string');

      const r = await app.postJson(`/api/jobs/${JOB}/run`, {});
      assert.equal(r.status, 200, r.text.slice(0, 300));
      assert.equal(r.json.run.jobId, JOB);
      assert.equal(r.json.run.status, 'ok');
      assert.equal(r.json.run.trigger, 'manual');
      assert.deepEqual(r.json.run.note, { batches: 1, items: 2, guessed: 2, stopped: false });
      assert.ok(near(r.json.run.costUsd, 0.125));
      assert.equal(r.json.jobs.find((j) => j.id === JOB).lastRun.id, r.json.run.id);
      assert.deepEqual((await all(st.db, 'SELECT item_id FROM confirm_auto ORDER BY item_id')).map((x) => x.item_id), ids);
    } finally {
      await app.close();
      await st.close();
    }
  });

  test('POST /api/jobs/confirm-guess/run with the engine off answers 200 with a skipped run', async () => {
    const st = await realStore();
    await queue(st.db, 1);
    const app = await serve(st, await offRuntime(st.db));
    try {
      const r = await app.postJson(`/api/jobs/${JOB}/run`, {});
      assert.equal(r.status, 200, r.text.slice(0, 300));
      assert.equal(r.json.run.status, 'skipped');
      assert.deepEqual(r.json.run.note, { pending: 1 });
      assert.equal(await count(st.db, 'confirm_guesses'), 0);
    } finally {
      await app.close();
      await st.close();
    }
  });
});
