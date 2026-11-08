import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tempDb, tempInstance, spawnAuthenticatedServer, request } from './helpers/server.mjs';
import { seedDemo } from '../demo/seed.mjs';
import demo from '../demo/scenario.mjs';
import { setSetting } from '../src/store/db.mjs';
import { upsertFact } from '../src/store/facts.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { buildPace } from '../src/pace/build.mjs';
import { goalCreate, goalUpdate } from '../src/api/goals.mjs';
import { callTool } from '../src/tools/index.mjs';
import { assertRefsResolve } from './helpers/figures.mjs';

const clock = '2032-06-29';
// A real instance (store plus its synthetic platform.sqlite), so the server can start on it.
async function store(t) {
  const s = await tempInstance({ mode: 'real', init: async db => { await setSetting(db, 'clock', clock); await setSetting(db, 'mode', 'real'); } });
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  return s;
}
async function account(db, id, date = clock, amount = 18000) {
  await db.prepare("INSERT OR IGNORE INTO sources (id,label,as_of,kind) VALUES ('ing:savings','Savings export',?,'balances')").run(date);
  await db.prepare("INSERT INTO accounts (id,name,kind,source_id) VALUES (?, 'Savings', 'savings','ing:savings')").run(id);
  await db.prepare("INSERT INTO balances (account_id,date,amount,parser,locator) VALUES (?,?,?,'fixture','balance')").run(id,date,amount);
}
async function putGoal(db, overrides = {}) {
  const g = { id: 'goal', title: 'Savings', target: 36600, targetDate: '2033-01-01', track: { accounts: ['a'] },
    pace: { startDate: '2032-01-01', startValue: 0 }, ...overrides };
  await db.prepare("INSERT INTO goals (id,def,origin,created_at,updated_at) VALUES (?,?, 'owner',?,?)").run(g.id,JSON.stringify(g),clock,clock);
  return g;
}
const ctx = (db, body = {}, id = 'goal') => ({ db, body, params: { id }, config: { clock } });
const withoutEnvelopes = value => Array.isArray(value) ? value.map(withoutEnvelopes)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'envelope').map(([key, child]) => [key, withoutEnvelopes(child)])) : value;

test('account pace uses complete stored balances, bounds the clock and retains the oldest dependency date', async t => {
  const { db } = await store(t);
  await account(db, 'a', '2032-06-01', 10000);
  await account(db, 'b', '2032-03-01', 8000);
  await putGoal(db, { track: { accounts: ['a', 'b'] } });
  await db.prepare("INSERT INTO balances (account_id,date,amount) VALUES ('b','2033-01-01',99999)").run();
  let r = (await buildPace(db, { clock })).goals[0];
  assert.equal(r.status, 'unknown');
  assert.equal(r.reason, 'stale_data');
  assert.equal(r.dataThrough, '2032-03-01');
  assert.equal(r.actual.v, 18000);
  await db.prepare("INSERT INTO balances (account_id,date,amount) VALUES ('b',?,8000)").run(clock);
  r = (await buildPace(db, { clock })).goals[0];
  assert.equal(r.status, 'on pace');
  assert.equal(r.dataThrough, '2032-06-01');
  assert.ok(r.actual.locator.sources.some(s => s.rows?.table === 'balances'));
  await db.prepare("DELETE FROM balances WHERE account_id = 'a'").run();
  assert.equal((await buildPace(db, { clock })).goals[0].actual, null);
});

test('fresh transactions do not refresh old balances, and position-only accounts work', async t => {
  const { db } = await store(t);
  await account(db, 'a', '2032-01-01');
  await putGoal(db);
  await db.prepare("INSERT INTO transactions (account_id,date,amount,description) VALUES ('a',?,1,'Deposit')").run(clock);
  assert.equal((await buildPace(db, { clock })).goals[0].reason, 'stale_data');
  await db.prepare("INSERT INTO positions (account_id,as_of,symbol,value) VALUES ('a',?,'TEST',18000)").run(clock);
  assert.equal((await buildPace(db, { clock })).goals[0].status, 'on pace');
});

