import test from 'node:test';
import assert from 'node:assert/strict';
import { realStore, NOW } from '../helpers/ingest.mjs';
import { compatibleKind } from '../../src/ingest/account-match.mjs';
import * as M from '../../src/ingest/account-merge.mjs';

const withStore = async fn => { const s = await realStore(); try { await fn(s); } finally { s.close(); } };

async function connect(db, { id, sfKey, name, kind }) {
  await db.prepare('INSERT INTO accounts (id, identity, name, kind, mirror) VALUES (?,?,?,?,?)')
    .run(id, `simplefin:${sfKey}`, name, kind, 'connected');
  await db.prepare("INSERT INTO simplefin_accounts (sf_key, account_id, status, name, created_at, backfilled) VALUES (?,?,'mapped',?,?,1)")
    .run(sfKey, id, name, NOW);
}

async function fileAccount(db, { id, name, kind }) {
  await db.prepare("INSERT INTO accounts (id, identity, name, kind, mirror) VALUES (?,?,?,?,?)")
    .run(id, `file:${id}`, name, kind, 'manual');
}

async function balances(db, id, rows) {
  const put = db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?,?,?)');
  for (const [date, amount] of rows) await put.run(id, date, amount);
}

// Month-end file balances, with August landing after the connected account's last balance that month.
const FILE_DATES = [['2032-06-30', 1000], ['2032-07-31', 1100.5], ['2032-08-31', 900.25]];

test('checking pairs with cash, and month-end history pairs both accounts as sure', async () => withStore(async s => {
  assert.equal(compatibleKind({ kind: 'checking', name: 'checking' }, { kind: 'cash', name: 'operating' }), true);
  await connect(s.db, { id: 'sf-cash', sfKey: 'sf-cash', name: 'operating', kind: 'cash' });
  await connect(s.db, { id: 'sf-biz', sfKey: 'sf-biz', name: 'operating business', kind: 'business' });
  await fileAccount(s.db, { id: 'file-check', name: 'checking', kind: 'checking' });
  await fileAccount(s.db, { id: 'file-biz', name: 'business', kind: 'business' });
  await balances(s.db, 'file-check', FILE_DATES);
  await balances(s.db, 'file-biz', FILE_DATES);
  await balances(s.db, 'sf-cash', [['2032-06-30', 1000], ['2032-07-31', 1100.5], ['2032-08-28', 900.25], ['2032-09-15', 50]]);
  await balances(s.db, 'sf-biz', [['2032-06-30', 1000], ['2032-07-31', 1100.5], ['2032-08-27', 900.25], ['2032-09-15', 80]]);
  const pairs = await M.detectAccountPairs(s.db);
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs.map(p => p.confidence), ['sure', 'sure']);
  assert.deepEqual(pairs.map(p => [p.candidateId, p.ownId]), [['file-biz', 'sf-biz'], ['file-check', 'sf-cash']]);
  await M.queueAccountPairs(s.db, { now: NOW });
  const questions = (await s.db.prepare("SELECT question FROM confirm_items WHERE kind='account_match' ORDER BY question").all()).map(r => r.question);
  assert.ok(questions.some(q => q.includes('operating') && q.includes('checking') && q.includes('Balances matched on Jun 30, Jul 31 and Aug 31')));
  assert.ok(questions.some(q => q.includes('business') && q.includes('Balances matched on Jun 30, Jul 31 and Aug 31')));
}));

test('one unequal balance blocks the pair, two matches stay likely, and two files cannot both be sure', async () => withStore(async s => {
  await connect(s.db, { id: 'sf-cash', sfKey: 'sf-cash', name: 'operating', kind: 'cash' });
  await balances(s.db, 'sf-cash', [['2032-06-30', 1000], ['2032-07-31', 1100.5], ['2032-08-28', 900.25]]);
  await fileAccount(s.db, { id: 'miss', name: 'checking', kind: 'checking' });
  await balances(s.db, 'miss', [['2032-06-30', 1000], ['2032-07-31', 1100.5], ['2032-08-31', 900.26]]);
  assert.equal((await M.detectAccountPairs(s.db)).length, 0);

  await s.db.prepare('DELETE FROM balances WHERE account_id=?').run('miss');
  await s.db.prepare('DELETE FROM accounts WHERE id=?').run('miss');
  await fileAccount(s.db, { id: 'two', name: 'checking', kind: 'checking' });
  await balances(s.db, 'two', [['2032-06-30', 1000], ['2032-07-31', 1100.5]]);
  const likely = await M.detectAccountPairs(s.db);
  assert.equal(likely.length, 1);
  assert.equal(likely[0].confidence, 'likely');

  await fileAccount(s.db, { id: 'also', name: 'savings', kind: 'cash' });
  await balances(s.db, 'also', FILE_DATES);
  await balances(s.db, 'two', [['2032-08-31', 900.25]]);
  const shared = await M.detectAccountPairs(s.db);
  assert.equal(shared.length, 2);
  assert.deepEqual(shared.map(p => p.confidence), ['likely', 'likely']);
}));

// An earlier merge leaves the file row as the survivor: file identity, mapped feed, daily balances.
async function survivor(db) {
  await db.prepare('INSERT INTO accounts (id, identity, name, kind, mirror) VALUES (?,?,?,?,?)')
    .run('survivor', 'file:survivor', 'operating', 'cash', 'connected');
  await db.prepare("INSERT INTO simplefin_accounts (sf_key, account_id, status, name, created_at, backfilled) VALUES (?,?,'mapped',?,?,1)")
    .run('sf-survivor', 'survivor', 'operating', NOW);
  await balances(db, 'survivor', [
    ['2032-06-15', 800], ['2032-06-30', 1000],
    ['2032-07-15', 1050], ['2032-07-31', 1100.5],
    ['2032-08-15', 950], ['2032-08-31', 900.25],
    ['2032-09-15', 40],
  ]);
}

test('a merged survivor pairs with a balance-only file account', async () => withStore(async s => {
  await survivor(s.db);
  await fileAccount(s.db, { id: 'file-only', name: 'checking', kind: 'checking' });
  await balances(s.db, 'file-only', FILE_DATES);
  const pairs = await M.detectAccountPairs(s.db);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].confidence, 'sure');
  assert.deepEqual([pairs[0].candidateId, pairs[0].ownId], ['file-only', 'survivor']);
  assert.equal(pairs[0].candidateId === pairs[0].ownId, false);
}));

test('two connected accounts never pair', async () => withStore(async s => {
  await survivor(s.db);
  await connect(s.db, { id: 'sf-other', sfKey: 'sf-other', name: 'checking', kind: 'checking' });
  await balances(s.db, 'sf-other', FILE_DATES);
  assert.deepEqual(await M.detectAccountPairs(s.db), []);
}));
