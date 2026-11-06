// SimpleFIN Bridge connections: token decode and validation, the SSRF guard, the access URL
// encrypted at rest and absent from logs, mapping into the ledger through the ingest pipeline with
// dedupe against imported rows, the account match Confirm card, bridge errors and Disconnect.
// Every bridge here is synthetic (the fake bridge or a scripted fetch); nothing touches the network.

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { src } from '../helpers/server.mjs';
import { realStore, aggregatorFile, NOW } from '../helpers/ingest.mjs';

let S, P, C, Cfg;
before(async () => {
  S = await src('src/ingest/simplefin.mjs');
  P = await src('src/ingest/pipeline.mjs');
  C = await src('src/ingest/confirm.mjs');
  Cfg = await src('src/config.mjs');
});

const TODAY = NOW.slice(0, 10);
const PASSWORD = 'fake-demo-password';

function storeText(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
  return tables.map((t) => JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
}

async function withStore(fn) {
  const s = await realStore();
  try { return await fn(s); } finally { s.close(); }
}

// Capture console output during fn.
async function captureLogs(fn) {
  const lines = [];
  const saved = {};
  for (const k of ['log', 'error', 'warn', 'info']) { saved[k] = console[k]; console[k] = (...a) => lines.push(a.map(String).join(' ')); }
  try { await fn(); } finally { Object.assign(console, saved); }
  return lines.join('\n');
}

const opts = (s, extra = {}) => ({ config: s.config, key: s.key, now: NOW, clock: TODAY, fetch: S.createFakeSimplefin({ today: () => TODAY }), ...extra });

test('setup tokens decode to their claim URL; malformed tokens are refused', () => {
  assert.equal(S.decodeSetupToken(S.fakeToken()), 'https://bridge.simplefin.org/simplefin/claim/demo-fathom');
  assert.equal(S.decodeSetupToken(`  ${S.fakeToken()}\n`), 'https://bridge.simplefin.org/simplefin/claim/demo-fathom');
  for (const bad of ['', 'not a token!', Buffer.from('ftp://x').toString('base64'), 'x'.repeat(5000)]) {
    assert.throws(() => S.decodeSetupToken(bad), (e) => e.code === 'bad_token');
  }
});

test('the SSRF guard allows only https on a listed host with the default port', () => {
  const hosts = S.DEFAULT_HOSTS;
  assert.equal(S.guardUrl('https://bridge.simplefin.org/simplefin/claim/a', hosts, { credentials: 'forbid' }).hostname, 'bridge.simplefin.org');
  const refused = {
    'http://bridge.simplefin.org/claim': 'bad_token',
    'https://169.254.169.254/latest/meta-data': 'host_not_allowed',
    'https://localhost/claim': 'host_not_allowed',
    'https://bridge.simplefin.org:8443/claim': 'host_not_allowed',
    'https://bridge.simplefin.org.evil.example/claim': 'host_not_allowed',
    'https://evil.example/@bridge.simplefin.org': 'host_not_allowed',
    'https://user:pw@bridge.simplefin.org/claim': 'bad_token',
  };
  for (const [url, code] of Object.entries(refused)) assert.throws(() => S.guardUrl(url, hosts, { credentials: 'forbid' }), (e) => e.code === code, url);
  assert.throws(() => S.guardUrl('https://bridge.simplefin.org/simplefin', hosts, { credentials: 'require' }), (e) => e.code === 'bad_access');
});

test('a token pointing at another host is refused before any request', async () => {
  let calls = 0;
  const token = Buffer.from('https://internal.example/claim/x').toString('base64');
  await assert.rejects(S.claimToken(token, { hosts: S.DEFAULT_HOSTS, fetch: async () => { calls += 1; return new Response('x'); } }), (e) => e.code === 'host_not_allowed');
  assert.equal(calls, 0);
});

test('a claim answer that is not an allowed access URL is refused', async () => {
  const fetch = async () => new Response('https://u:p@internal.example/simplefin', { status: 200 });
  await assert.rejects(S.claimToken(S.fakeToken(), { hosts: S.DEFAULT_HOSTS, fetch }), (e) => e.code === 'host_not_allowed');
});

test('FATHOM_SIMPLEFIN_ALLOWED_HOSTS defaults to the bridge hosts and rejects URLs', () => {
  assert.deepEqual(Cfg.loadConfig({}).simplefinHosts, ['bridge.simplefin.org', 'beta-bridge.simplefin.org']);
  assert.deepEqual(Cfg.loadConfig({ FATHOM_SIMPLEFIN_ALLOWED_HOSTS: 'Bridge.Example.org, sfin.example.org' }).simplefinHosts, ['bridge.example.org', 'sfin.example.org']);
  assert.throws(() => Cfg.loadConfig({ FATHOM_SIMPLEFIN_ALLOWED_HOSTS: 'https://bridge.example.org' }), /FATHOM_SIMPLEFIN_ALLOWED_HOSTS/);
});

test('a used or unknown setup token gives a clear error and stores nothing', () => withStore(async (s) => {
  await assert.rejects(S.connectSimplefin(s.db, S.fakeToken('used-token'), opts(s)), (e) => e.code === 'token_used' && /already used/.test(e.message));
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM simplefin_connection').get().n, 0);
}));

test('the access URL is encrypted at rest and never logged', () => withStore(async (s) => {
  const logs = await captureLogs(async () => {
    await S.connectSimplefin(s.db, S.fakeToken(), opts(s));
    await S.syncSimplefin(s.db, opts(s));
  });
  const row = s.db.prepare('SELECT access_blob FROM simplefin_connection').get();
  const text = storeText(s.db);
  assert.ok(!text.includes(PASSWORD), 'password not in the store');
  assert.ok(!text.includes('demo:'), 'credentials not in the store');
  assert.ok(!logs.includes(PASSWORD));
  const { decrypt } = await src('src/ingest/vault.mjs');
  assert.match(decrypt(s.key, Buffer.from(row.access_blob, 'base64'), 'simplefin:access').toString('utf8'), /^https:\/\/demo:fake-demo-password@bridge\.simplefin\.org\/simplefin$/);
}));

test('a sync maps accounts, last four digits, balances and transactions; a resync dedupes', () => withStore(async (s) => {
  await S.connectSimplefin(s.db, S.fakeToken(), opts(s));
  const first = await S.syncSimplefin(s.db, opts(s));
  assert.equal(first.status, 'ok');
  assert.equal(first.changed, true);
  const accounts = s.db.prepare("SELECT inst, mask, name, mirror, kind FROM accounts ORDER BY name").all();
  assert.deepEqual(accounts.map((a) => [a.inst, a.mask, a.mirror]), [
    ['Other bank', null, 'connected'],
    ['Fathom Demo Bank', '4821', 'connected'],
    ['Fathom Demo Brokerage', '2290', 'connected'],
    ['Fathom Demo Bank', '7310', 'connected'],
  ]);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM transactions WHERE parser = 'simplefin'").get().n, 7);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM transactions WHERE external_id IS NULL").get().n, 0);
  const bal = s.db.prepare("SELECT b.amount FROM balances b JOIN accounts a ON a.id = b.account_id WHERE a.mask = '4821'").get();
  assert.equal(bal.amount, 8412.37);
  const again = await S.syncSimplefin(s.db, opts(s, { now: '2032-03-10T18:00:00.000Z' }));
  assert.equal(again.changed, false);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 7);
  assert.equal(s.db.prepare('SELECT accounts FROM simplefin_connection').get().accounts, 4);
}));

