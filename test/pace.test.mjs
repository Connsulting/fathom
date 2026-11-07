import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tempDb, spawnServer, request, postJson } from './helpers/server.mjs';
import { seedDemo } from '../demo/seed.mjs';
import demo from '../demo/scenario.mjs';
import { setSetting } from '../src/store/db.mjs';
import { upsertFact } from '../src/store/facts.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { buildPace } from '../src/pace/build.mjs';
import { goalCreate, goalUpdate } from '../src/api/goals.mjs';
import { callTool } from '../src/tools/index.mjs';

const clock = '2032-06-29';
async function store(t) {
  const s = await tempDb();
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  setSetting(s.db, 'clock', clock);
  setSetting(s.db, 'mode', 'real');
  return s;
}
function account(db, id, date = clock, amount = 18000) {
  db.prepare("INSERT OR IGNORE INTO sources (id,label,as_of,kind) VALUES ('ing:savings','Savings export',?,'balances')").run(date);
  db.prepare("INSERT INTO accounts (id,name,kind,source_id) VALUES (?, 'Savings', 'savings','ing:savings')").run(id);
  db.prepare("INSERT INTO balances (account_id,date,amount,parser,locator) VALUES (?,?,?,'fixture','balance')").run(id,date,amount);
}
function putGoal(db, overrides = {}) {
  const g = { id: 'goal', title: 'Savings', target: 36600, targetDate: '2033-01-01', track: { accounts: ['a'] },
    pace: { startDate: '2032-01-01', startValue: 0 }, ...overrides };
  db.prepare("INSERT INTO goals (id,def,origin,created_at,updated_at) VALUES (?,?, 'owner',?,?)").run(g.id,JSON.stringify(g),clock,clock);
  return g;
}
const ctx = (db, body = {}, id = 'goal') => ({ db, body, params: { id }, config: { clock } });

test('account pace uses complete stored balances, bounds the clock and retains the oldest dependency date', async t => {
  const { db } = await store(t);
  account(db, 'a', '2032-06-01', 10000);
  account(db, 'b', '2032-03-01', 8000);
  putGoal(db, { track: { accounts: ['a', 'b'] } });
  db.prepare("INSERT INTO balances (account_id,date,amount) VALUES ('b','2033-01-01',99999)").run();
  let r = buildPace(db, { clock }).goals[0];
  assert.equal(r.status, 'unknown');
  assert.equal(r.reason, 'stale_data');
  assert.equal(r.dataThrough, '2032-03-01');
  assert.equal(r.actual.v, 18000);
  db.prepare("INSERT INTO balances (account_id,date,amount) VALUES ('b',?,8000)").run(clock);
  r = buildPace(db, { clock }).goals[0];
  assert.equal(r.status, 'on pace');
  assert.equal(r.dataThrough, '2032-06-01');
  assert.ok(r.actual.locator.sources.some(s => s.rows?.table === 'balances'));
  db.prepare("DELETE FROM balances WHERE account_id = 'a'").run();
  assert.equal(buildPace(db, { clock }).goals[0].actual, null);
});

test('fresh transactions do not refresh old balances, and position-only accounts work', async t => {
  const { db } = await store(t);
  account(db, 'a', '2032-01-01');
  putGoal(db);
  db.prepare("INSERT INTO transactions (account_id,date,amount,description) VALUES ('a',?,1,'Deposit')").run(clock);
  assert.equal(buildPace(db, { clock }).goals[0].reason, 'stale_data');
  db.prepare("INSERT INTO positions (account_id,as_of,symbol,value) VALUES ('a',?,'TEST',18000)").run(clock);
  assert.equal(buildPace(db, { clock }).goals[0].status, 'on pace');
});

test('actual figures resolve nested row dependencies and unavailable figures stay unknown', async t => {
  const { db } = await store(t);
  account(db, 'a');
  const id = db.prepare('SELECT id FROM balances').get().id;
  db.prepare("INSERT INTO sources (id,label) VALUES ('calc:cash','Cash calculation')").run();
  const fig = db.prepare("INSERT INTO figures (key,v,src,kind,label,locator,updated_at) VALUES (?,18000,'calc:cash','a','Cash',?,?)");
  fig.run('part', JSON.stringify({ rows: { table: 'balances', ids: [id], count: 1 } }), clock);
  fig.run('cash.total', JSON.stringify({ rows: { table: 'figures', ids: ['part'], count: 1 } }), clock);
  putGoal(db, { track: { figure: 'cash.total' } });
  assert.equal(buildPace(db, { clock }).goals[0].status, 'on pace');
  db.prepare("UPDATE figures SET unavailable_reason = 'waiting' WHERE key = 'part'").run();
  assert.equal(buildPace(db, { clock }).goals[0].status, 'unknown');
});

test('goal saves preserve baselines for unchanged values, and initialize legacy goals', async t => {
  const { db } = await store(t);
  account(db, 'a'); account(db, 'b', clock, 100);
  const g = putGoal(db, { track: { accounts: ['a','b'] } });
  let r = goalUpdate(ctx(db, { title: 'Renamed', target: g.target, targetDate: g.targetDate, track: { accounts: ['b','a'] } }));
  assert.deepEqual(r.goal.pace, g.pace);
  r = goalUpdate(ctx(db, { target: 40000 }));
  assert.equal(r.goal.pace.startValue, 18100);
  assert.equal(r.goal.pace.startDate, clock);
  db.prepare("UPDATE goals SET def = ? WHERE id = 'goal'").run(JSON.stringify({ ...g, pace: null }));
  r = goalUpdate(ctx(db, { note: 'A note' }));
  assert.equal(r.goal.pace.startValue, 18100);
  const created = goalCreate(ctx(db, { title: 'New', target: 50000, targetDate: '2033-01-01', track: { accounts: ['a'] } }));
  assert.equal(created.goal.pace.startValue, 18000);
});