test('actual figures resolve nested row dependencies and unavailable figures stay unknown', async t => {
  const { db } = await store(t);
  await account(db, 'a');
  const id = (await db.prepare('SELECT id FROM balances').get()).id;
  await db.prepare("INSERT INTO sources (id,label) VALUES ('calc:cash','Cash calculation')").run();
  const fig = db.prepare("INSERT INTO figures (key,v,src,kind,label,locator,updated_at) VALUES (?,18000,'calc:cash','a','Cash',?,?)");
  await fig.run('part', JSON.stringify({ rows: { table: 'balances', ids: [id], count: 1 } }), clock);
  await fig.run('cash.total', JSON.stringify({ rows: { table: 'figures', ids: ['part'], count: 1 } }), clock);
  await putGoal(db, { track: { figure: 'cash.total' } });
  assert.equal((await buildPace(db, { clock })).goals[0].status, 'on pace');
  await db.prepare("INSERT INTO balances (account_id,date,amount) VALUES ('a','2032-03-01',5000)").run();
  assert.equal((await buildPace(db, { clock })).series.goals.goal.series[2].actual.v, 5000);
  await db.prepare("UPDATE figures SET unavailable_reason = 'waiting' WHERE key = 'part'").run();
  assert.equal((await buildPace(db, { clock })).goals[0].status, 'unknown');
});

test('goal saves preserve baselines for unchanged values, and initialize legacy goals', async t => {
  const { db } = await store(t);
  await account(db, 'a'); await account(db, 'b', clock, 100);
  const g = await putGoal(db, { track: { accounts: ['a','b'] } });
  let r = await goalUpdate(ctx(db, { title: 'Renamed', target: g.target, targetDate: g.targetDate, track: { accounts: ['b','a'] } }));
  assert.deepEqual(r.goal.pace, g.pace);
  r = await goalUpdate(ctx(db, { target: 40000 }));
  assert.equal(r.goal.pace.startValue, 18100);
  assert.equal(r.goal.pace.startDate, clock);
  await db.prepare("UPDATE goals SET def = ? WHERE id = 'goal'").run(JSON.stringify({ ...g, pace: null }));
  r = await goalUpdate(ctx(db, { note: 'A note' }));
  assert.equal(r.goal.pace.startValue, 18100);
  const created = await goalCreate(ctx(db, { title: 'New', target: 50000, targetDate: '2033-01-01', track: { accounts: ['a'] } }));
  assert.equal(created.goal.pace.startValue, 18000);
});

test('monthly series and meters return explicit missing reasons and live when stored inputs exist', async t => {
  const { db } = await store(t);
  await account(db, 'a'); await putGoal(db);
  let r = await buildPace(db, { clock });
  assert.equal(r.series.householdSavings.series, null);
  assert.ok(r.series.householdSavings.reason);
  for (const m of Object.values(r.meters)) { assert.equal(m.meter, null); assert.ok(m.reason); }
  const fact = async (key, value) => await upsertFact(db, { key, value, src: 'you', asOf: clock, confirmed: true });
  await fact('pace.retirement.2032', { used: 20000, limit: 50000, asOf: clock });
  await fact('pace.tax.2032', { reserved: 10000, owed: 20000, asOf: clock });
  await fact('pace.householdSavings.2032', { startDate: '2032-01-01', startValue: 0, target: 36600, targetDate: '2033-01-01', observations: [{ date: clock, value: 18000 }] });
  r = await buildPace(db, { clock });
  assert.equal(r.meters.retirement.meter.ratio.v, 0.4);
  assert.equal(r.meters.retirement.deadline, '2032-12-31');
  assert.equal(r.meters.tax.meter.ratio.v, 0.5);
  assert.equal(r.series.householdSavings.series.length, 12);
  assert.equal(r.series.householdSavings.series[5].gap.v, 0);
});

test('demo targets match the existing synthetic scenario and stale health is detected', async t => {
  const { db } = await store(t); await setSetting(db, 'mode', 'demo'); await seedDemo(db);
  const r = await buildPace(db, { clock: demo.meta.clock });
  for (const [id, amount] of [['reserve',117900], ['port3',1978000]]) {
    const g = r.goals.find(g => g.id === id);
    assert.equal(g.actual.v, amount);
    assert.equal(g.status, 'unknown');
    assert.equal(g.reason, 'stale_data');
    assert.match(g.dataThrough, /^2026-08-/);
    const seed = demo.goals.find(g => g.id === id);
    assert.equal(g.target.v, demo.fig[seed.progress.target].v);
  }
  const fresh = await buildPace(db, { clock: '2026-08-30' });
  assert.notEqual(fresh.goals.find(g => g.id === 'port3').status, 'unknown');
  assert.equal(r.goals.find(g => g.id === 'port3').targetDate, '2029-12-31');
  assert.equal(r.goals.find(g => g.id === 'arena').status, 'no target');
});

