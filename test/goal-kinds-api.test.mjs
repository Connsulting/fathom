// Goal model v2 through the real paths: the goals HTTP handlers (POST /api/goals and
// POST /api/goals/:id, as test/goals.test.mjs drives them), the scenario they answer with, Home's
// view model, and the update_goal.create, update_goal.edit, undo.undo, goals.list and goals.pace tools.
// Store-level contribution coverage (plan review r1 items 2 and 3) is checked through goals.pace.
// Fixtures are synthetic: invented accounts, balances, transactions and household names.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { tempDb } from './helpers/server.mjs';
import { seedDemo } from '../demo/seed.mjs';
import demo from '../demo/scenario.mjs';
import { setSetting } from '../src/store/db.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { goalCreate, goalUpdate, goalArchive } from '../src/api/goals.mjs';
import { HttpError } from '../src/api/http.mjs';
import { callTool, getTool } from '../src/tools/index.mjs';
import { homeModel } from '../web/horizon/screens/home-model.js';

const CLOCK = '2026-11-05';
const NOW = `${CLOCK}T12:00:00.000Z`;
const KEY = 'ask:0123456789ab';

async function store(t, { demo: withDemo = false } = {}) {
  const s = await tempDb();
  t.after(async () => { await s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  if (withDemo) await seedDemo(s.db);
  else await setSetting(s.db, 'clock', CLOCK);
  const config = { clock: CLOCK, dataDir: s.dataDir };
  const ctx = (body = {}, params = {}) => ({ db: s.db, config, body, params });
  return { ...s, config, ctx };
}

// Household checking, business checking, two Roth IRAs (one per person), a traditional IRA and an
// IRA whose holder is not set. Every account has a balance dated 2026-10-31 and a current figure.
async function seedAccounts(db) {
  await db.prepare("INSERT INTO sources (id, label, as_of) VALUES ('bank', 'Synthetic bank export', ?)").run(CLOCK);
  const acct = db.prepare('INSERT INTO accounts (id, inst, name, owner, kind, fig_key, parser) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const bal = db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?, ?, ?)');
  const fig = db.prepare("INSERT INTO figures (key, v, src, kind, label, updated_at) VALUES (?, ?, 'bank', 'a', ?, ?)");
  for (const [id, name, owner, kind, amount] of [
    ['chk', 'Household checking', 'Joint', 'checking', 6000],
    ['biz', 'Business checking', 'Business', 'business', 12000],
    ['r1', 'Roth IRA one', 'You', 'roth', 20000],
    ['r2', 'Roth IRA two', 'Your spouse', 'roth', 15000],
    ['r3', 'Traditional IRA', 'You', 'retirement', 40000],
    ['r4', 'Shared IRA', null, 'retirement', 9000],
  ]) {
    await acct.run(id, 'Example Institution', name, owner, kind, `bal.${id}`, 'test');
    await bal.run(id, '2026-10-31', amount);
    await fig.run(`bal.${id}`, amount, name, NOW);
  }
}

const txn = async (db, account, date, amount, description = 'Deposit') =>
  Number((await db.prepare('INSERT INTO transactions (account_id, date, amount, description) VALUES (?, ?, ?, ?) RETURNING id').get(account, date, amount, description)).id);

const rejects = (fn, status, re) => assert.throws(fn, e => e instanceof HttpError && e.status === status && (!re || re.test(e.message)),
  `expected ${status}${re ? ` matching ${re}` : ''}`);
const defOf = async (db, id) => JSON.parse((await db.prepare('SELECT def FROM goals WHERE id = ?').get(id)).def);
const rowOf = async (db, id) => await db.prepare('SELECT * FROM goals WHERE id = ?').get(id);
const goalFig = (v, label, kind = 't') => ({ v, src: 'goal-target', kind, label });

const RANGE = Object.freeze({ title: 'Household checking in a working range', kind: 'range', owner: 'joint', priority: 'medium',
  targetLow: 4000, targetHigh: 8000, targetDate: '2026-12-31', track: { accounts: ['chk'] } });
const FLOOR = Object.freeze({ title: 'Business floor', kind: 'floor', owner: 'owner', priority: 'high', floor: 10000, track: { accounts: ['biz'] } });
const SPLIT = Object.freeze([{ person: 'owner', amount: 7000 }, { person: 'spouse', amount: 7000 }]);
const ENTERED = Object.freeze({ asOf: '2026-11-01', people: [{ person: 'owner', amount: 3000 }, { person: 'spouse', amount: 1500 }] });
const CONTRIB = Object.freeze({ title: 'Fill both IRAs', kind: 'contribution', owner: 'joint', priority: 'low', target: 14000, taxYear: 2026,
  targetDate: '2027-04-15', accounts: ['r1', 'r2'], split: SPLIT, entered: ENTERED });

/* ---------- create and edit over HTTP ---------- */

test('POST /api/goals creates a range, a floor and a contribution and the scenario carries their fields', async t => {
  const s = await store(t);
  await seedAccounts(s.db);

  const r = await goalCreate(s.ctx({ ...RANGE }));
  const range = r.goal;
  assert.match(range.id, /^g[a-f0-9]{12}$/);
  assert.equal(range.origin, 'owner');
  for (const [k, v] of Object.entries({ kind: 'range', owner: 'joint', priority: 'medium', status: 'open', targetLow: 4000, targetHigh: 8000, targetDate: '2026-12-31' })) {
    assert.deepEqual(range[k], v, `range ${k}`);
  }
  assert.equal(range.doneAt, null);
  assert.deepEqual(r.scenario.fig[`goal.${range.id}.low`], goalFig(4000, 'Range low end'));
  assert.deepEqual(r.scenario.fig[`goal.${range.id}.high`], goalFig(8000, 'Range high end'));
  assert.deepEqual(range.progress, { cur: 'bal.chk', target: `goal.${range.id}.low` }, 'range progress reads against the low end');
  assert.ok((await defOf(s.db, range.id)).pace, 'a range captures a pace path from the tracked balance');

  const f = await goalCreate(s.ctx({ ...FLOOR }));
  const floor = f.goal;
  assert.equal(floor.kind, 'floor');
  assert.equal(floor.owner, 'owner');
  assert.equal(floor.priority, 'high');
  assert.equal(floor.floor, 10000);
  assert.deepEqual(f.scenario.fig[`goal.${floor.id}.floor`], goalFig(10000, 'Floor'));
  const floorDef = await defOf(s.db, floor.id);
  assert.equal(floorDef.pace, null, 'a floor has no pace path');
  for (const k of ['target', 'targetDate', 'targetLow', 'targetHigh', 'taxYear', 'split', 'entered', 'accounts', 'status']) {
    assert.equal(Object.hasOwn(floorDef, k), false, `the floor def has no ${k}`);
  }

  const c = await goalCreate(s.ctx({ ...CONTRIB }));
  const contrib = c.goal;
  for (const [k, v] of Object.entries({ kind: 'contribution', owner: 'joint', priority: 'low', status: 'open', target: 14000, taxYear: 2026,
    targetDate: '2027-04-15', accounts: ['r1', 'r2'], split: SPLIT, entered: ENTERED })) {
    assert.deepEqual(contrib[k], v, `contribution ${k}`);
  }
  const fig = c.scenario.fig;
  assert.deepEqual(fig[`goal.${contrib.id}.target`], goalFig(14000, 'Goal target'));
  assert.deepEqual(fig[`goal.${contrib.id}.split.owner`], goalFig(7000, 'Share of the contribution'));
  assert.deepEqual(fig[`goal.${contrib.id}.split.spouse`], goalFig(7000, 'Share of the contribution'));
  assert.deepEqual(fig[`goal.${contrib.id}.entered`], goalFig(4500, 'Contributed so far, as you entered', 'a'));
  assert.deepEqual(fig[`goal.${contrib.id}.entered.owner`], goalFig(3000, 'Contributed so far, as you entered', 'a'));
  assert.deepEqual(fig[`goal.${contrib.id}.entered.spouse`], goalFig(1500, 'Contributed so far, as you entered', 'a'));
  assert.equal(typeof contrib.accountsLabel, 'string');
  assert.equal(contrib.accountsLabel.split(', ').length, 2, 'both destination accounts are named');
  const contribDef = await defOf(s.db, contrib.id);
  assert.equal(contribDef.pace, null, 'a contribution has no captured path');
  assert.equal(Object.hasOwn(contribDef, 'track'), false);
  assert.equal(Object.hasOwn(contribDef, 'status'), false, 'status is never stored in the def');

  // A total entered amount is one figure.
  const total = await goalCreate(s.ctx({ ...CONTRIB, title: 'One IRA', split: null, entered: { asOf: '2026-11-01', total: 2500 } }));
  assert.deepEqual(total.scenario.fig[`goal.${total.goal.id}.entered`], goalFig(2500, 'Contributed so far, as you entered', 'a'));
  assert.equal(total.scenario.fig[`goal.${total.goal.id}.split.owner`], undefined);

  // A plain balance goal still reads as before, with the new defaults.
  const plain = (await goalCreate(s.ctx({ title: 'A year of cash', target: 30000, targetDate: '2027-12-31', track: { accounts: ['chk'] } }))).goal;
  assert.equal(plain.kind, 'balance');
  assert.equal(plain.owner, null);
  assert.equal(plain.priority, null);
  assert.equal(plain.status, 'open');
  assert.deepEqual(plain.progress, { cur: 'bal.chk', target: `goal.${plain.id}.target` });
});

test('POST /api/goals/:id switches kind and drops the old kind\'s fields', async t => {
  const s = await store(t);
  await seedAccounts(s.db);
  const g = (await goalCreate(s.ctx({ title: 'Checking cushion', target: 5000, targetDate: '2027-06-30', track: { accounts: ['chk'] } }))).goal;
  assert.ok((await defOf(s.db, g.id)).pace);

  const asFloor = (await goalUpdate(s.ctx({ kind: 'floor', floor: 3000 }, { id: g.id }))).goal;
  assert.equal(asFloor.kind, 'floor');
  assert.equal(asFloor.floor, 3000);
  assert.deepEqual(asFloor.track, { accounts: ['chk'] }, 'the tracked account carries over to the floor');
  const floorDef = await defOf(s.db, g.id);
  assert.equal(Object.hasOwn(floorDef, 'target'), false, 'no target left in the def');
  assert.equal(Object.hasOwn(floorDef, 'targetDate'), false, 'no target date left in the def');
  assert.equal(floorDef.pace, null);
  assert.equal(floorDef.title, 'Checking cushion', 'common fields are kept');

  const back = (await goalUpdate(s.ctx({ kind: 'balance', target: 9000, targetDate: '2027-06-30' }, { id: g.id }))).goal;
  assert.equal(back.kind, 'balance');
  const balanceDef = await defOf(s.db, g.id);
  assert.equal(Object.hasOwn(balanceDef, 'floor'), false);
  assert.ok(balanceDef.pace && balanceDef.pace.startValue === 6000, 'back to balance captures a pace path');

  // A range edit that leaves the ends alone keeps the path; moving the low end recaptures.
  const r = (await goalCreate(s.ctx({ ...RANGE }))).goal;
  const path = (await defOf(s.db, r.id)).pace;
  await goalUpdate(s.ctx({ title: 'Renamed range', targetHigh: 9000 }, { id: r.id }));
  assert.deepEqual((await defOf(s.db, r.id)).pace, path);
  await goalUpdate(s.ctx({ title: 'A partial edit keeps the kind' }, { id: r.id }));
  assert.equal((await defOf(s.db, r.id)).kind, 'range');
  assert.equal((await defOf(s.db, r.id)).targetLow, 4000);
});

test('bad kind fields answer 400 with the validation message', async t => {
  const s = await store(t);
  await seedAccounts(s.db);
  rejects(async () => await goalCreate(s.ctx({ ...RANGE, targetLow: 9000 })), 400, /^the low end must not be above the high end$/);
  rejects(async () => await goalCreate(s.ctx({ ...RANGE, targetHigh: undefined })), 400, /^a range needs a low end and a high end$/);
  rejects(async () => await goalCreate(s.ctx({ ...FLOOR, track: null })), 400, /^a floor needs something to track$/);
  rejects(async () => await goalCreate(s.ctx({ ...FLOOR, floor: null })), 400, /^a floor needs an amount$/);
  rejects(async () => await goalCreate(s.ctx({ ...FLOOR, targetDate: '2026-12-31' })), 400, /^targetDate does not apply to a floor goal$/);
  rejects(async () => await goalCreate(s.ctx({ ...CONTRIB, taxYear: undefined })), 400, /^a contribution needs a tax year$/);
  rejects(async () => await goalCreate(s.ctx({ ...CONTRIB, targetDate: '2026-01-01' })), 400, /^the deadline must be after January 1 of the tax year$/);
  rejects(async () => await goalCreate(s.ctx({ ...CONTRIB, target: 15000 })), 400, /^the split must add up to the amount$/);
  rejects(async () => await goalCreate(s.ctx({ ...CONTRIB, accounts: ['r1', 'nope'] })), 400, /account/);
  rejects(async () => await goalCreate(s.ctx({ title: 'Plain', floor: 100 })), 400, /^floor does not apply to a balance goal$/);
  rejects(async () => await goalCreate(s.ctx({ title: 'Plain', owner: 'you' })), 400, /^owner must be owner, spouse, joint or a dependent key such as kid$/);
  rejects(async () => await goalCreate(s.ctx({ title: 'Plain', priority: 'urgent' })), 400, /priority/);
  rejects(async () => await goalCreate(s.ctx({ title: 'Plain', kind: 'savings' })), 400, /^kind must be one of balance, range, floor, contribution$/);
  rejects(async () => await goalCreate(s.ctx({ title: 'Plain', status: 'closed' })), 400, /status/);
  assert.equal((await s.db.prepare('SELECT count(*) n FROM goals').get()).n, 0, 'nothing written');

  const r = (await goalCreate(s.ctx({ ...RANGE }))).goal;
  rejects(async () => await goalUpdate(s.ctx({ targetHigh: 3000 }, { id: r.id })), 400, /^the low end must not be above the high end$/);
  rejects(async () => await goalUpdate(s.ctx({ floor: 5 }, { id: r.id })), 400, /^floor does not apply to a range goal$/);
  assert.equal((await defOf(s.db, r.id)).targetHigh, 8000, 'a refused edit changes nothing');
  assert.equal((await goalUpdate(s.ctx({ targetHigh: 9000 }, { id: r.id }))).goal.targetHigh, 9000, 'a valid edit saves');
  // Liveness: the valid shapes of every kind save.
  for (const body of [FLOOR, CONTRIB, { title: 'Owned balance', owner: 'kid', priority: 'high' }]) assert.equal((await goalCreate(s.ctx({ ...body }))).goal.status, 'open');
});

/* ---------- done and reopen ---------- */

test('status done and open mark a goal done and reopen it', async t => {
  const s = await store(t, { demo: true });
  // Education: the demo's only education goal is kids, so the 529 rec has room to link this one.
  const g = (await goalCreate(s.ctx({ title: 'A college fund', target: 200000, targetDate: '2034-08-31', track: { figure: 'plan529' } }))).goal;
  const live = sc => sc.recs.some(r => r.serves.some(x => x.id === g.id));
  const cards = sc => homeModel({ goals: sc.goals, pace: sc.pace, recs: sc.recs, filter: 'both', suggestions: sc.suggestions, clock: sc.meta.clock }).cards.map(c => c.id);
  const before = await buildScenario(s.db, { clock: CLOCK });
  assert.ok(live(before), 'the 529 rec serves the open goal');
  assert.ok(before.pace.goals.some(p => p.id === g.id));
  assert.ok(cards(before).includes(g.id));

  const done = await goalUpdate(s.ctx({ status: 'done' }, { id: g.id }));
  assert.equal(done.goal.status, 'done');
  assert.ok(done.goal.doneAt, 'doneAt is the done time');
  assert.equal(done.goal.archived, true, 'a done goal archives itself');
  const doneRow = await rowOf(s.db, g.id);
  assert.ok(doneRow.done_at, 'done_at is set');
  assert.ok(doneRow.archived_at, 'archived_at is set too');
  assert.equal(Object.hasOwn(JSON.parse(doneRow.def), 'status'), false, 'status is a column, not def text');
  assert.ok(done.scenario.goals.some(x => x.id === g.id && x.status === 'done'), 'a done goal stays in the scenario goals');
  assert.ok(!done.scenario.pace.goals.some(p => p.id === g.id), 'a done goal leaves pace');
  assert.equal(done.scenario.pace.series.goals[g.id], undefined, 'and its chart');
  assert.ok(!live(done.scenario), 'no rec serves a done goal');
  assert.ok(!cards(done.scenario).includes(g.id), 'a done goal has no Home card');
  const stamp = doneRow.done_at;
  await goalUpdate(s.ctx({ status: 'done', title: 'Retire at sixty' }, { id: g.id }));
  assert.equal((await rowOf(s.db, g.id)).done_at, stamp, 'marking done again keeps the first done time');

  const open = await goalUpdate(s.ctx({ status: 'open' }, { id: g.id }));
  assert.equal(open.goal.status, 'open');
  assert.equal((await rowOf(s.db, g.id)).done_at, null);
  assert.ok(open.scenario.pace.goals.some(p => p.id === g.id));
  assert.ok(live(open.scenario));
  assert.ok(cards(open.scenario).includes(g.id));

  // Archived through the body; then a done goal archived and restored through the archive route.
  const archived = await goalUpdate(s.ctx({ status: 'archived' }, { id: g.id }));
  assert.equal(archived.goal.status, 'archived');
  assert.equal(archived.goal.archived, true);
  assert.ok((await rowOf(s.db, g.id)).archived_at);
  await goalUpdate(s.ctx({ status: 'done' }, { id: g.id }));
  assert.ok((await rowOf(s.db, g.id)).archived_at, 'done keeps it archived');
  assert.equal((await goalArchive(s.ctx({}, { id: g.id }))).goal.status, 'done', 'a done goal that is archived reads done');
  assert.equal((await goalArchive(s.ctx({ archived: false }, { id: g.id }))).goal.status, 'open', 'restoring it reopens it');

  // Seed goals stay non-editable, status included.
  rejects(async () => await goalUpdate(s.ctx({ status: 'done' }, { id: 'reserve' })), 409, /demo/);
  rejects(async () => await goalUpdate(s.ctx({ status: 'done' }, { id: 'ira-fill' })), 409, /demo/);
  assert.equal((await rowOf(s.db, 'reserve')).done_at, null);
  const seedDone = (await buildScenario(s.db, { clock: CLOCK })).goals.find(x => x.id === 'mortgage');
  assert.equal(seedDone.status, 'done', 'a finished seed goal reads done');
  assert.equal(seedDone.statusLabel, 'done');
});

/* ---------- tools ---------- */

const toolCtx = (db, ownerText) => ({ db, now: NOW, actorId: 'person-a', ownerText, conversationKey: KEY, turnId: 'turn-a' });
const undo = (ctx, id) => callTool('undo', { operation: 'undo',  id }, { ...ctx, channel: 'mcp' });

test('the goal tool schemas list every new field', () => {
  const fields = ['kind', 'owner', 'priority', 'status', 'targetLow', 'targetHigh', 'floor', 'taxYear', 'accounts', 'split', 'entered'];
  for (const name of ['update_goal']) {
    const props = getTool(name).inputSchema.properties;
    for (const f of [...fields, 'title', 'target', 'targetDate', 'track']) assert.ok(Object.hasOwn(props, f), `${name} takes ${f}`);
    assert.doesNotMatch(getTool(name).description, /\u2014|\u2013/, `${name} description has no dashes`);
  }
  assert.deepEqual(getTool('update_goal').operations.find(o => o.name === 'create').required, ['title']);
  assert.deepEqual(getTool('update_goal').operations.find(o => o.name === 'edit').required, ['id']);
  assert.match(getTool('goals').description, /priority/);
});

test('update_goal.create and update_goal.edit take the new fields and need owner evidence for every amount and date', async t => {
  const s = await store(t);
  await seedAccounts(s.db);
  const said = toolCtx(s.db, 'Keep a floor of $3,000 in business checking, and it is high priority');
  await assert.rejects(callTool('update_goal', { operation: 'create',  ...FLOOR, floor: 3500 }, said), /stated|evidence/);
  await assert.rejects(callTool('update_goal', { operation: 'create',  ...FLOOR, floor: 3000, kind: 'florr' }, said));
  const floor = await callTool('update_goal', { operation: 'create',  ...FLOOR, floor: 3000 }, said);
  assert.equal(floor.goal.kind, 'floor');
  assert.equal(floor.goal.floor, 3000);
  assert.equal(floor.goal.status, 'open');
  assert.ok(floor.receipt, 'a receipt');
  assert.equal(floor.receipt.after.kind, 'floor');
  assert.equal(floor.receipt.after.floor, 3000);
  assert.equal(floor.receipt.after.priority, 'high');
  assert.equal(floor.receipt.after.status, 'open');

  const words = 'Fill both Roth IRAs for 2026: $7,000 each, $14,000 in total, by 2027-04-15. So far $3,000 and $1,500 as of 2026-11-01.';
  const c = toolCtx(s.db, words);
  for (const wrong of [
    { split: [{ person: 'owner', amount: 7500 }, { person: 'spouse', amount: 6500 }] },
    { entered: { asOf: '2026-11-01', people: [{ person: 'owner', amount: 3200 }, { person: 'spouse', amount: 1500 }] } },
    { entered: { asOf: '2026-10-15', people: ENTERED.people } },
    { taxYear: 2025, targetDate: '2026-04-15' },
  ]) await assert.rejects(callTool('update_goal', { operation: 'create',  ...CONTRIB, ...wrong }, c), /stated|evidence/, JSON.stringify(wrong));
  const contrib = await callTool('update_goal', { operation: 'create',  ...CONTRIB }, c);
  assert.equal(contrib.goal.kind, 'contribution');
  assert.deepEqual(contrib.goal.split, SPLIT);
  assert.deepEqual(contrib.receipt.after.entered, ENTERED);

  // Status, owner and priority need no evidence; an unstated amount on edit is still refused.
  const plain = toolCtx(s.db, 'Mark the business floor done');
  await assert.rejects(callTool('update_goal', { operation: 'edit',  id: floor.goal.id, floor: 2500 }, plain), /stated|evidence/);
  const pri = await callTool('update_goal', { operation: 'edit',  id: floor.goal.id, priority: 'low', owner: 'spouse' }, plain);
  assert.equal(pri.goal.priority, 'low');
  const done = await callTool('update_goal', { operation: 'edit',  id: floor.goal.id, status: 'done' }, plain);
  assert.equal(done.goal.status, 'done');
  assert.ok(done.receipt);
  assert.equal(done.receipt.after.status, 'done');
  assert.ok((await rowOf(s.db, floor.goal.id)).done_at);
  // A stored value is its own evidence.
  const same = await callTool('update_goal', { operation: 'edit',  id: floor.goal.id, floor: 3000, title: 'Business floor kept' }, plain);
  assert.equal(same.goal.title, 'Business floor kept');
  await assert.rejects(callTool('update_goal', { operation: 'edit',  id: 'reserve', status: 'done' }, plain), /no such goal|demo|cannot/);
});

test('undo of a create receipt after the goal is marked done is refused, and undo restores done_at', async t => {
  const s = await store(t);
  await seedAccounts(s.db);
  const ctx = toolCtx(s.db, 'Add a goal for a family trip');
  const created = await callTool('update_goal', { operation: 'create',  title: 'A family trip' }, ctx);
  const id = created.goal.id;
  const done = await callTool('update_goal', { operation: 'edit',  id, status: 'done' }, ctx);
  await assert.rejects(undo(ctx, created.receipt.id), /changed since/);
  assert.ok(await rowOf(s.db, id), 'the goal remains');
  assert.ok((await rowOf(s.db, id)).done_at, 'and stays done');

  // Undoing the status change restores done_at null; then the create can be undone.
  await undo(ctx, done.receipt.id);
  assert.equal((await rowOf(s.db, id)).done_at, null);
  assert.equal((await buildScenario(s.db, { clock: CLOCK })).goals.find(g => g.id === id).status, 'open');
  await undo(ctx, created.receipt.id);
  assert.equal(await rowOf(s.db, id), undefined, 'the create undid once nothing changed');
});

test('an old-shape receipt without done_at still refuses undo once the goal is done, and undoes when it is not', async t => {
  const s = await store(t);
  const ctx = toolCtx(s.db, 'Add two goals');
  const oldShape = async title => {
    const r = await callTool('update_goal', { operation: 'create',  title }, ctx);
    // A receipt written before migration 026 has no done_at in its after-state.
    await s.db.prepare("UPDATE action_receipts SET after_state = json_remove(after_state, '$.done_at') WHERE id = ?").run(r.receipt.id);
    assert.equal(Object.hasOwn(JSON.parse((await s.db.prepare('SELECT after_state FROM action_receipts WHERE id = ?').get(r.receipt.id)).after_state), 'done_at'), false);
    return r;
  };
  const marked = await oldShape('Marked done later');
  await goalUpdate(s.ctx({ status: 'done' }, { id: marked.goal.id }));
  await assert.rejects(undo(ctx, marked.receipt.id), /changed since/);
  assert.ok(await rowOf(s.db, marked.goal.id), 'the goal remains');

  const archived = await oldShape('Archived later');
  await goalArchive(s.ctx({}, { id: archived.goal.id }));
  await assert.rejects(undo(ctx, archived.receipt.id), /changed since/, 'archiving after a receipt also refuses undo');

  const untouched = await oldShape('Left alone');
  await undo(ctx, untouched.receipt.id);
  assert.equal(await rowOf(s.db, untouched.goal.id), undefined, 'an unchanged goal undoes from an old receipt');
});

test('goals.list carries kind, whose goal with its label, priority, status and kind amounts', async t => {
  const s = await store(t);
  await seedAccounts(s.db);
  await s.db.prepare("INSERT INTO content (key, value, src, updated_at) VALUES ('names', ?, NULL, ?)").run(JSON.stringify({ me: 'Person One', spouse: 'Person Two' }), NOW);
  const range = (await goalCreate(s.ctx({ ...RANGE }))).goal;
  const floor = (await goalCreate(s.ctx({ ...FLOOR }))).goal;
  const contrib = (await goalCreate(s.ctx({ ...CONTRIB }))).goal;
  const plain = (await goalCreate(s.ctx({ title: 'Nothing set' }))).goal;
  const done = (await goalCreate(s.ctx({ title: 'Finished goal', owner: 'spouse' }))).goal;
  await goalUpdate(s.ctx({ status: 'done' }, { id: done.id }));
  const gone = (await goalCreate(s.ctx({ title: 'Archived goal' }))).goal;
  await goalArchive(s.ctx({}, { id: gone.id }));

  const list = await callTool('goals', { operation: 'list', }, { db: s.db, now: NOW });
  const by = id => list.find(g => g.id === id);
  assert.equal(by(gone.id), undefined, 'an archived goal is not listed');
  assert.equal(by(done.id).status, 'done', 'a done goal is listed as done');
  assert.equal(by(done.id).ownerLabel, 'Person Two');

  const f = by(floor.id);
  assert.equal(f.kind, 'floor');
  assert.equal(f.owner, 'owner');
  assert.equal(f.ownerLabel, 'Person One');
  assert.equal(f.priority, 'high');
  assert.equal(f.status, 'open');
  assert.deepEqual(f.floor, { amount: 10000, source: 'you' });

  const r = by(range.id);
  assert.equal(r.ownerLabel, 'Joint');
  assert.deepEqual(r.range, { low: { amount: 4000, source: 'you' }, high: { amount: 8000, source: 'you' } });
  assert.equal(r.targetDate, '2026-12-31');

  const c = by(contrib.id);
  assert.equal(c.kind, 'contribution');
  assert.equal(c.priority, 'low');
  assert.deepEqual(c.target, { amount: 14000, source: 'you' });
  assert.equal(c.contribution.taxYear, 2026);
  assert.equal(c.contribution.deadline, '2027-04-15');
  assert.equal(typeof c.contribution.accounts, 'string');
  assert.equal(c.contribution.accounts.split(', ').length, 2, 'both destination accounts are named');
  assert.deepEqual(c.contribution.split, [
    { person: 'owner', label: 'Person One', amount: 7000, source: 'you' },
    { person: 'spouse', label: 'Person Two', amount: 7000, source: 'you' },
  ]);
  assert.equal(c.contribution.entered.asOf, '2026-11-01');
  assert.equal(c.contribution.entered.source, 'you');
  assert.deepEqual(c.contribution.entered.people.map(p => [p.person, p.amount]), [['owner', 3000], ['spouse', 1500]]);

  const p = by(plain.id);
  assert.equal(p.kind, 'balance');
  assert.equal(p.status, 'open');
  for (const k of ['owner', 'ownerLabel', 'priority', 'range', 'floor', 'contribution']) assert.equal(Object.hasOwn(p, k), false, `unset ${k} is left out`);

  // The household summary shares the same goal list.
  assert.deepEqual((await callTool('household', { operation: 'summary', }, { db: s.db, now: NOW })).goals, list);
});

test('goals.list serializes the demo kind goals for the model, the contribution entry complete', async t => {
  const s = await store(t, { demo: true });
  const list = await callTool('goals', { operation: 'list', }, { db: s.db, now: NOW });
  const by = id => list.find(g => g.id === id);
  for (const g of list) assert.ok(['open', 'done'].includes(g.status), `${g.id} status ${g.status} is canonical`);
  const reserve = by('reserve');
  assert.equal(reserve.status, 'open');
  assert.equal(reserve.statusLabel, 'on track', 'seed goals keep their display text as statusLabel');
  assert.equal(reserve.kind, 'balance');

  assert.deepEqual(by('checking-range').range, { low: { amount: 5000, source: 'plan' }, high: { amount: 8000, source: 'plan' } });
  assert.deepEqual(by('biz-floor').floor, { amount: 15000, source: 'plan' });
  assert.equal(by('biz-floor').ownerLabel, demo.names.me);
  assert.equal(by('biz-floor').priority, 'high');

  const ira = by('ira-fill');
  assert.ok(ira, 'the demo contribution goal is listed');
  const accounts = ira.contribution?.accounts;
  assert.equal(typeof accounts, 'string', 'destination accounts are named');
  assert.deepEqual(accounts.split(', ').map(a => /Roth IRA/.test(a)), [true, true], 'both Roth IRAs are named');
  // The deadline is contribution.deadline; a top-level targetDate is allowed but must agree.
  const { targetDate, ...entry } = ira;
  if (targetDate !== undefined) assert.equal(targetDate, '2027-04-15');
  assert.deepEqual({ ...entry, contribution: { ...entry.contribution, accounts: '<two account labels>' } }, {
    id: 'ira-fill',
    title: 'Fill both IRAs for 2026',
    horizon: 'This year',
    note: 'Each of us puts in the full amount before the April deadline.',
    status: 'open',
    statusLabel: 'open',
    kind: 'contribution',
    owner: 'joint',
    ownerLabel: 'Joint',
    priority: 'medium',
    target: { amount: 15000, source: 'plan' },
    contribution: {
      taxYear: 2026,
      deadline: '2027-04-15',
      accounts: '<two account labels>',
      split: [
        { person: 'owner', label: demo.names.me, amount: 7500, source: 'plan' },
        { person: 'spouse', label: demo.names.spouse, amount: 7500, source: 'plan' },
      ],
      entered: { asOf: '2026-10-31', people: [{ person: 'owner', amount: 7500 }, { person: 'spouse', amount: 4000 }], source: 'you' },
    },
  });
});

/* ---------- pace through goals.pace ---------- */

const pacePath = async db => callTool('goals', { operation: 'pace', }, { db, now: NOW });
const txIds = f => (f?.locator?.sources || []).filter(x => x.rows?.table === 'transactions').flatMap(x => x.rows.ids);
const acctIds = f => (f?.locator?.sources || []).filter(x => x.rows?.table === 'accounts').flatMap(x => x.rows.ids);

test('goals.pace carries kind, owner, priority and each kind\'s result', async t => {
  const s = await store(t);
  await seedAccounts(s.db);
  const q1 = await txn(s.db, 'r1', '2026-02-10', 1000);
  const q2 = await txn(s.db, 'r1', '2026-10-20', 1500, 'Transfer from checking');
  const q3 = await txn(s.db, 'r2', '2026-10-25', 2000);
  const interest = await txn(s.db, 'r1', '2026-06-30', 500, 'Interest payment');
  const prior = await txn(s.db, 'r1', '2025-12-20', 900);
  const future = await txn(s.db, 'r1', '2026-11-20', 700);
  const range = (await goalCreate(s.ctx({ ...RANGE }))).goal;
  const floor = (await goalCreate(s.ctx({ ...FLOOR }))).goal;
  const contrib = (await goalCreate(s.ctx({ ...CONTRIB, entered: null }))).goal;
  const plain = (await goalCreate(s.ctx({ title: 'Plain cushion', target: 30000, targetDate: '2027-12-31', track: { accounts: ['chk'] } }))).goal;
  const done = (await goalCreate(s.ctx({ ...FLOOR, title: 'Done floor' }))).goal;
  await goalUpdate(s.ctx({ status: 'done' }, { id: done.id }));

  const pace = await pacePath(s.db);
  const p = id => pace.goals.find(x => x.id === id);
  assert.equal(p(done.id), undefined, 'a done goal is not paced');
  assert.equal(pace.series.goals[done.id], undefined);
  for (const [id, kind, owner, priority] of [[range.id, 'range', 'joint', 'medium'], [floor.id, 'floor', 'owner', 'high'],
    [contrib.id, 'contribution', 'joint', 'low'], [plain.id, 'balance', null, null]]) {
    assert.deepEqual([p(id)?.kind, p(id)?.owner, p(id)?.priority], [kind, owner, priority], `${kind} entry tags`);
  }
  assert.equal(p(range.id).range.position, 'in', '6000 sits in 4000 to 8000');
  assert.equal(p(range.id).range.low.v, 4000);
  assert.equal(p(floor.id).floor.state, 'holding');
  assert.equal(p(floor.id).status, 'on pace', 'a current holding floor is on pace');
  assert.equal(p(floor.id).timeGap, 'Holding');

  const c = p(contrib.id);
  assert.equal(c.contribution.basis, 'transactions');
  assert.equal(c.actual.v, 4500, 'the three qualifying deposits; interest, prior-year and future rows are left out');
  assert.equal(c.dataThrough, '2026-10-20', 'data through the earliest of each account\'s latest transaction');
  assert.notEqual(c.status, 'unknown', 'current transactions give a known status');
  for (const q of [q1, q2, q3]) assert.ok(txIds(c.actual).includes(q), `qualifying transaction ${q} is listed`);
  for (const x of [interest, prior, future]) assert.ok(!txIds(c.actual).includes(x), `transaction ${x} is not listed`);
  assert.deepEqual(acctIds(c.actual).sort(), ['r1', 'r2']);
  assert.deepEqual(c.contribution.people.map(x => [x.person, x.actual?.v ?? null, x.target?.v ?? null]), [['owner', 2500, 7000], ['spouse', 2000, 7000]],
    'each Roth has one holder, so progress splits by holder');
  assert.equal(c.contribution.remaining.v, 9500);

  assert.deepEqual(pace.series.goals[floor.id], { series: null, reason: 'kind_not_charted', dataEnd: null });
  assert.deepEqual(pace.series.goals[contrib.id], { series: null, reason: 'kind_not_charted', dataEnd: null });
  assert.notEqual(pace.series.goals[range.id]?.reason, 'kind_not_charted', 'a range is charted on its low end');
  assert.notEqual(pace.series.goals[plain.id]?.reason, 'kind_not_charted');
  assert.deepEqual((await buildScenario(s.db, { clock: CLOCK })).pace.goals.map(x => x.id), pace.goals.map(x => x.id), 'the scenario and the tool share one builder');
});

test('contribution coverage: every destination account needs a transaction in the tax year, else the entered amount', async t => {
  const s = await store(t);
  await seedAccounts(s.db);
  await txn(s.db, 'r1', '2026-03-15', 1000);
  await txn(s.db, 'r1', '2026-10-20', 500);
  await txn(s.db, 'r4', '2026-09-01', 400);
  await txn(s.db, 'r3', '2025-11-01', 3000, 'Rollover deposit');
  const make = async (title, accounts, extra = {}) => (await goalCreate(s.ctx({ title, kind: 'contribution', target: 6000, taxYear: 2026,
    targetDate: '2027-04-15', accounts, ...extra }))).goal.id;
  const total = amount => ({ entered: { asOf: '2026-11-01', total: amount } });
  const unknownHolder = await make('Holder unknown', ['r1', 'r4'], { split: [{ person: 'owner', amount: 3000 }, { person: 'spouse', amount: 3000 }] });
  const partialEntered = await make('Partly covered with an entered amount', ['r1', 'r3'], total(1200));
  const partial = await make('Partly covered', ['r1', 'r3']);
  const priorEntered = await make('Prior year only with an entered amount', ['r3'], total(800));
  const prior = await make('Prior year only', ['r3']);
  const none = await make('No destination accounts');

  const pace = await pacePath(s.db);
  const p = id => pace.goals.find(x => x.id === id);

  const u = p(unknownHolder);
  assert.equal(u.contribution.basis, 'transactions', 'both accounts are covered');
  assert.equal(u.actual.v, 1900);
  assert.deepEqual(u.contribution.people.map(x => [x.person, x.target?.v ?? null, x.actual ?? null]), [['owner', 3000, null], ['spouse', 3000, null]],
    'an account with no holder gives shares but no per-person progress');

  assert.equal(p(partialEntered).contribution.basis, 'entered', 'partial coverage falls back to the entered amount');
  assert.equal(p(partialEntered).actual.v, 1200);
  assert.ok(p(partialEntered).actual.locator.sources.some(x => x.field === 'entered' && x.src === 'you'));
  assert.equal(p(partial).status, 'unknown');
  assert.equal(p(partial).reason, 'partial_contribution_coverage');
  assert.equal(p(partial).contribution.basis, null);
  assert.equal(p(partial).actual, null, 'never a partial sum');

  assert.equal(p(priorEntered).contribution.basis, 'entered', 'prior-year transactions do not cover the tax year');
  assert.equal(p(priorEntered).actual.v, 800);
  assert.equal(p(prior).status, 'unknown');
  assert.equal(p(prior).reason, 'missing_contributions');
  assert.equal(p(none).reason, 'missing_contributions', 'no destination accounts and nothing entered');
});