test('long digit runs in a name are cut to the last four', () => {
  const set = S.normalizeAccountSet({ errlist: [], connections: [], accounts: [{ id: 'A', conn_id: 'c', name: 'Card 4111222233334444', currency: 'USD', balance: '1', 'balance-date': 1, transactions: [] }] });
  assert.equal(set.accounts[0].name, 'Card ...4444');
  assert.equal(set.accounts[0].mask, '4444');
  assert.equal(S.lastFour('Checking', '000123456789'), '6789');
  assert.equal(S.lastFour('Checking', 'ACT-9f3e-1234abcd'), null);
});

test('a connected account matches an imported one by institution and mask and keeps file history', () => withStore(async (s) => {
  const day = (n) => new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
  // Imported first: the same checking account (mask 4821), with history through three days ago,
  // including the paycheck the bridge also reports.
  const file = aggregatorFile('history.csv', [
    { date: day(20), amount: '10.00', inst: 'Fathom Demo Bank', account: 'Everyday Checking', number: '9990004821', description: 'Old row' },
    { date: day(3), amount: '-2450.00', inst: 'Fathom Demo Bank', account: 'Everyday Checking', number: '9990004821', description: 'Client payment' },
  ]);
  const imported = await P.ingestFile(s.db, file, s.opts(null));
  assert.equal(imported.status, 'imported');
  const before = s.db.prepare("SELECT id, mirror FROM accounts WHERE mask = '4821'").get();
  assert.equal(before.mirror, 'manual');
  await S.connectSimplefin(s.db, S.fakeToken(), opts(s));
  await S.syncSimplefin(s.db, opts(s));
  const all = s.db.prepare("SELECT id, mirror FROM accounts WHERE mask = '4821'").all();
  assert.equal(all.length, 1, 'no second account');
  assert.equal(all[0].id, before.id);
  assert.equal(all[0].mirror, 'connected');
  // The paycheck three days ago stays the file's row only (same date and amount); every other
  // bridge posting is added, also ones dated before the file's latest row.
  const rows = s.db.prepare('SELECT date, amount, parser FROM transactions WHERE account_id = ? ORDER BY date').all(before.id);
  assert.equal(rows.filter((r) => r.amount === 2450).length, 1);
  assert.deepEqual(rows.filter((r) => r.parser === 'simplefin').map((r) => r.date), [day(9), day(6), day(1)]);
}));

