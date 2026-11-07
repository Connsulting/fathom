// Item 20: goals and the tradeoff curve as owner-editable data. The goals API (create, edit,
// archive, delete, validation), progress from tracked sources with provenance, curve positions,
// planner goal linking and ranking, the household summary, and the Ask goal proposal through the
// fake engine.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { seedDemo } from '../demo/seed.mjs';
import { loadConfig } from '../src/config.mjs';
import { getSetting } from '../src/store/db.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { callTool } from '../src/tools/index.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { createLivePacks } from '../src/packs/live.mjs';
import { createLiveAnswerer, ownerAmounts } from '../src/api/answerer.mjs';
import { goalCreate, goalUpdate, goalArchive, goalDelete, curveSet } from '../src/api/goals.mjs';
import { threadCreate, demoReset } from '../src/api/handlers.mjs';
import { HttpError } from '../src/api/http.mjs';
import { validateGoal, servesGoals, CURVE_AXES } from '../src/shared/goals.mjs';
import { sortOrder, curveLean } from '../src/jobs/planner/recs.mjs';
import { tempDb, tempInstance } from './helpers/server.mjs';

const NOW = '2032-03-10T12:00:00.000Z';

// A demo store is a demo instance (createInstance layout) so handlers that need the household
// context (demo reset clears its vault and its platform keys) get one; a plain store is a temp
// store whose directory stands in as the household root.
async function store(t, { demo = false } = {}) {
  const s = demo ? await tempInstance({ mode: 'demo', init: seedDemo }) : await tempDb();
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  const config = { clock: '2032-03-10', dataDir: s.dataDir };
  const household = demo ? await s.household(config) : null;
  const root = household ? household.root : s.dataDir;
  const ctx = (body = {}, params = {}) => ({ db: s.db, config, body, params, household, platform: s.platform ?? null });
  return { ...s, root, config, ctx };
}

// Two mirrored accounts with stored balances and one without.
function seedAccounts(db) {
  db.prepare("INSERT INTO sources (id, label, as_of) VALUES ('bank', 'Bank export', '2032-03-01')").run();
  const acct = db.prepare('INSERT INTO accounts (id, inst, name, kind, fig_key, parser) VALUES (?, ?, ?, ?, ?, ?)');
  acct.run('a1', 'Example Bank', 'Savings', 'checking', 'bal.a1', 'test');
  acct.run('a2', 'Example Broker', 'Retirement', 'retirement', 'bal.a2', 'test');
  acct.run('a3', 'Example Bank', 'New account', 'checking', null, 'test');
  const fig = db.prepare("INSERT INTO figures (key, v, src, kind, label, updated_at) VALUES (?, ?, 'bank', 'a', ?, ?)");
  fig.run('bal.a1', 12000, 'Savings', NOW);
  fig.run('bal.a2', 30000, 'Retirement', NOW);
  fig.run('cash.total', 15000, 'Cash', NOW);
}

const rejects = (fn, status, re) => assert.throws(fn, e => e instanceof HttpError && e.status === status && (!re || re.test(e.message)));

test('create, edit, archive, restore and delete an owner goal', async t => {
  const s = await store(t);
  const r = goalCreate(s.ctx({ title: '  A year of cash  ', horizon: '1-3y', target: 60000, targetDate: '2034-01-31', note: 'Parked.' }));
  const g = r.goal;
  assert.match(g.id, /^g[a-f0-9]{12}$/);
  assert.equal(g.title, 'A year of cash');
  assert.equal(g.origin, 'owner');
  assert.equal(g.horizon, '1-3y');
  assert.equal(g.archived, false);
  assert.deepEqual(r.scenario.fig[`goal.${g.id}.target`], { v: 60000, src: 'goal-target', kind: 't', label: 'Goal target' });
  assert.equal(r.scenario.src['goal-target'].label, 'You typed this');
  assert.equal(g.progress, undefined, 'no tracked value, no progress');

  const e = goalUpdate(s.ctx({ title: 'Twelve months of cash', target: null }, { id: g.id })).goal;
  assert.equal(e.title, 'Twelve months of cash');
  assert.equal(e.note, 'Parked.', 'absent fields keep their value');
  assert.equal(e.target, null);

  assert.equal(goalArchive(s.ctx({}, { id: g.id })).goal.archived, true);
  assert.equal(goalArchive(s.ctx({ archived: false }, { id: g.id })).goal.archived, false);
  const d = goalDelete(s.ctx({}, { id: g.id }));
  assert.equal(d.scenario.goals.length, 0);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM goals').get().n, 0);
  rejects(() => goalDelete(s.ctx({}, { id: g.id })), 404);
});