test('income meter uses current-year actual income, explicit plan and nested source rows', async t => {
  const { db } = await store(t);
  await db.prepare("INSERT INTO sources (id,label) VALUES ('pnl','Business ledger')").run();
  await db.prepare("INSERT INTO pnl_lines (entity,period,category,amount) VALUES ('Example Business','2032-05','Income',18000)").run();
  const id = (await db.prepare('SELECT id FROM pnl_lines').get()).id;
  await db.prepare("INSERT INTO figures (key,v,kind,src,label,locator,updated_at) VALUES ('inc.ytd.total',18000,'a','pnl','Income',?,?)")
    .run(JSON.stringify({ rows: { table: 'pnl_lines', ids: [id], count: 1 } }),clock);
  await upsertFact(db, { key: 'pace.income.2032', value: { annualPlan: 36600, asOf: clock }, src: 'you', confirmed: true, asOf: clock });
  let m = (await buildPace(db, { clock })).meters.income;
  assert.equal(m.meter.used.v, 18000);
  assert.equal(m.meter.ratio.v, m.meter.used.v / m.meter.limit.v);
  assert.equal(m.dataThrough, '2032-05-31');
  assert.equal(m.reason, null);
  await db.prepare("UPDATE pnl_lines SET period = '2031-05'").run();
  m = (await buildPace(db, { clock })).meters.income;
  assert.equal(m.meter, null);
});

test('GET pace, scenario and MCP share the deterministic read-only result, including known health', async t => {
  let s;
  t.after(async () => { if (s) await s.stop(); });
  const { db, dataDir } = await store(t);
  await account(db, 'a'); await putGoal(db);
  await upsertFact(db, { key: 'pace.tax.2032', value: { reserved: 10000, owed: 20000, asOf: clock }, asOf: clock, src: 'you', confirmed: true });
  const before = (await db.prepare('SELECT total_changes() AS n').get()).n;
  const direct = await buildPace(db, { clock });
  assert.deepEqual((await buildScenario(db)).pace, direct);
  const toolResult = await callTool('goals', { operation: 'pace', }, { db, clock });
  assert.deepEqual(withoutEnvelopes(toolResult), direct);
  await assertRefsResolve(toolResult, { db, clock });
  assert.equal((await db.prepare('SELECT total_changes() AS n').get()).n, before);
  s = await spawnAuthenticatedServer({ dataDir, env: { FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_CLOCK: clock } });
  const response = await s.request({ path: '/api/pace' });
  assert.equal(response.status, 200);
  assert.equal(response.json.goals[0].status, 'on pace');
  assert.equal(response.json.meters.tax.meter.ratio.v, 0.5);
  assert.deepEqual(response.json, (await s.request({ path: '/api/scenario' })).json.pace);
  for (const headers of [{}, { 'tailscale-user-login': s.session.user.email }]) {
    assert.equal((await request(s.baseUrl, { path: '/api/pace', headers })).status, 401);
  }
  const create = await s.postJson('/api/goals', { title: 'New savings', target: 40000, targetDate: '2033-01-01', track: { accounts: ['a'] } });
  assert.equal(create.status, 200);
  assert.equal(create.json.goal.pace.startValue, 18000);
});

