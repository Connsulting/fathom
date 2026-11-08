// SRC1 AC2: history versus stale, one rule everywhere. A file source whose accounts a live
// SimpleFIN connection now covers (or that another source has newer rows for, or that are
// archived) is 'history', never 'stale', whatever its file date. Stale means an account with no
// newer source and old data; an archived account is never stale. The same answer comes out of
// every caller: ingestState (sources, accounts, staleNotes), accountFreshness (the account
// dialog), the planner freshness the missing-data rec reads, and scenario.accounts[].fresh (the
// Home Cash card count, healthLine). All of them use one helper exported from
// src/ingest/coverage.mjs:
//   sourceStates(db, clock) -> { sources, accounts }, each keyed by id (a Map or a plain object),
//   each value a state string or an object with a `state` field. Account states: 'archived' |
//   'fresh' | 'stale' | 'unknown'; file source states: 'history' | 'fresh' | 'stale' | 'unknown'.
// Every file, account and institution here is synthetic.

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { src } from '../helpers/server.mjs';
import { realStore, fixture, offEngine, one, NOW } from '../helpers/ingest.mjs';

let FR;
let P;
let B;
let C;
let D;
let T;
let H;
before(async () => {
  FR = await src('src/ingest/freshness.mjs');
  P = await src('src/ingest/pipeline.mjs');
  B = await src('src/scenario/build.mjs');
  C = await src('src/ingest/coverage.mjs');
  D = await src('src/jobs/planner/data.mjs');
  T = await src('src/tools/index.mjs');
  H = await src('web/horizon/screens/home-model.js');
});

const FRESH_CLOCK = '2032-03-10';
const OLD_CLOCK = '2032-09-01'; // months past the monthly cadence of every fixture

async function withStore(fn) {
  const s = await realStore();
  try { return await fn(s); } finally { await s.close(); }
}

async function ingest(s, name) {
  const r = await P.ingestFile(s.db, fixture(name, 'text/csv'), s.opts(await offEngine()));
  assert.equal(r.status, 'imported', `${name} imported`);
  return await one(s.db, 'SELECT * FROM files WHERE name = ?', name);
}
const accountOfFile = async (s, file) => await one(s.db, `SELECT a.* FROM accounts a WHERE a.id IN (
  SELECT account_id FROM transactions WHERE file_id = ? UNION SELECT account_id FROM balances WHERE file_id = ?
  UNION SELECT account_id FROM positions WHERE file_id = ?)`, file.id, file.id, file.id);

// A live SimpleFIN connection with `accountId` mapped to it, written the way the sync records a
// mapping and newest balance from a successful sync.
async function connect(db, accountId) {
  await db.prepare("INSERT OR IGNORE INTO simplefin_connection (id, access_blob, connected_at) VALUES (1, 'synthetic', ?)").run(NOW);
  await db.prepare("INSERT INTO simplefin_accounts (sf_key, account_id, status, name, created_at) VALUES (?, ?, 'mapped', 'Synthetic', ?)").run(`sf-${accountId}`, accountId, NOW);
  await db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?, ?, 100)').run(accountId, '2032-08-31');
}
const disconnect = async (db) => await db.prepare('DELETE FROM simplefin_connection').run();

const pick = (m, k) => {
  const v = m instanceof Map ? m.get(k) : m?.[k];
  return typeof v === 'string' ? v : v?.state;
};
function shared(db, clock) {
  assert.equal(typeof C.sourceStates, 'function', 'src/ingest/coverage.mjs exports the shared helper sourceStates(db, clock)');
  const out = C.sourceStates(db, clock);
  assert.ok(out && out.sources && out.accounts, 'sourceStates returns { sources, accounts }');
  return { source: (id) => pick(out.sources, id), account: (id) => pick(out.accounts, id) };
}

