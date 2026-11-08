// UI3 AC3: the account dialog reads file sources through the shared history rule. An account a
// live SimpleFIN connection keeps fresh lists its older export and activity file as history, with
// nothing to refresh, and no caller (sources, staleNotes, planner freshness, the missing-data
// steps) asks for a fresh export. An account with no newer source and old data stays stale with
// its How to refresh. Every file, account and institution here is synthetic.

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { src } from '../helpers/server.mjs';
import { realStore, fixture, offEngine, one, NOW } from '../helpers/ingest.mjs';

let FR;
let P;
let C;
let D;
let M;
let A;
before(async () => {
  FR = await src('src/ingest/freshness.mjs');
  P = await src('src/ingest/pipeline.mjs');
  C = await src('src/ingest/coverage.mjs');
  D = await src('src/jobs/planner/data.mjs');
  M = await src('src/jobs/triggers/missing-data.mjs');
  A = await src('src/api/account-detail.mjs');
});

const OLD_CLOCK = '2032-09-01'; // months past the monthly cadence of every fixture

async function withStore(fn) {
  const s = await realStore();
  try { return await fn(s); } finally { s.close(); }
}

async function ingest(s, name) {
  const r = await P.ingestFile(s.db, fixture(name, 'text/csv'), s.opts(await offEngine()));
  assert.equal(r.status, 'imported', `${name} imported`);
  return one(s.db, 'SELECT * FROM files WHERE name = ?', name);
}
const accountOfFile = (s, file) => one(s.db, `SELECT a.* FROM accounts a WHERE a.id IN (
  SELECT account_id FROM transactions WHERE file_id = ? UNION SELECT account_id FROM balances WHERE file_id = ?
  UNION SELECT account_id FROM positions WHERE file_id = ?)`, file.id, file.id, file.id);

// A live SimpleFIN connection with `accountId` mapped to it and a fresh balance from the sync.
function connect(db, accountId) {
  db.prepare("INSERT OR IGNORE INTO simplefin_connection (id, access_blob, connected_at) VALUES (1, 'synthetic', ?)").run(NOW);
  db.prepare("INSERT INTO simplefin_accounts (sf_key, account_id, status, name, created_at) VALUES (?, ?, 'mapped', 'Synthetic', ?)").run(`sf-${accountId}`, accountId, NOW);
  db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?, ?, 100)').run(accountId, '2032-08-31');
}

const detail = (s, id) => A.accountDetail({ db: s.db, config: { ...s.config, clock: OLD_CLOCK }, params: { id }, query: {} });
const feedOf = (d, sourceId) => d.feeds.find((f) => f.id === sourceId);

// The planner's freshness and the missing-data steps built from it, at OLD_CLOCK.
function missingData(db) {
  const data = D.loadPlanningData(db, OLD_CLOCK);
  const list = M.items({ facts: {}, data, freshness: data.freshness, warnings: [], info: {}, blockedReasons: [] });
  return { freshness: data.freshness, uploads: list.filter((i) => i.kind === 'upload' && ['balances', 'transactions'].includes(i.code)) };
}

test('a connected fresh account lists its older file sources as history, and nothing asks for a fresh export', () => withStore(async (s) => {
  const agg = await ingest(s, 'aggregator.csv');
  const bank = await ingest(s, 'Chase7766_Activity_20320305.csv');
  const acct = accountOfFile(s, bank);
  assert.equal(accountOfFile(s, agg).id, acct.id, 'precondition: both files feed one account');
  assert.notEqual(agg.source_id, bank.source_id, 'precondition: two sources');
  assert.equal(feedOf(detail(s, acct.id), bank.source_id).state, 'stale', 'precondition: before the connection the newest file is stale');

  connect(s.db, acct.id);

  const states = C.sourceStates(s.db, OLD_CLOCK);
  assert.equal(states.sources.get(agg.source_id).state, 'history');
  assert.equal(states.sources.get(bank.source_id).state, 'history');

  const covered = C.fileSourceHistory(s.db);
  assert.equal(covered(acct.id, agg.source_id), true);
  assert.equal(covered(acct.id, bank.source_id), true);
  assert.equal(covered(acct.id, 'ing:not-a-source'), false, 'a source that did not feed the account is not history for it');

  const d = detail(s, acct.id);
  for (const source of [agg.source_id, bank.source_id]) {
    const feed = feedOf(d, source);
    assert.ok(feed, `${source} is a feed of the account`);
    assert.equal(feed.kind, 'file');
    assert.equal(feed.state, 'history', `${source} is history in the dialog`);
    assert.equal(feed.howTo, null, `${source} has no How to refresh`);
  }
  assert.notEqual(d.fresh, 'stale', 'the account itself is not stale');
  assert.equal(d.fresh, FR.accountFreshness(s.db, acct.id, { clock: OLD_CLOCK }).fresh, 'the account keeps its newest-row freshness');

  assert.deepEqual(FR.ingestState(s.db, { clock: OLD_CLOCK }).staleNotes, [], 'no stale note');
  const { freshness, uploads } = missingData(s.db);
  for (const id of ['balances', 'transactions']) assert.notEqual(freshness.find((f) => f.id === id).state, 'stale', `planner ${id} is not stale`);
  assert.deepEqual(uploads, [], 'no upload step for balances or transactions');
}));

test('an unconnected account with an old file stays stale with How to refresh, beside a connected one', () => withStore(async (s) => {
  const agg = await ingest(s, 'aggregator.csv');
  const pos = await ingest(s, 'positions.csv');
  const cash = accountOfFile(s, agg);
  const invest = accountOfFile(s, pos);
  assert.notEqual(cash.id, invest.id, 'precondition: two accounts');
  connect(s.db, cash.id);

  const states = C.sourceStates(s.db, OLD_CLOCK);
  assert.equal(states.sources.get(pos.source_id).state, 'stale');
  assert.equal(states.sources.get(agg.source_id).state, 'history');
  assert.equal(C.fileSourceHistory(s.db)(invest.id, pos.source_id), false);

  const feed = feedOf(detail(s, invest.id), pos.source_id);
  assert.ok(feed, 'the positions file is a feed of the investment account');
  assert.equal(feed.state, 'stale');
  assert.ok(feed.howTo && Array.isArray(feed.howTo.steps) && feed.howTo.steps.length > 0, 'a stale feed says how to refresh');
  assert.equal(feedOf(detail(s, cash.id), agg.source_id).state, 'history', 'the connected account beside it shows history');

  const { uploads } = missingData(s.db);
  const balances = uploads.find((i) => i.code === 'balances');
  assert.ok(balances, 'the missing-data steps ask for the latest balances');
  assert.ok(balances.accountIds.includes(invest.id), 'the step names the stale account');
  assert.ok(!balances.accountIds.includes(cash.id), 'the step does not name the connected account');
}));