test('an unsure match asks a Confirm card and imports nothing for it until answered', () => withStore(async (s) => {
  await P.ingestFile(s.db, aggregatorFile('other.csv', [
    { date: '2032-01-05', amount: '5.00', inst: 'Other bank', account: 'Joint checking', number: '', description: 'Old' },
  ]), s.opts(null));
  const imported = s.db.prepare("SELECT id FROM accounts WHERE inst = 'Other bank'").get();
  await S.connectSimplefin(s.db, S.fakeToken(), opts(s));
  const out = await S.syncSimplefin(s.db, opts(s));
  assert.equal(out.counts.pending, 1);
  const item = s.db.prepare("SELECT * FROM confirm_items WHERE kind = 'account_match'").get();
  assert.ok(item);
  assert.match(item.question, /Is Checking at Other bank from SimpleFIN the same account as Joint checking/);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM accounts WHERE inst = 'Other bank'").get().n, 1);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM transactions WHERE description = 'Coffee shop'").get().n, 0);
  C.answer(s.db, item.id, 'same', { now: NOW });
  await S.syncSimplefin(s.db, opts(s, { now: '2032-03-10T13:00:00.000Z' }));
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM accounts WHERE inst = 'Other bank'").get().n, 1);
  assert.equal(s.db.prepare("SELECT account_id FROM transactions WHERE description = 'Coffee shop'").get().account_id, imported.id);
  assert.equal(s.db.prepare('SELECT mirror FROM accounts WHERE id = ?').get(imported.id).mirror, 'connected');
}));

test('a different answer gives the connected account its own row', () => withStore(async (s) => {
  await P.ingestFile(s.db, aggregatorFile('other.csv', [
    { date: '2032-01-05', amount: '5.00', inst: 'Other bank', account: 'Joint checking', number: '', description: 'Old' },
  ]), s.opts(null));
  await S.connectSimplefin(s.db, S.fakeToken(), opts(s));
  await S.syncSimplefin(s.db, opts(s));
  const item = s.db.prepare("SELECT * FROM confirm_items WHERE kind = 'account_match'").get();
  C.answer(s.db, item.id, 'different', { now: NOW });
  await S.syncSimplefin(s.db, opts(s, { now: '2032-03-10T13:00:00.000Z' }));
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM accounts WHERE inst = 'Other bank'").get().n, 2);
}));

test('revoked access and bridge auth errors ask for a reconnect', () => withStore(async (s) => {
  await S.connectSimplefin(s.db, S.fakeToken('demo-revoked'), opts(s));
  const out = await S.syncSimplefin(s.db, opts(s));
  assert.deepEqual([out.status, out.code], ['reconnect', 'revoked']);
  assert.deepEqual({ ...s.db.prepare('SELECT status, error_code FROM simplefin_connection').get() }, { status: 'reconnect', error_code: 'revoked' });
  // Reconnecting with a new token replaces the stored access and clears the prompt.
  await S.connectSimplefin(s.db, S.fakeToken(), opts(s));
  assert.equal(s.db.prepare('SELECT status FROM simplefin_connection').get().status, 'ok');
  // A bridge answer whose errlist reports an auth problem still imports what it has.
  const body = { ...S.fakeAccountSet(TODAY), errlist: [{ code: 'con.auth', msg: 'Sign in again\u0007 at the bank' }] };
  const fetch = async () => new Response(JSON.stringify(body), { status: 200 });
  const second = await S.syncSimplefin(s.db, opts(s, { fetch }));
  assert.deepEqual([second.status, second.code], ['reconnect', 'auth']);
  assert.ok(second.counts.transactions > 0);
  assert.deepEqual(JSON.parse(s.db.prepare('SELECT messages FROM simplefin_connection').get().messages), ['Sign in again at the bank']);
  const paid = await S.syncSimplefin(s.db, opts(s, { fetch: async () => new Response('', { status: 402 }) }));
  assert.equal(paid.code, 'payment_required');
  const junk = await S.syncSimplefin(s.db, opts(s, { fetch: async () => new Response('<html>', { status: 200 }) }));
  assert.deepEqual([junk.status, junk.code], ['error', 'bad_response']);
}));