// Every caller at `clock`, read through its public entry.
function callers(db, clock) {
  const state = FR.ingestState(db, { clock });
  const scenario = B.buildScenario(db, { clock });
  const planner = D.loadPlanningData(db, clock).freshness;
  return {
    state,
    scenario,
    source: (id) => state.sources.find((x) => x.id === id),
    ingestAccount: (id) => state.accounts[id]?.fresh,
    dialog: (id) => FR.accountFreshness(db, id, { clock }).fresh,
    scenarioAccount: (id) => scenario.accounts.find((a) => a.id === id),
    planner: (id) => planner.find((f) => f.id === id).state,
    cashCard: () => H.healthLine({ pace: scenario.pace, ingest: scenario.live.ingest, accounts: scenario.accounts }).staleAccounts,
  };
}

// The one rule: every caller reports the shared helper's answer for every account and source.
async function assertAgree(db, clock) {
  const rule = shared(db, clock);
  const c = callers(db, clock);
  for (const { id } of await db.prepare('SELECT id FROM accounts').all()) {
    const want = rule.account(id);
    if (want === undefined) continue;
    if (want === 'archived') {
      assert.notEqual(c.ingestAccount(id), 'stale', `${id}: archived is not stale in ingestState`);
      assert.notEqual(c.dialog(id), 'stale', `${id}: archived is not stale in the account dialog`);
      assert.equal(c.scenarioAccount(id), undefined, `${id}: archived is not in scenario.accounts`);
      continue;
    }
    assert.equal(c.ingestAccount(id), want, `${id}: ingestState.accounts agrees with the helper`);
    assert.equal(c.dialog(id), want, `${id}: accountFreshness agrees with the helper`);
    assert.equal(c.scenarioAccount(id)?.fresh, want, `${id}: scenario.accounts agrees with the helper`);
  }
  for (const source of c.state.sources) {
    const want = rule.source(source.id);
    if (want !== undefined) assert.equal(source.state, want, `${source.id}: ingestState.sources agrees with the helper`);
  }
  const staleAccounts = (await db.prepare('SELECT id FROM accounts').all()).filter(({ id }) => rule.account(id) === 'stale').length;
  assert.equal(c.cashCard(), staleAccounts, 'the Cash card counts exactly the helper\'s stale accounts');
  return c;
}

test('a file source whose accounts a live SimpleFIN connection covers is history, not stale, though its file date is old', async () => withStore(async (s) => {
  const file = await ingest(s, 'aggregator.csv');
  const acct = await accountOfFile(s, file);

  let c = await assertAgree(s.db, OLD_CLOCK);
  assert.equal(c.source(file.source_id).state, 'stale', 'before the connection the old export is stale');
  assert.equal(c.ingestAccount(acct.id), 'stale');
  assert.ok(c.state.staleNotes.length > 0, 'a stale note before the connection');
  assert.equal(c.cashCard(), 1);
  assert.equal(c.planner('transactions'), 'stale');

  await connect(s.db, acct.id);
  c = await assertAgree(s.db, OLD_CLOCK);
  assert.equal(shared(s.db, OLD_CLOCK).source(file.source_id), 'history');
  assert.equal(c.source(file.source_id).state, 'history');
  assert.notEqual(c.ingestAccount(acct.id), 'stale');
  assert.notEqual(c.dialog(acct.id), 'stale');
  assert.notEqual(c.scenarioAccount(acct.id).fresh, 'stale');
  assert.deepEqual(c.state.staleNotes, [], 'no stale note for a covered export');
  assert.equal(c.cashCard(), 0, 'the Cash card counts no stale account');
  assert.notEqual(c.planner('transactions'), 'stale', 'the missing-data rec does not ask for a fresh export');
  assert.ok(!c.state.sources.some((x) => x.state === 'covered'), 'covered is gone; history replaces it');

  // Disconnecting keeps the balance already received; the older export is history.
  await disconnect(s.db);
  c = await assertAgree(s.db, OLD_CLOCK);
  assert.equal(c.source(file.source_id).state, 'history');
  assert.equal(c.ingestAccount(acct.id), 'fresh');
}));

