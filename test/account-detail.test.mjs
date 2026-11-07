import test from 'node:test';
import assert from 'node:assert/strict';
import { src } from './helpers/server.mjs';
import { realStore, aggregatorFile } from './helpers/ingest.mjs';

const row = (over) => ({ date: '2032-02-01', amount: '10.00', type: 'Checking', account: 'Chase 2738 2738', number: '9992738', inst: 'Chase', description: 'Synthetic', ...over });

async function twoAccounts(s) {
  const P = await src('src/ingest/pipeline.mjs');
  const a = [];
  for (let i = 1; i <= 7; i++) a.push(row({ date: `2032-02-0${i}`, amount: `${i}.00`, description: i === 3 ? 'Coffee 100% beans' : `Item ${i}` }));
  const r1 = await P.ingestFile(s.db, aggregatorFile('first.csv', a), s.opts(null));
  assert.equal(r1.status, 'imported');
  const r2 = await P.ingestFile(s.db, aggregatorFile('second.csv', [row({ account: 'Other 1111 1111', number: '9991111', inst: 'Harbor', description: 'Other account row', date: '2032-02-09' })]), s.opts(null));
  assert.equal(r2.status, 'imported');
  const ids = s.db.prepare('SELECT id, inst FROM accounts ORDER BY inst').all();
  return { chase: ids.find((x) => x.inst === 'Chase').id, harbor: ids.find((x) => x.inst === 'Harbor').id };
}

const ctx = (s, id, query = {}) => ({ db: s.db, config: s.config, params: { id }, query });

async function status(fn) {
  try { fn(); } catch (e) { return e.status ?? e.code ?? 'throw'; }
  return 'ok';
}

test('account detail names the account, its feeds and its freshness, scoped to that account', async () => {
  const s = await realStore();
  const { accountDetail } = await src('src/api/account-detail.mjs');
  try {
    const { chase } = await twoAccounts(s);
    const d = accountDetail(ctx(s, chase));
    assert.equal(d.account.id, chase);
    assert.equal(typeof d.account.label, 'string');
    assert.equal(d.account.inst, 'Chase');
    assert.equal(d.txn.count, 7);
    assert.equal(d.txn.from, '2032-02-01');
    assert.equal(d.txn.to, '2032-02-07');
    assert.equal(d.feeds.length, 1);
    const feed = d.feeds[0];
    assert.equal(feed.kind, 'file');
    assert.equal(feed.lastDataDate, '2032-02-07');
    assert.match(feed.label, /first\.csv|Aggregator|aggregator/i);
    assert.ok(['fresh', 'stale', 'unknown'].includes(feed.state));
    assert.ok(feed.howTo && Array.isArray(feed.howTo.steps) && feed.howTo.steps.length > 0, 'a file feed says how to refresh it');
    assert.equal(d.syncable, false);
    // The account's state is the one the health line counts.
    const { ingestState } = await src('src/ingest/freshness.mjs');
    const live = ingestState(s.db, {});
    assert.equal(d.fresh, live.accounts[chase]?.fresh ?? 'unknown');
    assert.equal(d.asOf, live.accounts[chase]?.asOf ?? '');
    const other = accountDetail(ctx(s, d.account.id === chase ? chase : chase));
    assert.equal(other.feeds.every((f) => f.label !== 'Other'), true);
  } finally {
    s.close();
  }
});

test('the balance date is the balance row, not the newest transaction', async () => {
  const s = await realStore();
  const { accountDetail } = await src('src/api/account-detail.mjs');
  try {
    const { chase } = await twoAccounts(s);
    assert.equal(accountDetail(ctx(s, chase)).balance.asOf, null);
    s.db.prepare('INSERT INTO balances (account_id, date, amount) VALUES (?, ?, ?)').run(chase, '2032-01-15', 100);
    const d = accountDetail(ctx(s, chase));
    assert.equal(d.balance.asOf, '2032-01-15');
    assert.equal(d.txn.to, '2032-02-07');
  } finally {
    s.close();
  }
});