test('requests never put credentials in the URL and refuse redirects', () => withStore(async (s) => {
  await S.connectSimplefin(s.db, S.fakeToken(), opts(s));
  const seen = [];
  const inner = S.createFakeSimplefin({ today: () => TODAY });
  await S.syncSimplefin(s.db, opts(s, { fetch: (url, init) => { seen.push({ url, redirect: init.redirect }); return inner(url, init); } }));
  assert.equal(seen.length, 1);
  assert.ok(!seen[0].url.includes(PASSWORD) && !seen[0].url.includes('@'));
  assert.match(seen[0].url, /^https:\/\/bridge\.simplefin\.org\/simplefin\/accounts\?version=2&start-date=\d+$/);
  assert.equal(seen[0].redirect, 'error');
}));

test('Disconnect deletes the stored access URL and stops mirroring', () => withStore(async (s) => {
  await S.connectSimplefin(s.db, S.fakeToken(), opts(s));
  await S.syncSimplefin(s.db, opts(s));
  assert.deepEqual(S.disconnectSimplefin(s.db), { disconnected: true });
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM simplefin_connection').get().n, 0);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM accounts WHERE mirror = 'connected'").get().n, 0);
  assert.ok(s.db.prepare('SELECT count(*) AS n FROM transactions').get().n > 0, 'rows stay');
  assert.equal((await S.syncSimplefin(s.db, opts(s))).status, 'skipped');
}));

// The scheduler job on a demo store (the fake bridge): counts-only note, a plan run triggered after
// rows were written, skipped when not connected, and an error code when access is revoked.
test('the simplefin-sync job runs under the scheduler, records counts and triggers planning', async () => {
  const { tempDb } = await src('test/helpers/server.mjs');
  const { seedDemo } = await src('demo/seed.mjs');
  const { createScheduler, defaultHandlers } = await src('src/jobs/scheduler.mjs');
  const t = await tempDb();
  try {
    seedDemo(t.db);
    const config = { dataDir: t.dataDir, clock: '2026-11-05', demo: true, engine: 'off', emailTransport: 'dev', publicUrl: null, simplefinHosts: S.DEFAULT_HOSTS };
    const handlers = defaultHandlers({});
    const s = createScheduler({ db: t.db, config, handlers, now: () => new Date('2026-11-05T15:00:00Z'), tickMs: 3600000, holder: 'sf-test' });
    const skipped = await s.runNow('simplefin-sync');
    assert.equal(skipped.status, 'skipped');
    await S.connectSimplefin(t.db, S.fakeToken(), { config, now: '2026-11-05T15:00:00Z', fetch: S.createFakeSimplefin({ today: () => '2026-11-05' }) });
    const run = await s.runNow('simplefin-sync');
    assert.equal(run.status, 'ok');
    assert.equal(run.note.accounts, 4);
    assert.ok(run.note.transactions > 0);
    assert.equal(run.note.changed, true);
    assert.equal(run.note.pending, 1, 'the demo other bank account waits on a match question');
    const note = JSON.parse(t.db.prepare("SELECT note FROM job_runs WHERE job_id = 'simplefin-sync' ORDER BY id DESC LIMIT 1").get().note);
    assert.ok(Object.values(note).every((v) => typeof v === 'number' || typeof v === 'boolean'), 'counts only');
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(t.db.prepare("SELECT count(*) AS n FROM job_runs WHERE job_id = 'plan' AND trigger = 'ingest'").get().n >= 1, 'planning triggered');
    t.db.prepare('DELETE FROM simplefin_connection').run();
    await S.connectSimplefin(t.db, S.fakeToken('demo-revoked'), { config, now: '2026-11-05T15:00:00Z', fetch: S.createFakeSimplefin() });
    const failed = await s.runNow('simplefin-sync');
    assert.deepEqual([failed.status, failed.errorClass], ['error', 'simplefin_revoked']);
    await s.stop();
  } finally {
    try { t.db.close(); } catch { /* closed */ }
  }
});

// Review fixes: one regression test each.
const setWith = (accounts, connections = [{ conn_id: 'C1', name: 'Fathom Demo Bank', org_id: 'o', sfin_url: 'https://bridge.simplefin.org/simplefin' }]) =>
  async () => new Response(JSON.stringify({ errlist: [], connections, accounts }), { status: 200 });
