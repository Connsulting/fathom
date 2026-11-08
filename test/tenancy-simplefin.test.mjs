import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { twoHouseholds } from './helpers/tenancy-runtime.mjs';
import { syncSimplefin } from '../src/ingest/simplefin.mjs';

const T = { timeout: 120000 };
const token = path => Buffer.from(`https://bridge.example.test/${path}`).toString('base64');

test('HTTP connect, sync, matching, watermark, dedupe and disconnect isolate colliding bridge ids', T, async () => {
  const calls = [];
  let epoch = 0;
  const emulator = createServer(async (req, res) => {
    calls.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const u = new URL(req.url, 'http://emulator.invalid');
    if (req.method === 'POST') {
      res.end(`https://${u.pathname.includes('alpha') ? 'alpha' : 'bravo'}:synthetic@bridge.example.test/access`);
      return;
    }
    const alpha = req.headers.authorization === `Basic ${Buffer.from('alpha:synthetic').toString('base64')}`;
    // SimpleFIN v1 account set: https://www.simplefin.org/protocol.html
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ errors: [], accounts: [{
      id: 'colliding-account', org: { id: 'colliding-connection', name: 'Synthetic Bank' },
      name: 'Synthetic Checking x1234', currency: 'USD', balance: alpha ? '101.00' : '202.00',
      'balance-date': Date.parse('2026-11-01T12:00:00Z') / 1000,
      transactions: [{ id: `same-posting-${epoch}`, posted: Date.parse('2026-10-31T12:00:00Z') / 1000,
        amount: alpha ? '-10.00' : '-20.00', description: `${alpha ? 'Alpha' : 'Bravo'} synthetic posting` }],
    }] }));
  });
  await new Promise(resolve => emulator.listen(0, '127.0.0.1', resolve));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    const u = new URL(url);
    if (u.hostname !== 'bridge.example.test') return realFetch(url, init);
    assert.equal(u.protocol, 'https:'); assert.equal(u.username, ''); assert.equal(init.redirect, 'error');
    return realFetch(`http://127.0.0.1:${emulator.address().port}${u.pathname}${u.search}`, init);
  };
  let fx;
  try {
    fx = await twoHouseholds({ extra: { FATHOM_SIMPLEFIN_ALLOWED_HOSTS: 'bridge.example.test', FATHOM_CLOCK: '2026-11-01' } });
    for (const hh of [fx.A, fx.B]) {
      await fx.ctx(hh.id).scheduler.tick();
      await fx.ctx(hh.id).db.prepare(`INSERT INTO accounts (id, inst, mask, name, kind, mirror) VALUES ('colliding-imported-id', 'Synthetic Bank', '1234', 'Imported checking', 'checking', 'manual')`).run();
      assert.equal((await hh.client.postJson('/api/household/outbound', { jobs: true, simplefin: true })).status, 200);
      const connected = await hh.client.postJson('/api/simplefin/connect', { token: token(`claim/${hh === fx.A ? 'alpha' : 'bravo'}`) });
      assert.equal(connected.status, 200, connected.text);
      assert.equal(connected.json.connected, true);
      assert.equal(connected.json.run.status, 'ok', connected.text);
    }
    const a = fx.ctx(fx.A.id), b = fx.ctx(fx.B.id);
    const conn = async hh => ({ ...await hh.db.prepare('SELECT * FROM simplefin_connection').get() });
    const transactions = async hh => (await hh.db.prepare('SELECT amount, description FROM transactions').all()).map(r => ({ ...r }));
    assert.notEqual((await conn(a)).access_blob, (await conn(b)).access_blob);
    for (const hh of [a, b]) assert.equal((await hh.db.prepare('SELECT account_id FROM simplefin_accounts').get()).account_id, 'colliding-imported-id');
    assert.ok(!(await conn(a)).access_blob.includes('synthetic'));
    assert.equal((await transactions(a)).length, 1); assert.equal((await transactions(b)).length, 1);
    assert.equal((await transactions(a))[0].amount, -10); assert.equal((await transactions(b))[0].amount, -20);
    assert.match((await transactions(a))[0].description, /Alpha/); assert.match((await transactions(b))[0].description, /Bravo/);
    assert.equal((await a.db.prepare('SELECT sf_key FROM simplefin_accounts').get()).sf_key, (await b.db.prepare('SELECT sf_key FROM simplefin_accounts').get()).sf_key);
    assert.equal((await a.db.prepare('SELECT backfilled FROM simplefin_accounts').get()).backfilled, 1);
    const bBefore = await conn(b);
    const again = await fx.A.client.postJson('/api/jobs/simplefin-sync/run', {});
    assert.equal(again.json.run.status, 'ok', again.text);
    assert.equal((await transactions(a)).length, 1);
    assert.deepEqual(await conn(b), bBefore);
    const gets = calls.filter(c => c.method === 'GET');
    assert.notEqual(new URL(gets[0].url, 'http://test.invalid').searchParams.get('start-date'), new URL(gets.at(-1).url, 'http://test.invalid').searchParams.get('start-date'));
    epoch = 1;
    assert.equal((await fx.B.client.postJson('/api/jobs/simplefin-sync/run', {})).json.run.status, 'ok');
    assert.equal((await transactions(a)).length, 1); assert.equal((await transactions(b)).length, 2);
    const beforeDisconnect = await transactions(a);
    assert.equal((await fx.A.client.postJson('/api/simplefin/disconnect', {})).json.disconnected, true);
    assert.equal((await a.db.prepare('SELECT count(*) AS n FROM simplefin_connection').get()).n, 0);
    assert.deepEqual(await transactions(a), beforeDisconnect);
    assert.equal((await b.db.prepare('SELECT count(*) AS n FROM simplefin_connection').get()).n, 1);
    const safeCalls = calls.length;
    for (const url of ['http://bridge.example.test/claim', 'https://127.0.0.1/claim', 'https://outside.example.test/claim', 'https://user:secret@bridge.example.test/claim']) {
      const result = await fx.A.client.postJson('/api/simplefin/connect', { token: Buffer.from(url).toString('base64') });
      assert.equal(result.status, 400, result.text);
    }
    assert.equal(calls.length, safeCalls);
  } finally {
    globalThis.fetch = realFetch;
    await fx?.close(); await new Promise(resolve => emulator.close(resolve));
  }
});

test('direct sync respects household outbound pause before network dispatch', T, async () => {
  const fx = await twoHouseholds();
  try {
    const hh = await fx.ctx(fx.B.id); await hh.scheduler.tick();
    let calls = 0;
    const r = await syncSimplefin(hh.db, { household: hh, fetch: async () => { calls++; throw new Error('unexpected network'); } });
    assert.equal(r.status, 'skipped'); assert.equal(r.code, 'paused'); assert.equal(calls, 0);
  } finally { await fx.close(); }
});
