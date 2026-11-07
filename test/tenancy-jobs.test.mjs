import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempDb } from './helpers/server.mjs';
import { setSetting } from '../src/store/db.mjs';
import { createScheduler } from '../src/jobs/scheduler.mjs';
import { runPlanning } from '../src/jobs/planner.mjs';

const quiet = { log() {} };
const turn = () => new Promise(resolve => setImmediate(resolve));
const gate = () => { let release; const promise = new Promise(r => { release = r; }); return { promise, release }; };

async function fixture(t, count = 3) {
  const { createJobDispatcher } = await import('../src/jobs/dispatcher.mjs');
  const dispatcher = createJobDispatcher();
  const stores = [];
  const schedulers = [];
  let instant = '2026-11-05T15:00:00.000Z';
  for (let i = 0; i < count; i++) stores.push(await tempDb());
  const make = (i, handlers) => {
    const household = Object.freeze({ householdId: `synthetic-${i}`, db: stores[i].db });
    const scheduler = createScheduler({ db: household.db, household: () => household, dispatcher,
      householdId: household.householdId, handlers, now: () => new Date(instant), log: quiet });
    schedulers.push(scheduler);
    return scheduler;
  };
  t.after(async () => {
    await Promise.all(schedulers.map(s => s.stop()));
    for (const store of stores) { store.close(); rmSync(store.dataDir, { recursive: true, force: true }); }
  });
  return { stores, make, setTime: value => { instant = value; } };
}

test('households admit one handler each and two instance-wide, with round-robin progress', async t => {
  const f = await fixture(t);
  const gates = Array.from({ length: 5 }, gate);
  const calls = [];
  let active = 0;
  let peak = 0;
  const handler = (name, n) => async ctx => {
    calls.push(name);
    assert.equal(ctx.db, ctx.household.db);
    peak = Math.max(peak, ++active);
    await gates[n].promise;
    active--;
  };
  const a = f.make(0, { plan: handler('a-plan', 0), freshness: handler('a-fresh', 2), 'confirm-guess': handler('a-guess', 4) });
  const b = f.make(1, { plan: handler('b-plan', 1) });
  const c = f.make(2, { plan: handler('c-plan', 3) });
  const runs = [a.runNow('plan'), b.runNow('plan'), a.runNow('freshness'), a.runNow('confirm-guess'), c.runNow('plan')];
  await turn();
  assert.deepEqual(calls, ['a-plan', 'b-plan']);
  gates[0].release();
  await runs[0]; await turn();
  assert.deepEqual(calls, ['a-plan', 'b-plan', 'c-plan'], 'another household gets the next admission before A repeats');
  gates[1].release(); await runs[1]; await turn();
  assert.equal(calls[3], 'a-fresh');
  gates[2].release(); gates[3].release(); gates[4].release();
  await Promise.all(runs);
  assert.equal(peak, 2);
});

test('equal job periods, failures, restart catch-up and trigger reruns stay household-local', async t => {
  const f = await fixture(t, 2);
  const seen = [[], []];
  const handlers = i => ({ plan: async ctx => {
    seen[i].push(ctx.trigger);
    if (i === 0) throw Object.assign(new Error('private synthetic failure'), { code: 'synthetic_failure' });
    return { note: { planned: 1 } };
  } });
  const a = f.make(0, handlers(0));
  const b = f.make(1, handlers(1));
  await Promise.all([a.tick(), b.tick()]);
  assert.deepEqual(seen, [['scheduled'], ['scheduled']]);
  assert.equal(a.runs()[0].status, 'error');
  assert.equal(b.runs()[0].status, 'ok');
  assert.equal(a.runs()[0].periodKey, b.runs()[0].periodKey);
  assert.ok(!JSON.stringify(a.runs()).includes('private synthetic failure'));
  await a.stop(); await b.stop();
  const restartedA = f.make(0, handlers(0));
  const restartedB = f.make(1, handlers(1));
  await Promise.all([restartedA.tick(), restartedB.tick()]);
  assert.deepEqual(seen, [['scheduled'], ['scheduled']]);
  f.setTime('2026-11-08T15:00:00.000Z');
  await Promise.all([restartedA.tick(), restartedB.tick()]);
  assert.deepEqual(seen, [['scheduled', 'scheduled'], ['scheduled', 'scheduled']]);
  await restartedB.trigger('plan', 'ingest');
  restartedB.soon('plan', 'confirm', { immediate: true });
  await turn(); await turn();
  assert.deepEqual(seen[0], ['scheduled', 'scheduled']);
  assert.ok(seen[1].includes('ingest') && seen[1].includes('confirm'));
});

test('a handler can queue follow-up jobs without deadlocking its household admission', async t => {
  const f = await fixture(t, 2);
  const seen = [];
  const a = f.make(0, {
    'simplefin-sync': async ctx => { await ctx.triggerJob('freshness'); ctx.triggerJob('plan'); },
    freshness: async () => { seen.push('freshness'); }, plan: async () => { seen.push('plan'); },
  });
  const b = f.make(1, { plan: async () => { seen.push('other'); } });
  await Promise.all([a.runNow('simplefin-sync'), b.runNow('plan')]);
  for (let i = 0; i < 10; i++) await turn();
  assert.deepEqual([...seen].sort(), ['freshness', 'other', 'plan']);
  assert.equal(b.runs().length, 1);
  assert.equal(a.runs().length, 3);
});

test('a queued household pause prevents claims and resuming admits valid work', async t => {
  const f = await fixture(t, 1);
  const hold = gate();
  let allowed = true;
  const s = createScheduler({ db: f.stores[0].db, allowed: () => allowed, log: quiet,
    handlers: { plan: () => hold.promise, freshness: async () => ({}) } });
  t.after(() => s.stop());
  const first = s.runNow('plan');
  const next = s.runNow('freshness');
  await turn(); allowed = false; hold.release(); await first;
  await assert.rejects(next, { code: 'paused' });
  assert.equal(s.runs().length, 1);
  allowed = true;
  assert.equal((await s.runNow('freshness')).status, 'ok');
});

test('planner refuses integers that are not a claimed local running plan job', async t => {
  const store = await tempDb();
  t.after(() => { store.close(); rmSync(store.dataDir, { recursive: true, force: true }); });
  setSetting(store.db, 'mode', 'real');
  await assert.rejects(async () => runPlanning(store.db, null, { runId: 7331 }), /claimed.*plan|plan.*claimed/);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM planner_recs').get().n, 0);
});