const acct = (id, name, extra = {}) => ({ id, conn_id: 'C1', name, currency: 'USD', balance: '100.00', 'balance-date': 1962100000, transactions: [], ...extra });

test('a mask taken from an all-digit id is asked about, never merged silently', () => withStore(async (s) => {
  await P.ingestFile(s.db, aggregatorFile('chk.csv', [{ date: '2032-01-05', amount: '5.00', inst: 'Fathom Demo Bank', account: 'Checking', number: '9990004821', description: 'Old' }]), s.opts(null));
  await S.connectSimplefin(s.db, S.fakeToken(), opts(s));
  const out = await S.syncSimplefin(s.db, opts(s, { fetch: setWith([acct('9876544821', 'Savings')]) }));
  assert.equal(out.counts.pending, 1);
  assert.equal(out.counts.matched, 0);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM confirm_items WHERE kind = 'account_match'").get().n, 1);
}));

test('two bridge accounts with the same institution, name and balance both import', () => withStore(async (s) => {
  await S.connectSimplefin(s.db, S.fakeToken(), opts(s));
  const conns = [{ conn_id: 'C1', name: 'Synthetic Bank', org_id: 'a', sfin_url: 'x' }, { conn_id: 'C2', name: 'Synthetic Bank', org_id: 'b', sfin_url: 'x' }];
  const tx = [{ id: 'T1', posted: 1962000000, amount: '-5.00', description: 'Same' }];
  const out = await S.syncSimplefin(s.db, opts(s, { fetch: setWith([acct('A', 'Checking', { transactions: tx }), acct('A', 'Checking', { conn_id: 'C2', transactions: tx })], conns) }));
  assert.equal(out.status, 'ok');
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM accounts WHERE inst = 'Synthetic Bank'").get().n, 2);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM balances').get().n, 2);
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 2);
}));

test('an account held by a match question still gets the full first window after the answer', () => withStore(async (s) => {
  await P.ingestFile(s.db, aggregatorFile('other.csv', [{ date: '2032-01-05', amount: '5.00', inst: 'Other bank', account: 'Joint checking', number: '', description: 'Old' }]), s.opts(null));
  await S.connectSimplefin(s.db, S.fakeToken(), opts(s));
  const starts = [];
  const inner = S.createFakeSimplefin({ today: () => TODAY });
  const fetch = (url, init) => { starts.push(new URL(url).searchParams.get('start-date')); return inner(url, init); };
  await S.syncSimplefin(s.db, opts(s, { fetch }));
  C.answer(s.db, s.db.prepare("SELECT id FROM confirm_items WHERE kind = 'account_match'").get().id, 'same', { now: NOW });
  await S.syncSimplefin(s.db, opts(s, { fetch, now: '2032-03-10T13:00:00.000Z' }));
  await S.syncSimplefin(s.db, opts(s, { fetch, now: '2032-03-10T14:00:00.000Z' }));
  assert.equal(starts[1], starts[0], 'the answered account syncs the full window');
  assert.ok(Number(starts[2]) > Number(starts[0]), 'then the window narrows');
}));

test('a file uploaded after connecting lands in the connected account', () => withStore(async (s) => {
  await S.connectSimplefin(s.db, S.fakeToken(), opts(s));
  await S.syncSimplefin(s.db, opts(s));
  const r = await P.ingestFile(s.db, aggregatorFile('later.csv', [{ date: '2032-01-05', amount: '5.00', inst: 'Fathom Demo Bank', account: 'Everyday Checking', number: '9990004821', description: 'Old' }]), s.opts(null));
  assert.equal(r.status, 'imported');
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM accounts WHERE mask = '4821'").get().n, 1);
}));

test('a resync with a changed description is the same posting', () => withStore(async (s) => {
  await S.connectSimplefin(s.db, S.fakeToken(), opts(s));
  const tx = (description) => [{ id: 'T1', posted: 1962000000, amount: '-5.00', description }];
  await S.syncSimplefin(s.db, opts(s, { fetch: setWith([acct('A', 'Checking x1111', { transactions: tx('POS 123') })]) }));
  await S.syncSimplefin(s.db, opts(s, { now: '2032-03-10T13:00:00.000Z', fetch: setWith([acct('A', 'Checking x1111', { transactions: tx('Coffee shop') })]) }));
  assert.equal(s.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 1);
  assert.equal(s.db.prepare("SELECT count(*) AS n FROM confirm_items WHERE kind = 'near_duplicate'").get().n, 0);
}));