test('goal input validation: required title, length caps, horizons, non-negative targets, real dates, known sources', async t => {
  const s = await store(t);
  seedAccounts(s.db);
  rejects(() => goalCreate(s.ctx({})), 400, /title is required/);
  rejects(() => goalCreate(s.ctx({ title: '   ' })), 400, /title is required/);
  rejects(() => goalCreate(s.ctx({ title: 'x'.repeat(121) })), 400, /over 120/);
  rejects(() => goalCreate(s.ctx({ title: 'two\nlines' })), 400, /not allowed/);
  rejects(() => goalCreate(s.ctx({ title: 'ok', note: 'n'.repeat(501) })), 400, /over 500/);
  rejects(() => goalCreate(s.ctx({ title: 'ok', horizon: 'someday' })), 400, /horizon/);
  rejects(() => goalCreate(s.ctx({ title: 'ok', target: -1 })), 400, /negative/);
  rejects(() => goalCreate(s.ctx({ title: 'ok', target: '500' })), 400, /number/);
  rejects(() => goalCreate(s.ctx({ title: 'ok', target: Infinity })), 400);
  rejects(() => goalCreate(s.ctx({ title: 'ok', targetDate: '2032-02-30' })), 400, /date/);
  rejects(() => goalCreate(s.ctx({ title: 'ok', targetDate: 'soon' })), 400, /date/);
  rejects(() => goalCreate(s.ctx({ title: 'ok', track: { accounts: ['nope'] } })), 400, /unknown account/);
  rejects(() => goalCreate(s.ctx({ title: 'ok', track: { figure: 'bal.a1' } })), 400, /unknown figure/, 'only known figures');
  rejects(() => goalCreate(s.ctx({ title: 'ok', track: { figure: 'cash.personal' } })), 400, /unknown figure/, 'a known figure the store lacks');
  rejects(() => goalCreate(s.ctx({ title: 'ok', track: 'a1' })), 400, /track/);
  rejects(() => goalUpdate(s.ctx({ title: 'x' }, { id: '../etc' })), 404);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM goals').get().n, 0, 'nothing written');
  // Zero is a valid target; markup is stored as typed.
  const g = goalCreate(s.ctx({ title: '<b>{f:x}</b>', target: 0 })).goal;
  assert.equal(g.title, '<b>{f:x}</b>');
  assert.equal(g.target, 0);
  assert.equal(validateGoal({ title: 'a', target: 1.006 }).value.target, 1.01);
});

test('progress comes from tracked stored data with its provenance, never a partial sum', async t => {
  const s = await store(t);
  seedAccounts(s.db);
  const one = goalCreate(s.ctx({ title: 'Savings goal', target: 24000, track: { accounts: ['a1'] } })).goal;
  assert.deepEqual(one.progress, { cur: 'bal.a1', target: `goal.${one.id}.target` }, 'one account: its own figure and source');
  assert.equal(one.trackLabel, 'Savings');

  const two = goalCreate(s.ctx({ title: 'Everything', target: 84000, track: { accounts: ['a1', 'a2'] } }));
  const cur = two.scenario.fig[`goal.${two.goal.id}.current`];
  assert.deepEqual(cur, { v: 42000, src: 'goal-track', kind: 'a', label: 'Goal progress: tracked accounts' });
  assert.equal(two.goal.progress.cur, `goal.${two.goal.id}.current`);

  const fig = goalCreate(s.ctx({ title: 'Cash', target: 30000, track: { figure: 'cash.total' } })).goal;
  assert.equal(fig.progress.cur, 'cash.total');
  assert.equal(fig.trackLabel, 'All cash');

  const waiting = goalCreate(s.ctx({ title: 'New money', target: 1000, track: { accounts: ['a1', 'a3'] } }));
  assert.equal(waiting.goal.progress, undefined);
  assert.equal(waiting.goal.trackWaiting, true);
  assert.equal(waiting.scenario.fig[`goal.${waiting.goal.id}.current`], undefined);

  // A figure kept only for reference (not current) never feeds a goal or the model.
  s.db.prepare("UPDATE figures SET unavailable_reason = 'Account reclassified' WHERE key = 'bal.a1'").run();
  const stale = buildScenario(s.db, { clock: s.config.clock }).goals.find(g => g.id === one.id);
  assert.equal(stale.progress, undefined);
  assert.equal(stale.current, undefined);
  assert.equal(stale.trackWaiting, true);
  const sum = await callTool('household_summary', {}, { db: s.db, now: NOW });
  assert.equal(sum.goals.find(g => g.id === one.id).current, undefined);
  s.db.prepare("UPDATE figures SET unavailable_reason = NULL WHERE key = 'bal.a1'").run();

  const noTarget = goalCreate(s.ctx({ title: 'Just tracking', track: { accounts: ['a1'] } })).goal;
  assert.equal(noTarget.progress, undefined, 'no target, no bar');
  assert.equal(noTarget.current, 'bal.a1');
});

