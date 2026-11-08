import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempInstance } from './helpers/server.mjs';
import { createHouseholdStorage } from '../src/platform/db.mjs';
import { createRuntimeRegistry, createHouseholdContext, openHouseholdDb } from '../src/platform/runtime.mjs';
import { runPlanning } from '../src/jobs/planner.mjs';

const quiet = { log() {} };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(r => setImmediate(r));

async function fixture(t, handler, count = 3) {
  const instance = await tempInstance();
  const ids = [instance.householdId];
  for (let i = 1; i < count; i++) {
    const id = `hh_synthetic_jobs_${i}`;
    await instance.platform.prepare("INSERT INTO households (id, status, mode, created_at, updated_at) VALUES (?, 'active', 'real', ?, ?)").run(id, i, i);
    await createHouseholdStorage({ platform: instance.platform, dataDir: instance.dataDir, householdId: id, mode: 'real', secrets: instance.secrets, enabled: true });
    ids.push(id);
  }
  const config = { dataDir: instance.dataDir, engine: 'off', clock: '2026-11-05', emailTransport: 'dev' };
  const makeRegistry = () => createRuntimeRegistry({
    platform: instance.platform, config, secrets: instance.secrets,
    build: async opts => await createHouseholdContext({ ...opts, db: await openHouseholdDb({ dataDir: opts.config.dataDir, householdId: opts.householdId, storageRoot: opts.relativeRoot }), handlers: {
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
  await fx.platform.prepare('UPDATE household_outbound SET jobs = 0 WHERE household_id = ?').run(c.householdId);
  gates.forEach(g => g.resolve());
  await Promise.all([first, second, refused]);
  assert.equal(c.scheduler.runs().length, 0);
  await fx.platform.prepare('UPDATE household_outbound SET jobs = 1 WHERE household_id = ?').run(c.householdId);
  assert.equal((await c.scheduler.runNow('plan')).status, 'ok');
  await fx.platform.prepare('UPDATE households SET generation = generation + 1 WHERE id = ?').run(c.householdId);
  await assert.rejects(c.scheduler.runNow('freshness'), e => e.code === 'paused');
});

test('planner refuses integers that do not identify a running local plan claim', async t => {
  const fx = await fixture(t, async () => ({}), 2);
  const [a, b] = fx.contexts();
  const run = await a.scheduler.runNow('plan');
  await assert.rejects(runPlanning(b.db, null, { now: '2026-11-05', runId: run.id }), /claimed|claim|runId/);
  await assert.rejects(runPlanning(a.db, null, { now: '2026-11-05', runId: run.id }), /claimed|claim|runId/);
});

test('manual HTTP, successful upload and Confirm dispatch only to the initiating household', { timeout: 60000 }, async () => {
  const { twoHouseholds, uploadFiles } = await import('./helpers/tenancy-runtime.mjs');
  const { aggregatorCsv } = await import('./helpers/ingest.mjs');
  const { ask, FACT_CHECK_OPTIONS } = await import('../src/ingest/confirm.mjs');
  const fx = await twoHouseholds({ engine: 'off' });
  try {
    await fx.B.client.postJson('/api/household/outbound', { jobs: true });
    const a = fx.ctx(fx.A.id); const b = fx.ctx(fx.B.id);
    await b.scheduler.tick();
    const before = b.scheduler.runs({ limit: 200 });
    assert.equal((await fx.A.client.postJson('/api/jobs/freshness/run', {})).status, 200);
    const uploaded = await uploadFiles(fx.baseUrl, fx.A.admin, [{ name: 'synthetic.csv', bytes: Buffer.from(aggregatorCsv([
      { date: '2026-11-01', amount: '18.25', description: 'Synthetic household purchase', number: '5550098765' },
    ])) }]);
    assert.equal(uploaded.status, 200, uploaded.text);
    assert.equal(uploaded.json.files[0].status, 'imported');
    for (let i = 0; i < 30; i++) await turn();
    assert.ok(a.scheduler.runs({ limit: 200 }).some(r => r.jobId === 'plan' && r.trigger === 'ingest'));
    const item = await ask(a.db, { kind: 'fact_check', subject: 'synthetic.scheduler', question: 'Use this synthetic fact?',
      options: FACT_CHECK_OPTIONS, context: { key: 'synthetic.scheduler', value: true }, now: '2026-11-05T12:00:00Z' });
    const answer = await fx.A.client.postJson(`/api/confirm/${item.id}/answer`, { answer: 'yes' });
    assert.equal(answer.status, 200, answer.text);
    const deadline = Date.now() + 35000;
    while (!a.scheduler.runs({ limit: 200 }).some(r => r.jobId === 'plan' && r.trigger === 'confirm') && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.ok(a.scheduler.runs({ limit: 200 }).some(r => r.jobId === 'plan' && r.trigger === 'confirm'));
    assert.deepEqual(b.scheduler.runs({ limit: 200 }), before);
  } finally { await fx.close(); }
});

test('SimpleFIN sync queues local planning and freshness without holding its handler slot', { timeout: 15000 }, async () => {
  const { seedDemo } = await import('../demo/seed.mjs');
  const { connectSimplefin, fakeToken, createFakeSimplefin } = await import('../src/ingest/simplefin.mjs');
  const instance = await tempInstance({ mode: 'demo', init: seedDemo });
  const other = 'hh_synthetic_simplefin';
  await instance.platform.prepare("INSERT INTO households (id, status, mode, created_at, updated_at) VALUES (?, 'active', 'demo', 1, 1)").run(other);
  await createHouseholdStorage({ platform: instance.platform, dataDir: instance.dataDir, householdId: other, mode: 'demo', secrets: instance.secrets, enabled: true });
  const config = { dataDir: instance.dataDir, engine: 'off', clock: '2026-11-05', emailTransport: 'dev' };
  const registry = createRuntimeRegistry({ platform: instance.platform, config, secrets: instance.secrets });
  try {
    const a = registry.get(instance.householdId); const b = registry.get(other);
    await connectSimplefin(a.db, fakeToken(), { household: a, now: '2026-11-05T12:00:00Z', fetch: createFakeSimplefin({ today: () => '2026-11-05' }) });
    const run = await a.scheduler.runNow('simplefin-sync');
    assert.equal(run.status, 'ok');
    assert.equal(run.note.changed, true);
    for (let i = 0; i < 30; i++) await turn();
    const runs = a.scheduler.runs();
    assert.ok(runs.some(r => r.jobId === 'plan' && r.trigger === 'ingest'));
    assert.ok(runs.some(r => r.jobId === 'freshness' && r.trigger === 'ingest'));
    assert.equal(b.scheduler.runs().length, 0);
    assert.equal((await b.db.prepare('SELECT count(*) AS n FROM transactions').get()).n, 0);
  } finally {
    await registry.close(); instance.close(); rmSync(instance.dataDir, { recursive: true, force: true });
  }
});

test('resolver answers queue a separate local plan claim after releasing the household slot', { timeout: 15000 }, async () => {
  const { ask, KIND_OPTIONS } = await import('../src/ingest/confirm.mjs');
  const instance = await tempInstance();
  const other = 'hh_synthetic_resolver';
  await instance.platform.prepare("INSERT INTO households (id, status, mode, created_at, updated_at) VALUES (?, 'active', 'real', 1, 1)").run(other);
  await createHouseholdStorage({ platform: instance.platform, dataDir: instance.dataDir, householdId: other, mode: 'real', secrets: instance.secrets, enabled: true });
  const registry = createRuntimeRegistry({ platform: instance.platform, config: {
    dataDir: instance.dataDir, engine: 'off', clock: '2026-11-05', emailTransport: 'dev',
  }, secrets: instance.secrets });
  try {
    const a = registry.get(instance.householdId); const b = registry.get(other);
    const seedQuestion = async ctx => {
      await ctx.db.prepare('INSERT INTO accounts (id,name,inst,mask) VALUES (?,?,?,?)').run('synthetic-checking', 'Synthetic checking', 'Example Bank', '1234');
      return (await ask(ctx.db, { kind: 'account_kind', subject: 'synthetic-checking', question: 'What kind of account is this?', options: KIND_OPTIONS, now: '2026-11-05T12:00:00Z' })).id;
    };
    const own = await seedQuestion(a); const foreign = await seedQuestion(b);
    const resolved = await a.scheduler.runNow('confirm-guess');
    assert.equal(resolved.status, 'ok', resolved.errorClass);
    assert.equal((await a.db.prepare('SELECT status FROM confirm_items WHERE id = ?').get(own)).status, 'answered');
    for (let i = 0; i < 30; i++) await turn();
    const planned = a.scheduler.runs().find(r => r.jobId === 'plan');
    assert.ok(planned, 'resolver queues a plan through its scheduler');
    assert.equal(planned.status, 'ok', planned.errorClass);
    assert.notEqual(planned.id, resolved.id);
    assert.equal(planned.trigger, 'resolve');
    assert.equal((await b.db.prepare('SELECT status FROM confirm_items WHERE id = ?').get(foreign)).status, 'pending');
    assert.equal(b.scheduler.runs().length, 0);
  } finally {
    await registry.close(); instance.close(); rmSync(instance.dataDir, { recursive: true, force: true });
  }
});