test('demo pace envelopes preserve every figure, its unit, data date and replayable reference', async t => {
  const s = await tempDb();
  t.after(() => s.close());
  await seedDemo(s.db);
  const demoClock = demo.meta.clock;
  const year = demoClock.slice(0, 4);
  await upsertFact(s.db, { key: `pace.retirement.${year}`, value: { used: 1, limit: 3, asOf: demoClock },
    src: 'you', asOf: demoClock, confirmed: true });
  const context = { db: s.db, clock: demoClock };
  const direct = await buildPace(s.db, { clock: demoClock });
  const result = await callTool('goals', { operation: 'pace', }, context);
  assert.deepEqual(withoutEnvelopes(result), direct);
  const seen = { days: 0, count: 0, ratio: 0, usd: 0, series: 0 };
  function visit(value, path = '', through = null) {
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'dataThrough')) through = value.dataThrough;
    if (Object.hasOwn(value, 'v') && value.src === 'calc:pace' && value.locator) {
      const unit = path.endsWith('.gapDays') ? 'days' : path.startsWith('rollup.') ? 'count'
        : path.endsWith('.ratio') ? 'ratio' : 'usd';
      seen[unit]++;
      if (path.startsWith('series.')) seen.series++;
      assert.equal(value.locator.unit, unit, `${path} producer unit`);
      assert.equal(value.locator.dataThrough, through, `${path} producer data date`);
      assert.equal(value.envelope.unit, unit, `${path} envelope unit`);
      assert.equal(value.envelope.asOf, through, `${path} envelope data date`);
      assert.equal(value.envelope.value, value.v, `${path} preserves the produced value`);
      assert.deepEqual(value.envelope.ref, { tool: 'goals', args: { operation: 'pace', }, path: `${path}.envelope` });
      if (unit === 'count') assert.ok(Number.isInteger(value.v), `${path} is an integer`);
      if (unit === 'usd' || unit === 'days') assert.equal(value.v, Math.round(value.v * 100) / 100, `${path} rounds to cents`);
      return;
    }
    for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key, through);
  }
  visit(result);
  for (const [area, count] of Object.entries(seen)) assert.ok(count > 0, `${area} figures were checked`);
  const meter = result.meters.retirement.meter;
  assert.equal(meter.ratio.v, meter.used.v / meter.limit.v);
  assert.equal(meter.ratio.envelope.value, meter.used.v / meter.limit.v);
  await assertRefsResolve(result, context);
});

// Suggested goal targets, Revision 1 item 8: a plan that starts at or above its target is a flat
// reached path, so an accepted already-covered goal reads 'Reached' instead of an unknown pace.
test('a plan that starts at or above its target is reached while the fresh actual stays there', async t => {
  const { db } = await store(t);
  await account(db, 'a', clock, 40000);
  await putGoal(db, { pace: { startDate: '2032-01-01', startValue: 40000 } });
  const r = (await buildPace(db, { clock })).goals[0];
  assert.equal(r.status, 'ahead');
  assert.equal(r.timeGap, 'Reached');
  assert.equal(r.reason, null);
  assert.equal(r.expected.v, 36600);
  assert.equal(r.expected.kind, 'p');
  assert.equal(r.gap.v, 3400);
  assert.equal(r.gapDays, null);
});

test('a reached plan with stale data stays unknown', async t => {
  const { db } = await store(t);
  await account(db, 'a', '2032-01-01', 40000);
  await putGoal(db, { pace: { startDate: '2032-01-01', startValue: 40000 } });
  const r = (await buildPace(db, { clock })).goals[0];
  assert.equal(r.status, 'unknown');
  assert.equal(r.reason, 'stale_data');
  assert.equal(r.timeGap, null);
});

test('a reached plan whose actual has fallen below the target is behind', async t => {
  const { db } = await store(t);
  await account(db, 'a', clock, 30000);
  await putGoal(db, { pace: { startDate: '2032-01-01', startValue: 40000 } });
  const r = (await buildPace(db, { clock })).goals[0];
  assert.equal(r.status, 'behind');
  assert.equal(r.timeGap, null);
  assert.equal(r.expected.v, 36600);
});

test('a reached plan has a monthly series for the Pace board', async t => {
  const { db } = await store(t);
  await account(db, 'a', clock, 36600);
  await putGoal(db, { pace: { startDate: '2032-01-01', startValue: 36600 } });
  const s = (await buildPace(db, { clock })).series.goals.goal;
  assert.equal(s.reason, null);
  assert.ok(Array.isArray(s.series), 'series is not null');
  assert.equal(s.series.length, 12);
  assert.ok(s.series.every(m => m.plan.v === 36600), 'the plan stays at the target');
  assert.equal(s.series[5].actual.v, 36600);
});
