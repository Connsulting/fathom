// R2 (plan feat-confirm-context, Interfaces): a group card submits several answers at once.
// answerItems answers every row in one transaction with one undo log per item, and any refusal
// changes nothing; explicit selections win over what propagation would have chosen; reopenItems
// undoes a group as one, refused whole when any item is final. Over HTTP the batch routes run
// autoResolve after the confirm transaction. Every value here is synthetic.

import test, { describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { src, serveAppFixture } from '../helpers/server.mjs';
import { fixture, realStore, offEngine, one, count } from '../helpers/ingest.mjs';
import { mapSeries } from '../../src/shared/series.mjs';

let P;
let C;
let A;
let DB;
before(async () => {
  P = await src('src/ingest/pipeline.mjs');
  C = await src('src/ingest/confirm.mjs');
  A = await src('src/ingest/auto.mjs');
  DB = await src('src/store/db.mjs');
});

const LATER = '2032-03-11T09:00:00.000Z';
const householdFiles = () => ['aggregator-household.csv', 'Chase4455_Activity_20261031.csv', 'positions-household.csv']
  .map((name) => ({ ...fixture(`household/${name}`, 'text/csv'), name }));

// The household fixture without the names fact: every owner question is pending after import.
async function withHousehold(fn) {
  const s = await realStore();
  try {
    await P.ingestFiles(s.db, householdFiles(), s.opts(await offEngine()));
    return await fn(s);
  } finally { s.close(); }
}

const ROLES = {
  brokerage1111: ['1111', 'Example Brokerage'],
  brokerage2222: ['2222', 'Example Brokerage'],
  positions1111: ['1111', ''],
  checking: ['4455', 'Chase'],
  card: ['3344', 'Example Card'],
  rainyDay: ['5566', 'Example Credit Union'],
};
const accountId = async (db, role) => (await one(db, "SELECT id FROM accounts WHERE mask = ? AND coalesce(inst, '') = ?", ...ROLES[role])).id;
async function ownerItem(db, role) {
  const id = await accountId(db, role);
  const item = C.listItems(db, { status: 'all' }).find((i) => i.kind === 'account_owner' && i.subject === id);
  assert.ok(item, `an owner question for ${role}`);
  return C.getItem(db, item.id);
}
const ownerOf = async (db, role) => (await one(db, 'SELECT owner FROM accounts WHERE id = ?', await accountId(db, role))).owner;

// Every table but the migration record, rows as sorted JSON, for "a refusal changes nothing".
async function dump(db) {
  const out = {};
  for (const t of DB.listTables(db)) {
    if (t === 'schema_migrations') continue;
    out[t] = (await db.prepare(`SELECT * FROM "${t}"`).all()).map((r) => JSON.stringify({ ...r })).sort();
  }
  return out;
}
async function refused(db, fn, code, reason) {
  const before = await dump(db);
  assert.throws(fn, (err) => {
    assert.ok(err instanceof C.ConfirmError, `ConfirmError, got ${err && err.name}: ${err && err.message}`);
    assert.equal(err.code, code);
    if (reason !== undefined) assert.equal(err.reason, reason);
    return true;
  });
  assert.deepEqual(await dump(db), before, `a ${code} refusal changes nothing`);
}

describe('answerItems', () => {
  test('answers several items, each with its own undo log', async () => withHousehold(async (s) => {
    const rows = [['checking', 'owner', 'You'], ['card', 'spouse', 'Your spouse'], ['rainyDay', 'joint', 'Joint']];
    const answers = await mapSeries(rows, async ([role, option]) => ({ id: (await ownerItem(s.db, role)).id, option }));
    const out = C.answerItems(s.db, answers, { now: LATER });
    assert.equal(typeof out.factsChanged, 'boolean');
    assert.deepEqual(out.items.map((i) => [i.id, i.status, i.answer]), answers.map((a) => [a.id, 'answered', a.option]));
    for (const [role, , label] of rows) assert.equal(await ownerOf(s.db, role), label, `${role} owner is ${label}`);
    for (const a of answers) assert.equal(await count(s.db, 'confirm_undo', 'item_id = ?', a.id), 1, 'one undo log per item');

    // Each log stands alone: one answer of the batch reopens without the others.
    C.reopenItem(s.db, answers[1].id, { now: LATER });
    assert.equal(await ownerOf(s.db, 'card'), null);
    assert.equal(await ownerOf(s.db, 'checking'), 'You');
    assert.equal(await ownerOf(s.db, 'rainyDay'), 'Joint');
  }));

  test('a bad option or an already answered item refuses the whole batch and changes nothing', async () => withHousehold(async (s) => {
    const checking = (await ownerItem(s.db, 'checking')).id;
    const card = (await ownerItem(s.db, 'card')).id;
    await refused(s.db, () => C.answerItems(s.db, [{ id: checking, option: 'owner' }, { id: card, option: 'nobody' }], { now: LATER }), 'bad_option');
    const rainy = (await ownerItem(s.db, 'rainyDay')).id;
    C.answerItem(s.db, rainy, 'joint', { now: LATER });
    await refused(s.db, () => C.answerItems(s.db, [{ id: checking, option: 'owner' }, { id: rainy, option: 'owner' }], { now: LATER }), 'answered');
    await refused(s.db, () => C.answerItems(s.db, [{ id: checking, option: 'owner' }, { id: 999999, option: 'owner' }], { now: LATER }), 'not_found');
    assert.equal(await ownerOf(s.db, 'checking'), null);
  }));

  test('an explicit option in the batch wins over what propagation from another row would choose', async () => withHousehold(async (s) => {
    // The brokerage shares the checking's holder, so answering the checking alone would propagate
    // "owner" to it. Here the owner picked "spouse" for it in the same batch.
    const checking = (await ownerItem(s.db, 'checking')).id;
    const brokerage = (await ownerItem(s.db, 'brokerage1111')).id;
    C.answerItems(s.db, [{ id: checking, option: 'owner' }, { id: brokerage, option: 'spouse' }], { now: LATER });
    A.autoResolve(s.db, { now: LATER });
    const b = C.getItem(s.db, brokerage);
    assert.equal(b.answer, 'spouse', 'the explicit option stands');
    assert.equal(C.autoInfo(s.db, brokerage), null, 'it is the owner\'s answer, not Fathom\'s');
    assert.equal(await ownerOf(s.db, 'brokerage1111'), 'Your spouse');
    const positions = await ownerItem(s.db, 'positions1111');
    assert.equal(positions.answer, 'spouse', 'propagation follows the explicit answer');
    assert.equal(C.autoInfo(s.db, positions.id).rule, 'shared_mask');
  }));
});

describe('reopenItems', () => {
  const batch = async (db) => await mapSeries(['checking', 'card', 'rainyDay'], async (role, n) => ({ id: (await ownerItem(db, role)).id, option: ['owner', 'spouse', 'joint'][n] }));

  test('reopens every item of a group', async () => withHousehold(async (s) => {
    const answers = await batch(s.db);
    C.answerItems(s.db, answers, { now: LATER });
    const out = C.reopenItems(s.db, answers.map((a) => a.id), { now: LATER });
    assert.equal(typeof out.factsChanged, 'boolean');
    assert.deepEqual(out.items.map((i) => [i.id, i.status, i.answer]), answers.map((a) => [a.id, 'pending', null]));
    for (const role of ['checking', 'card', 'rainyDay']) assert.equal(await ownerOf(s.db, role), null);
  }));

  test('one final item refuses the whole undo with its reason', async () => withHousehold(async (s) => {
    const answers = await batch(s.db);
    C.answerItems(s.db, answers, { now: LATER });
    await s.db.prepare("UPDATE accounts SET owner = 'Business' WHERE id = ?").run(await accountId(s.db, 'card'));
    await refused(s.db, () => C.reopenItems(s.db, answers.map((a) => a.id), { now: LATER }), 'final', 'changed_since');
    assert.equal(await ownerOf(s.db, 'checking'), 'You');
    assert.equal(await ownerOf(s.db, 'rainyDay'), 'Joint');
    for (const a of answers) assert.equal(C.getItem(s.db, a.id).status, 'answered');
  }));
});

describe('batch routes over HTTP', () => {
  async function withRouter(s, fn) {
    const app = await serveAppFixture({ db: s.db, config: s.config, engine: await offEngine(), authenticated: true });
    try { return await fn(app); } finally { await app.close(); }
  }

  test('POST /api/confirm/answers answers the batch and propagates; malformed bodies are 400', async () => withHousehold(async (s) => withRouter(s, async (client) => {
    for (const body of [{}, { answers: 'owner' }, { answers: [{ id: (await ownerItem(s.db, 'card')).id }] }]) {
      const bad = await client.postJson('/api/confirm/answers', body);
      assert.equal(bad.status, 400, `${JSON.stringify(body)}: ${bad.text.slice(0, 200)}`);
      assert.equal(typeof bad.json.error, 'string');
    }
    assert.equal(await ownerOf(s.db, 'card'), null, 'a 400 changes nothing');

    const checking = (await ownerItem(s.db, 'checking')).id;
    const card = (await ownerItem(s.db, 'card')).id;
    const ok = await client.postJson('/api/confirm/answers', { answers: [{ id: checking, answer: 'owner' }, { id: card, answer: 'spouse' }] });
    assert.equal(ok.status, 200, ok.text.slice(0, 300));
    assert.ok(ok.json.scenario && typeof ok.json.scenario === 'object', 'the body carries the scenario');
    assert.deepEqual(ok.json.items.map((i) => [i.id, i.status, i.answer, i.final]), [[checking, 'answered', 'owner', null], [card, 'answered', 'spouse', null]]);
    assert.equal(await ownerOf(s.db, 'checking'), 'You');
    assert.equal(await ownerOf(s.db, 'card'), 'Your spouse');

    const brokerage = await ownerItem(s.db, 'brokerage1111');
    assert.equal(brokerage.answer, 'owner', 'the route ran autoResolve: the same-holder brokerage is answered');
    assert.equal(C.autoInfo(s.db, brokerage.id).rule, 'holder_match');

    const refusedBatch = await client.postJson('/api/confirm/answers', { answers: [{ id: (await ownerItem(s.db, 'rainyDay')).id, answer: 'joint' }, { id: card, answer: 'owner' }] });
    assert.equal(refusedBatch.status, 409, 'an already answered row refuses the batch like the single answer route');
    assert.equal((await ownerItem(s.db, 'rainyDay')).status, 'pending');
  })));

  test('POST /api/confirm/reopen-many reopens the group', async () => withHousehold(async (s) => withRouter(s, async (client) => {
    const card = (await ownerItem(s.db, 'card')).id;
    const rainy = (await ownerItem(s.db, 'rainyDay')).id;
    const ok = await client.postJson('/api/confirm/answers', { answers: [{ id: card, answer: 'spouse' }, { id: rainy, answer: 'joint' }] });
    assert.equal(ok.status, 200, ok.text.slice(0, 300));
    const r = await client.postJson('/api/confirm/reopen-many', { ids: [card, rainy] });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(r.json.scenario && typeof r.json.scenario === 'object');
    assert.deepEqual(r.json.items.map((i) => [i.id, i.status, i.answer]), [[card, 'pending', null], [rainy, 'pending', null]]);
    assert.equal(await ownerOf(s.db, 'card'), null);
    assert.equal(await ownerOf(s.db, 'rainyDay'), null);
  })));
});