test('monthly series and meters return explicit missing reasons and live when stored inputs exist', async t => {
  const { db } = await store(t);
  account(db, 'a'); putGoal(db);
  let r = buildPace(db, { clock });
  assert.equal(r.series.householdSavings.series, null);
  assert.ok(r.series.householdSavings.reason);
  for (const m of Object.values(r.meters)) { assert.equal(m.meter, null); assert.ok(m.reason); }
  const fact = (key, value) => upsertFact(db, { key, value, src: 'you', asOf: clock, confirmed: true });
  fact('pace.retirement.2032', { used: 20000, limit: 50000, asOf: clock });
  fact('pace.tax.2032', { reserved: 10000, owed: 20000, asOf: clock });
  fact('pace.householdSavings.2032', { startDate: '2032-01-01', startValue: 0, target: 36600, targetDate: '2033-01-01', observations: [{ date: clock, value: 18000 }] });
  r = buildPace(db, { clock });
  assert.equal(r.meters.retirement.meter.ratio.v, 0.4);
  assert.equal(r.meters.retirement.deadline, '2032-12-31');
  assert.equal(r.meters.tax.meter.ratio.v, 0.5);
  assert.equal(r.series.householdSavings.series.length, 12);
  assert.equal(r.series.householdSavings.series[5].gap.v, 0);
});

test('demo targets match the existing synthetic scenario and stale health is detected', async t => {
  const { db } = await store(t); setSetting(db, 'mode', 'demo'); seedDemo(db);
  const r = buildPace(db, { clock: demo.meta.clock });
  for (const [id, amount] of [['reserve',117900], ['port3',1978000]]) {
    const g = r.goals.find(g => g.id === id);
    assert.equal(g.actual.v, amount);
    assert.equal(g.status, 'unknown');
    assert.equal(g.reason, 'stale_data');
    assert.match(g.dataThrough, /^2026-08-/);
    const seed = demo.goals.find(g => g.id === id);
    assert.equal(g.target.v, demo.fig[seed.progress.target].v);
  }
  const fresh = buildPace(db, { clock: '2026-08-30' });
  assert.notEqual(fresh.goals.find(g => g.id === 'port3').status, 'unknown');
  assert.equal(r.goals.find(g => g.id === 'port3').targetDate, '2029-12-31');
  assert.equal(r.goals.find(g => g.id === 'arena').status, 'no target');
});

test('income meter uses current-year actual income, explicit plan and nested source rows', async t => {
  const { db } = await store(t);
  db.prepare("INSERT INTO sources (id,label) VALUES ('pnl','Business ledger')").run();
  db.prepare("INSERT INTO pnl_lines (entity,period,category,amount) VALUES ('Example Business','2032-05','Income',18000)").run();
  const id = db.prepare('SELECT id FROM pnl_lines').get().id;
  db.prepare("INSERT INTO figures (key,v,kind,src,label,locator,updated_at) VALUES ('inc.ytd.total',18000,'a','pnl','Income',?,?)")
    .run(JSON.stringify({ rows: { table: 'pnl_lines', ids: [id], count: 1 } }),clock);
  upsertFact(db, { key: 'pace.income.2032', value: { annualPlan: 36600, asOf: clock }, src: 'you', confirmed: true, asOf: clock });
  let m = buildPace(db, { clock }).meters.income;
  assert.equal(m.meter.used.v, 18000);
  assert.equal(m.meter.ratio.v, 0.49);
  assert.equal(m.dataThrough, '2032-05-31');
  assert.equal(m.reason, null);
  db.prepare("UPDATE pnl_lines SET period = '2031-05'").run();
  m = buildPace(db, { clock }).meters.income;
  assert.equal(m.meter, null);
});

test('GET pace, scenario and MCP share the deterministic read-only result, including known health', async t => {
  const { db, dataDir } = await store(t);
  account(db, 'a'); putGoal(db);
  upsertFact(db, { key: 'pace.tax.2032', value: { reserved: 10000, owed: 20000, asOf: clock }, asOf: clock, src: 'you', confirmed: true });
  const before = db.prepare('SELECT total_changes() AS n').get().n;
  const direct = buildPace(db, { clock });
  assert.deepEqual(buildScenario(db).pace, direct);
  assert.deepEqual(await callTool('get_pace', {}, { db, clock }), direct);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, before);
  const s = await spawnServer({ dataDir, env: { FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_CLOCK: clock } });
  t.after(() => s.stop());
  const response = await request(s.baseUrl, { path: '/api/pace' });
  assert.equal(response.status, 200);
  assert.equal(response.json.goals[0].status, 'on pace');
  assert.equal(response.json.meters.tax.meter.ratio.v, 0.5);
  assert.deepEqual(response.json, (await request(s.baseUrl, { path: '/api/scenario' })).json.pace);
  assert.equal((await request(s.baseUrl, { path: '/api/pace', headers: { 'tailscale-user-login': undefined } })).status, 401);
  const create = await postJson(s.baseUrl, '/api/goals', { title: 'New savings', target: 40000, targetDate: '2033-01-01', track: { accounts: ['a'] } });
  assert.equal(create.status, 200);
  assert.equal(create.json.goal.pace.startValue, 18000);
});