test('seed goals can be archived and deleted but not edited; demo reset restores them', async t => {
  const s = await store(t, { demo: true });
  const before = buildScenario(s.db, { clock: s.config.clock }).goals.map(g => g.id);
  rejects(() => goalUpdate(s.ctx({ title: 'x' }, { id: 'reserve' })), 409, /demo/);
  goalArchive(s.ctx({}, { id: 'reserve' }));
  goalCreate(s.ctx({ title: 'A boat' }));
  curveSet(s.ctx({ id: 'ret_life', value: 0.9 }));
  const mid = buildScenario(s.db, { clock: s.config.clock });
  assert.equal(mid.goals.find(g => g.id === 'reserve').archived, true);
  assert.equal(mid.goals.length, before.length + 1);
  await demoReset(s.ctx());
  const after = buildScenario(s.db, { clock: s.config.clock });
  assert.deepEqual(after.goals.map(g => g.id), before);
  assert.ok(after.goals.every(g => !g.archived && g.origin === 'seed'));
  assert.equal(getSetting(s.db, 'curve.positions', null), null);
});

test('curve positions persist, validate and feed onboarding priorities on a real store', async t => {
  const s = await store(t);
  const sc = buildScenario(s.db, { clock: s.config.clock });
  assert.deepEqual(sc.curve.map(c => c.id), CURVE_AXES.map(a => a.id), 'a real store gets the default axes');
  assert.ok(sc.curve.every(c => c.value === 0.5));
  assert.deepEqual(sc.onboarding.priorities.map(p => p.id), CURVE_AXES.map(a => a.id));
  assert.equal(sc.onboarding.priorities[0].label, 'Pay less tax this year vs Keep cash flexible');

  const r = curveSet(s.ctx({ id: 'tax_cash', value: 0.234 }));
  assert.equal(r.scenario.curve.find(c => c.id === 'tax_cash').value, 0.23);
  assert.equal(r.scenario.onboarding.priorities.find(p => p.id === 'tax_cash').value, 0.23, 'one setting feeds both');
  curveSet(s.ctx({ positions: { effort: 1, human: 0 } }));
  assert.deepEqual(getSetting(s.db, 'curve.positions', null), { tax_cash: 0.23, effort: 1, human: 0 });
  rejects(() => curveSet(s.ctx({ id: 'nope', value: 0.5 })), 400, /unknown/);
  rejects(() => curveSet(s.ctx({ id: 'effort', value: 1.5 })), 400, /0 to 1/);
  rejects(() => curveSet(s.ctx({ id: 'effort', value: '0.5' })), 400, /0 to 1/);
  rejects(() => curveSet(s.ctx({ positions: [] })), 400);
});

test('recs link to the goals they serve, by topic, and archived goals do not link', async t => {
  const s = await store(t, { demo: true });
  const sc = buildScenario(s.db, { clock: s.config.clock });
  const rec = id => sc.recs.find(r => r.id === id);
  assert.deepEqual(rec('va529').serves.map(g => g.id), ['kids'], 'the 529 rec serves the education goal');
  assert.ok(rec('spsep').serves.some(g => g.id === 'port4'), 'a retirement rec serves the retirement goal');
  assert.deepEqual(rec('umbrella').serves, [], 'serves is always an array');
  assert.equal(rec('umbrella').housekeeping, true);
  assert.equal(rec('va529').housekeeping, false);

  // A rec links at most three goals; archive the demo's contribution goal (a retirement goal too)
  // so the new owner goal is within the cap.
  goalArchive(s.ctx({}, { id: 'ira-fill' }));
  const g = goalCreate(s.ctx({ title: 'Retire at 55' })).goal;
  const after = goalCreate(s.ctx({ title: 'unrelated' })).scenario;
  assert.ok(after.recs.find(r => r.id === 'backdoor').serves.some(x => x.id === g.id && x.origin === 'owner'));
  const archived = goalArchive(s.ctx({}, { id: g.id })).scenario;
  assert.ok(!archived.recs.find(r => r.id === 'backdoor').serves.some(x => x.id === g.id));

  // A specific topic beats tax; tracking a 529 account makes a goal an education goal.
  const goals = [{ id: 't', title: 'Pay less tax' }, { id: 'c', title: 'Kids', track: { accounts: ['x'] } }];
  assert.deepEqual(servesGoals({ id: 'va529', goalKinds: ['education', 'tax'] }, goals, [{ id: 'x', kind: '529' }]).map(x => x.id), ['c']);
  assert.deepEqual(servesGoals({ id: 'vaq4', goalKinds: ['tax'] }, goals, []).map(x => x.id), ['t']);
});