test('paging does not skip or repeat rows that share a date', async () => {
  const s = await realStore();
  const { accountTransactions } = await src('src/api/account-detail.mjs');
  try {
    const { chase } = await twoAccounts(s);
    const add = s.db.prepare('INSERT INTO transactions (account_id, date, amount, description) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 5; i++) add.run(chase, '2032-02-07', 100 + i, `Tie ${i}`);
    const seen = [];
    let cursor = null;
    for (let i = 0; i < 20; i++) {
      const page = accountTransactions(ctx(s, chase, { limit: '2', ...(cursor ? { cursor } : {}) }));
      seen.push(...page.items.map((t) => t.id));
      cursor = page.next;
      if (!cursor) break;
    }
    assert.equal(seen.length, 12);
    assert.equal(new Set(seen).size, 12);
  } finally {
    s.close();
  }
});

test('account detail rejects a missing or unknown account', async () => {
  const s = await realStore();
  const { accountDetail } = await src('src/api/account-detail.mjs');
  try {
    await twoAccounts(s);
    assert.equal(await status(() => accountDetail(ctx(s, ''))), 400);
    assert.equal(await status(() => accountDetail({ db: s.db, config: s.config, params: {}, query: {} })), 400);
    assert.equal(await status(() => accountDetail(ctx(s, 'nope'))), 404);
  } finally {
    s.close();
  }
});

test('a connected account lists SimpleFIN with its sync and balance dates and can sync', async () => {
  const s = await realStore();
  const { accountDetail } = await src('src/api/account-detail.mjs');
  try {
    const { chase } = await twoAccounts(s);
    s.db.prepare(`INSERT INTO simplefin_connection (id, access_blob, connected_at, last_sync_at, status, accounts) VALUES (1, 'x', '2032-02-01T00:00:00.000Z', '2032-02-08T09:30:00.000Z', 'ok', 1)`).run();
    s.db.prepare(`INSERT INTO simplefin_accounts (sf_key, account_id, status, name, backfilled, created_at) VALUES ('k1', ?, 'mapped', 'Synthetic', 1, '2032-02-01')`).run(chase);
    s.db.prepare(`INSERT INTO simplefin_snapshots (sf_key, snapshot, at) VALUES ('k1', ?, '2032-02-08T09:30:00.000Z')`).run(JSON.stringify({ balance: 12, balanceDate: '2032-02-08' }));
    const d = accountDetail(ctx(s, chase));
    const sf = d.feeds.find((f) => f.kind === 'simplefin');
    assert.ok(sf, 'SimpleFIN is a feed of this account');
    assert.equal(sf.lastSyncAt, '2032-02-08T09:30:00.000Z');
    assert.equal(sf.balanceDate, '2032-02-08');
    assert.equal(d.syncable, true);
  } finally {
    s.close();
  }
});

test('transactions page newest first, once each, and only for the asked account', async () => {
  const s = await realStore();
  const { accountTransactions } = await src('src/api/account-detail.mjs');
  try {
    const { chase, harbor } = await twoAccounts(s);
    const seen = [];
    let cursor = null;
    let pages = 0;
    do {
      const page = accountTransactions(ctx(s, chase, { limit: '3', ...(cursor ? { cursor } : {}) }));
      assert.ok(page.items.length <= 3);
      seen.push(...page.items);
      cursor = page.next;
      pages += 1;
      assert.equal(page.total, 7);
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    assert.deepEqual(seen.map((t) => t.date), ['2032-02-07', '2032-02-06', '2032-02-05', '2032-02-04', '2032-02-03', '2032-02-02', '2032-02-01']);
    assert.equal(new Set(seen.map((t) => t.id)).size, 7);
    assert.equal(seen.some((t) => /Other account/.test(t.description)), false);
    const h = accountTransactions(ctx(s, harbor));
    assert.equal(h.items.length, 1);
    assert.equal(h.next, null);
  } finally {
    s.close();
  }
});

test('transactions filter by text and date range, and a percent sign is just a character', async () => {
  const s = await realStore();
  const { accountTransactions } = await src('src/api/account-detail.mjs');
  try {
    const { chase } = await twoAccounts(s);
    const coffee = accountTransactions(ctx(s, chase, { q: 'COFFEE' }));
    assert.equal(coffee.items.length, 1);
    assert.equal(coffee.total, 1);
    assert.equal(accountTransactions(ctx(s, chase, { q: '%' })).items.length, 1);
    assert.equal(accountTransactions(ctx(s, chase, { q: '_' })).items.length, 0);
    const range = accountTransactions(ctx(s, chase, { from: '2032-02-03', to: '2032-02-05' }));
    assert.deepEqual(range.items.map((t) => t.date), ['2032-02-05', '2032-02-04', '2032-02-03']);
    assert.equal(range.total, 3);
  } finally {
    s.close();
  }
});

test('every amount carries provenance: a figure and the source it came from', async () => {
  const s = await realStore();
  const { accountTransactions } = await src('src/api/account-detail.mjs');
  try {
    const { chase } = await twoAccounts(s);
    const page = accountTransactions(ctx(s, chase));
    const t = page.items[0];
    assert.ok(t.fig && typeof t.fig === 'string');
    const f = page.figures[t.fig];
    assert.equal(f.v, t.amount);
    assert.equal(f.kind, 'a');
    assert.ok(page.sources[f.src], 'the figure names a source');
    assert.match(page.sources[f.src].label, /first\.csv/);
  } finally {
    s.close();
  }
});

test('transactions refuse bad input', async () => {
  const s = await realStore();
  const { accountTransactions } = await src('src/api/account-detail.mjs');
  try {
    const { chase } = await twoAccounts(s);
    const bad = (query) => status(() => accountTransactions(ctx(s, chase, query)));
    assert.equal(await bad({ limit: '0' }), 400);
    assert.equal(await bad({ limit: '1000' }), 400);
    assert.equal(await bad({ limit: 'x' }), 400);
    assert.equal(await bad({ from: '2032-13-01' }), 400);
    assert.equal(await bad({ to: 'tomorrow' }), 400);
    assert.equal(await bad({ from: '2032-03-01', to: '2032-02-01' }), 400);
    assert.equal(await bad({ cursor: 'garbage' }), 400);
    assert.equal(await bad({ q: 'x'.repeat(101) }), 400);
    assert.equal(await status(() => accountTransactions(ctx(s, 'nope'))), 404);
  } finally {
    s.close();
  }
});