test('an account with no newer source and old data is stale in every caller; a covered one beside it is not', async () => withStore(async (s) => {
  const agg = await ingest(s, 'aggregator.csv');
  const pos = await ingest(s, 'positions.csv');
  const cash = await accountOfFile(s, agg);
  const invest = await accountOfFile(s, pos);
  await connect(s.db, cash.id);

  const c = await assertAgree(s.db, OLD_CLOCK);
  assert.equal(shared(s.db, OLD_CLOCK).account(invest.id), 'stale');
  assert.equal(c.ingestAccount(invest.id), 'stale');
  assert.equal(c.dialog(invest.id), 'stale');
  assert.equal(c.scenarioAccount(invest.id).fresh, 'stale');
  assert.equal(c.source(pos.source_id).state, 'stale');
  assert.ok(c.state.staleNotes.some((n) => n.domain === 'invest'), 'the invest note asks for a fresh positions export');
  assert.ok(!c.state.staleNotes.some((n) => n.domain === 'cash'), 'no cash note: the cash account is covered');
  assert.equal(c.cashCard(), 1, 'the Cash card counts the one stale account');
  assert.equal(c.planner('balances'), 'stale', 'the missing-data rec sees the stale account');
  assert.equal(c.source(agg.source_id).state, 'history');
}));

test('an archived account is never stale, and its only source becomes history', async () => withStore(async (s) => {
  const agg = await ingest(s, 'aggregator.csv');
  const pos = await ingest(s, 'positions.csv');
  const cash = await accountOfFile(s, agg);
  const invest = await accountOfFile(s, pos);
  await connect(s.db, cash.id);
  assert.equal(callers(s.db, OLD_CLOCK).ingestAccount(invest.id), 'stale', 'precondition: the positions account is stale');

  const out = await T.callTool('sources', { operation: 'archive_account', id: invest.id }, { db: s.db, now: new Date(NOW), actorId: 'person-a' });
  assert.ok(out.receipt, 'archiving returns a receipt');

  const c = await assertAgree(s.db, OLD_CLOCK);
  assert.equal(shared(s.db, OLD_CLOCK).account(invest.id), 'archived');
  assert.notEqual(c.ingestAccount(invest.id), 'stale');
  assert.notEqual(c.dialog(invest.id), 'stale');
  assert.equal(c.scenarioAccount(invest.id), undefined, 'the archived account leaves the current accounts');
  assert.equal(c.source(pos.source_id).state, 'history');
  assert.deepEqual(c.state.staleNotes, [], 'no stale note for an archived account or a covered one');
  assert.equal(c.cashCard(), 0);
  assert.notEqual(c.planner('balances'), 'stale');
  assert.notEqual(c.planner('transactions'), 'stale');
}));

test('a file source whose account has newer rows from another file is history; the newer file decides freshness', async () => withStore(async (s) => {
  const agg = await ingest(s, 'aggregator.csv');
  const bank = await ingest(s, 'Chase7766_Activity_20320305.csv');
  const acct = await accountOfFile(s, bank);
  assert.equal((await accountOfFile(s, agg)).id, acct.id, 'precondition: both files feed one account');
  assert.notEqual(agg.source_id, bank.source_id, 'precondition: two sources');

  let c = await assertAgree(s.db, FRESH_CLOCK);
  assert.equal(c.source(agg.source_id).state, 'history');
  assert.equal(c.source(bank.source_id).state, 'fresh');
  assert.equal(c.ingestAccount(acct.id), 'fresh');

  c = await assertAgree(s.db, OLD_CLOCK);
  assert.equal(c.source(agg.source_id).state, 'history', 'the older export never turns stale');
  assert.equal(c.source(bank.source_id).state, 'stale', 'the newest export is what went stale');
  assert.equal(c.ingestAccount(acct.id), 'stale');
  assert.equal(c.cashCard(), 1);
  const notes = c.state.staleNotes.map((n) => n.text).join(' ');
  assert.ok(!notes.includes(c.source(agg.source_id).label), 'no note names the history source');
}));
