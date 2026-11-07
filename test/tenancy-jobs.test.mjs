import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempInstance } from './helpers/server.mjs';
import { createHouseholdStorage } from '../src/platform/db.mjs';
import { createRuntimeRegistry, buildHouseholdContext } from '../src/platform/runtime.mjs';
import { runPlanning } from '../src/jobs/planner.mjs';

const quiet = { log() {} };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(r => setImmediate(r));

async function fixture(t, handler, count = 3) {
  const instance = await tempInstance();
  const ids = [instance.householdId];
  for (let i = 1; i < count; i++) {
    const id = `hh_synthetic_jobs_${i}`;
    instance.platform.prepare("INSERT INTO households (id, status, mode, created_at, updated_at) VALUES (?, 'active', 'real', ?, ?)").run(id, i, i);
    createHouseholdStorage({ platform: instance.platform, dataDir: instance.dataDir, householdId: id, mode: 'real', secrets: instance.secrets, enabled: true });
    ids.push(id);
  }
  const config = { dataDir: instance.dataDir, engine: 'off', clock: '2026-11-05', emailTransport: 'dev' };
  const makeRegistry = () => createRuntimeRegistry({
    platform: instance.platform, config, secrets: instance.secrets,
    build: opts => buildHouseholdContext({ ...opts, handlers: {
      plan: handler, freshness: handler, 'simplefin-sync': handler,
    }, now: () => new Date('2026-11-05T12:00:00Z'), log: quiet }),
  });
  let registry = makeRegistry();
  t.after(async () => { await registry.close(); instance.close(); rmSync(instance.dataDir, { recursive: true, force: true }); });
  return { ...instance, ids, get registry() { return registry; }, contexts: () => ids.map(id => registry.get(id)),
    async restart() { await registry.close(); registry = makeRegistry(); } };
}

test('one handler per household, two instance-wide, with round-robin admission', { timeout: 15000 }, async t => {
  const releases = [];
  t.after(() => releases.splice(0).forEach(release => release()));
  const started = [];
  let active = 0;
  const perHousehold = new Map();
  const fx = await fixture(t, async ctx => {
    const id = ctx.household.householdId;
    started.push(id);
    active++;
    perHousehold.set(id, (perHousehold.get(id) ?? 0) + 1);
    assert.ok(active <= 2, 'instance handler limit');
    assert.equal(perHousehold.get(id), 1, 'household handler limit');
    const gate = deferred(); releases.push(gate.resolve);
    await gate.promise;
    active--; perHousehold.set(id, perHousehold.get(id) - 1);
    return { note: { local: ctx.db === ctx.household.db } };
  });
  const [a, b, c] = fx.contexts();
  const runs = [a.scheduler.runNow('plan'), a.scheduler.runNow('freshness'), b.scheduler.runNow('plan'), c.scheduler.runNow('plan')];
  await turn();
  assert.deepEqual(started, [a.householdId, b.householdId]);
  releases.shift()();
  await turn();
  assert.equal(started[2], c.householdId, 'waiting household precedes a second turn');
  while (releases.length) { releases.shift()(); await turn(); }
  const results = await Promise.all(runs);
  assert.ok(results.every(r => r.status === 'ok'));
});

test('scheduled periods, failures and restart remain independent', { timeout: 15000 }, async t => {
  let failId;
  const seen = [];
  const fx = await fixture(t, async ctx => {
    seen.push([ctx.household.householdId, ctx.periodKey, ctx.trigger]);
    assert.equal(ctx.db, ctx.household.db);
    if (ctx.household.householdId === failId) throw Object.assign(new Error('private diagnostic'), { code: 'synthetic_failure' });
    return { note: { completed: true } };
  }, 2);
  const [a, b] = fx.contexts(); failId = a.householdId;
  await Promise.all([a.scheduler.tick(), b.scheduler.tick()]);
  const ar = a.scheduler.runs({ limit: 20 }); const br = b.scheduler.runs({ limit: 20 });
  assert.equal(ar.length, 3); assert.equal(br.length, 3);
  assert.ok(ar.every(r => r.status === 'error' && r.errorClass === 'synthetic_failure'));
  assert.ok(br.every(r => r.status === 'ok'));
  assert.equal(ar.find(r => r.jobId === 'plan').id, br.find(r => r.jobId === 'plan').id);
  assert.equal(ar.find(r => r.jobId === 'plan').periodKey, br.find(r => r.jobId === 'plan').periodKey);
  await fx.restart();
  const [aa, bb] = fx.contexts();
  await Promise.all([aa.scheduler.tick(), bb.scheduler.tick()]);
  assert.equal(seen.length, 6, 'restart does not replay claimed periods');
  for (const reason of ['ingest', 'confirm', 'decide']) await bb.scheduler.trigger('plan', reason);
  bb.scheduler.soon('plan', 'confirm', { immediate: true });
  await turn();
  assert.equal(aa.scheduler.runs({ limit: 20 }).length, 3);
  assert.equal(bb.scheduler.runs({ limit: 20 }).length, 7);
});

test('queued work rechecks pause and generation before claiming, and valid work resumes', { timeout: 15000 }, async t => {
  const gates = [deferred(), deferred()]; let n = 0;
  const fx = await fixture(t, async () => { const index = n++; if (index < 2) await gates[index].promise; });
  const [a, b, c] = fx.contexts();
  const first = a.scheduler.runNow('plan'); const second = b.scheduler.runNow('plan');
  const refused = assert.rejects(c.scheduler.runNow('plan'), e => e.code === 'paused');
  await turn();
  fx.platform.prepare('UPDATE household_outbound SET jobs = 0 WHERE household_id = ?').run(c.householdId);
  gates.forEach(g => g.resolve());
  await Promise.all([first, second, refused]);
  assert.equal(c.scheduler.runs().length, 0);
  fx.platform.prepare('UPDATE household_outbound SET jobs = 1 WHERE household_id = ?').run(c.householdId);
  assert.equal((await c.scheduler.runNow('plan')).status, 'ok');
  fx.platform.prepare('UPDATE households SET generation = generation + 1 WHERE id = ?').run(c.householdId);
  await assert.rejects(c.scheduler.runNow('freshness'), e => e.code === 'paused');
});

test('planner refuses integers that do not identify a running local plan claim', async t => {
  const fx = await fixture(t, async () => ({}), 2);
  const [a, b] = fx.contexts();
  const run = await a.scheduler.runNow('plan');
  await assert.rejects(runPlanning(b.db, null, { now: '2026-11-05', runId: run.id }), /claimed|claim|runId/);
  await assert.rejects(runPlanning(a.db, null, { now: '2026-11-05', runId: run.id }), /claimed|claim|runId/);
});