test('the planner ranks recs that tie on their window by goal, then by curve lean', () => {
  const hit = (id, rec, close = '2032-12-31') => ({ state: 'hit', trigger: { id }, hit: { rec: { id, ...rec }, window: { close } } });
  const results = [
    hit('umbrella', { domain: 'family', goalKinds: [] }),
    hit('hsa-room', { domain: 'retirement', goalKinds: ['health', 'retirement', 'tax'] }),
    hit('dependent-care-fsa', { domain: 'family', goalKinds: ['tax', 'cash'] }),
    hit('early', { domain: 'family', goalKinds: [] }, '2032-06-30'),
  ];
  const plain = sortOrder(results);
  assert.deepEqual([...plain.keys()], ['early', 'umbrella', 'hsa-room', 'dependent-care-fsa'], 'no prefs: window, then catalog order');
  const goals = [{ id: 'g', title: 'A cash reserve' }];
  const withGoal = sortOrder(results, { goals });
  assert.deepEqual([...withGoal.keys()], ['early', 'dependent-care-fsa', 'umbrella', 'hsa-room'], 'the rec serving a goal moves up within its window');
  const leanRetire = sortOrder(results, { curve: { ret_life: 0.1 } });
  assert.deepEqual([...leanRetire.keys()], ['early', 'hsa-room', 'umbrella', 'dependent-care-fsa']);
  assert.ok(curveLean({ goalKinds: ['retirement'] }, { ret_life: 0.1 }) > 0);
  assert.equal(curveLean({ goalKinds: [] }, { ret_life: 0.1 }), 0);
  // Topics come from goal kinds only: a domain alone no longer leans or links.
  assert.equal(curveLean({ domain: 'retirement' }, { ret_life: 0.1 }), 0);
});

test('the household summary grounds on goals, typed targets and curve leans', async t => {
  const s = await store(t);
  seedAccounts(s.db);
  goalCreate(s.ctx({ title: 'Savings goal', horizon: '3-10y', target: 24000, track: { accounts: ['a1'] } }));
  const hidden = goalCreate(s.ctx({ title: 'Hidden' })).goal;
  goalArchive(s.ctx({}, { id: hidden.id }));
  curveSet(s.ctx({ id: 'ret_life', value: 0.2 }));
  const sum = await callTool('household_summary', {}, { db: s.db, now: NOW });
  assert.equal(sum.goals.length, 1, 'archived goals are left out');
  const g = sum.goals[0];
  assert.equal(g.title, 'Savings goal');
  assert.equal(g.horizon, 'Long range');
  assert.deepEqual(g.target, { amount: 24000, source: 'you' });
  assert.deepEqual(g.current, { amount: 12000, kind: 'a' });
  assert.equal(sum.curve.find(c => c.between.startsWith('Max retirement')).leansToward, 'Max retirement room');
  assert.equal(sum.curve.find(c => c.between.startsWith('Pay less tax')).leansToward, 'no lean');
  const list = await callTool('list_goals', {}, { db: s.db, now: NOW });
  assert.deepEqual(list, sum.goals);
});

async function fakeAnswerer(s) {
  const config = loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake' });
  const engine = createRuntimeEngine({ db: s.db, config });
  const packs = createLivePacks(s.db, { dataDir: s.root });
  packs.refresh();
  return { engine, answerer: createLiveAnswerer({ engine, packs, root: s.root }) };
}

test('"add a goal" in Ask saves a goal with a durable Undo receipt', async t => {
  const s = await store(t, { demo: true });
  const { engine, answerer } = await fakeAnswerer(s);
  const before = s.db.prepare('SELECT count(*) n FROM goals').get().n;
  const r = await threadCreate({ db: s.db, config: s.config, answerer, engine, body: { text: 'Add a goal: a boat fund of $40k, next few years' }, params: {} });
  assert.equal(s.db.prepare('SELECT count(*) n FROM goals').get().n, before + 1);
  assert.ok(r.message.provenance.tools.some(x => x.name === 'create_goal'));
  assert.equal(r.message.provenance.actions[0].after.target, 40000);
  assert.equal(r.message.provenance.actions[0].after.horizon, '1-3y');
});

test('a proposed target survives only when the owner stated that amount', () => {
  assert.deepEqual([...ownerAmounts('save $40k and 1.5 million, or 12,000')].sort((a, b) => a - b), [12000, 40000, 1500000]);
  assert.equal(ownerAmounts('a boat').size, 0);
});
