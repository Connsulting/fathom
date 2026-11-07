// AC3 (HTTP): key routes and the MCP connection info against the real server child, plus the
// FATHOM_PUBLIC_URL and FATHOM_ALLOWED_HOSTS config.

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, ConfigError } from '../src/config.mjs';
import { routes } from '../src/api/router.mjs';
import {
  SERVER_TIMEOUT, spawnServer, withServer, expectServerExit, request, postJson, openStore, tempDir,
} from './helpers/server.mjs';

const T = { timeout: SERVER_TIMEOUT };
const T3 = { timeout: SERVER_TIMEOUT * 3 };
const KEY_RE = /^fathom_[A-Za-z0-9_-]{43}$/;
const LIST_FIELDS = ['createdAt', 'id', 'lastUsedAt', 'name', 'revokedAt', 'scopes'];

async function ok(resPromise) {
  const r = await resPromise;
  assert.equal(r.status, 200, `expected 200, got ${r.status}: ${r.text.slice(0, 300)}`);
  assert.ok(r.json, 'JSON body');
  return r;
}

async function fails(resPromise, status) {
  const r = await resPromise;
  assert.equal(r.status, status, `expected ${status}, got ${r.status}: ${r.text.slice(0, 300)}`);
  assert.equal(typeof (r.json && r.json.error), 'string', 'error body is { error }');
  return r;
}

async function readDb(file, fn) {
  const db = await openStore(file);
  try { return await fn(db); } finally { db.close(); }
}

const create = (s, body, headers) => postJson(s.baseUrl, '/api/keys', body, headers);
const revoke = (s, id, headers) => postJson(s.baseUrl, `/api/keys/${encodeURIComponent(id)}/revoke`, {}, headers);
const mcpInfo = (s, headers = {}) => request(s.baseUrl, { path: '/api/mcp', headers });

describe('key routes', () => {
  let s;
  before(async () => { s = await spawnServer({ env: { FATHOM_ENGINE: 'fake' } }); }, T);
  after(async () => { if (s) await s.stop(); });

  test('a fresh demo store lists no keys', async () => {
    const r = await ok(request(s.baseUrl, { path: '/api/keys' }));
    assert.deepEqual(r.json, { keys: [] });
    assert.match(r.headers['cache-control'] || '', /no-store/);
  });

  test('create shows the key once; the listing never carries it', async () => {
    const r = await ok(create(s, { name: 'Laptop agent' }));
    const { key, record, keys } = r.json;
    assert.match(key, KEY_RE);
    assert.equal(r.json.scenario, undefined, 'key responses carry no scenario');
    assert.deepEqual(Object.keys(record).sort(), LIST_FIELDS);
    assert.equal(record.name, 'Laptop agent');
    assert.deepEqual(record.scopes, ['read']);
    assert.equal(record.revokedAt, null);
    assert.equal(record.lastUsedAt, null);
    assert.ok(!Number.isNaN(Date.parse(record.createdAt)));
    assert.ok(Array.isArray(keys) && keys.some(k => k.id === record.id));
    for (const k of keys) assert.deepEqual(Object.keys(k).sort(), LIST_FIELDS);
    assert.ok(!JSON.stringify(keys).includes(key), 'the create response listing does not repeat the key');

    const list = await ok(request(s.baseUrl, { path: '/api/keys' }));
    assert.ok(!list.text.includes(key), 'GET /api/keys never returns the key');
    assert.ok(!list.text.includes(key.slice(7)), 'GET /api/keys never returns the key body');
    assert.ok(!/key_?hash|"hash"|"key"/i.test(list.text), 'no hash or key field in the listing');
    assert.deepEqual(list.json.keys.find(k => k.id === record.id), record);
  });

  test('two creates give distinct keys and ids', async () => {
    const a = (await ok(create(s, { name: 'Agent A' }))).json;
    const b = (await ok(create(s, { name: 'Agent B' }))).json;
    assert.notEqual(a.key, b.key);
    assert.notEqual(a.record.id, b.record.id);
  });

  test('scopes are normalized: write:recs always comes with read', async () => {
    const w = (await ok(create(s, { name: 'Writer', scopes: ['write:recs'] }))).json;
    assert.deepEqual(w.record.scopes, ['read', 'write:recs']);
    const r = (await ok(create(s, { name: 'Reader', scopes: [] }))).json;
    assert.deepEqual(r.record.scopes, ['read']);
  });

  test('bad input is 400 and stores nothing', async () => {
    const before = (await ok(request(s.baseUrl, { path: '/api/keys' }))).json.keys.length;
    await fails(create(s, {}), 400);
    await fails(create(s, { name: '' }), 400);
    await fails(create(s, { name: '   ' }), 400);
    await fails(create(s, { name: 'n'.repeat(81) }), 400);
    await fails(create(s, { name: 'line\nbreak' }), 400);
    await fails(create(s, { name: 42 }), 400);
    await fails(create(s, { name: 'Bad scope', scopes: ['admin'] }), 400);
    await fails(create(s, { name: 'Bad scope', scopes: ['read', 'write'] }), 400);
    const after = (await ok(request(s.baseUrl, { path: '/api/keys' }))).json.keys.length;
    assert.equal(after, before);
  });

  test('revoke flips the record once and is idempotent; unknown id is 404', async () => {
    const { record } = (await ok(create(s, { name: 'To revoke' }))).json;
    const r1 = (await ok(revoke(s, record.id))).json;
    assert.equal(r1.record.id, record.id);
    assert.ok(typeof r1.record.revokedAt === 'string' && !Number.isNaN(Date.parse(r1.record.revokedAt)));
    assert.equal(r1.keys.find(k => k.id === record.id).revokedAt, r1.record.revokedAt);
    assert.equal(r1.scenario, undefined);
    const r2 = (await ok(revoke(s, record.id))).json;
    assert.equal(r2.record.revokedAt, r1.record.revokedAt, 'second revoke keeps the first timestamp');
    await fails(revoke(s, 'key_000000000000'), 404);
  });

  test('wrong methods are 405, a non-JSON POST is 415', async () => {
    await fails(request(s.baseUrl, { method: 'DELETE', path: '/api/keys' }), 405);
    await fails(request(s.baseUrl, { method: 'PUT', path: '/api/keys' }), 405);
    await fails(request(s.baseUrl, { path: '/api/keys/key_000000000000/revoke' }), 405);
    await fails(postJson(s.baseUrl, '/api/mcp', {}), 405);
    await fails(request(s.baseUrl, { method: 'POST', path: '/api/keys', headers: { 'content-type': 'text/plain' }, body: '{"name":"x"}' }), 415);
    await fails(request(s.baseUrl, { method: 'POST', path: '/api/keys', body: '{"name":"x"}' }), 415);
    await ok(request(s.baseUrl, { method: 'POST', path: '/api/keys', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"name":"Charset ok"}' }));
  });

  test('cross-origin POSTs are 403; same-origin and no-origin POSTs are accepted', async () => {
    const host = new URL(s.baseUrl).host;
    const { record } = (await ok(create(s, { name: 'Origin target' }))).json;
    for (const origin of ['http://evil.example', 'null', `http://evil.example:${s.port}`]) {
      await fails(create(s, { name: 'Cross origin' }, { origin }), 403);
      await fails(revoke(s, record.id, { origin }), 403);
    }
    const keys = (await ok(request(s.baseUrl, { path: '/api/keys' }))).json.keys;
    assert.ok(!keys.some(k => k.name === 'Cross origin'));
    assert.equal(keys.find(k => k.id === record.id).revokedAt, null, 'a refused revoke changes nothing');
    await ok(create(s, { name: 'Same origin' }, { origin: `http://${host}` }));
    await ok(revoke(s, record.id, { origin: `http://${host}` }));
  });

  test('the store holds only a hash of the key', async () => {
    const { key, record } = (await ok(create(s, { name: 'Hash only', scopes: ['write:recs'] }))).json;
    const rows = await readDb(s.dbFile, db => db.prepare('SELECT * FROM api_keys').all().map(r => ({ ...r })));
    const row = rows.find(r => r.id === record.id);
    assert.ok(row);
    assert.match(row.key_hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(JSON.parse(row.scopes), ['read', 'write:recs']);
    const body = key.slice(7);
    assert.ok(!JSON.stringify(rows).includes(body), 'no api_keys row holds the key');
    for (const f of [s.dbFile, s.dbFile + '-wal']) {
      if (existsSync(f)) assert.ok(!readFileSync(f).includes(body), `${f.endsWith('-wal') ? 'WAL' : 'store'} file does not hold the key`);
    }
  });

  test('the server secret lives in the data dir as a 0600 file', () => {
    const file = join(s.dataDir, 'api-key-secret');
    assert.ok(existsSync(file));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.match(readFileSync(file, 'utf8').trim(), /^[0-9a-f]{64}$/);
  });

  test('demo reset clears keys and new keys still work', async () => {
    await ok(postJson(s.baseUrl, '/api/demo/reset', {}));
    assert.deepEqual((await ok(request(s.baseUrl, { path: '/api/keys' }))).json.keys, []);
    const { key } = (await ok(create(s, { name: 'After reset' }))).json;
    assert.match(key, KEY_RE);
  });
});

describe('key routes: Host allowlist (DNS rebinding)', () => {
  let s;
  before(async () => { s = await spawnServer({ env: { FATHOM_ENGINE: 'fake', FATHOM_ALLOWED_HOSTS: 'agent.example.test' } }); }, T);
  after(async () => { if (s) await s.stop(); });

  test('a foreign Host is 403 on list, create and revoke, even with a matching Origin', async () => {
    const evil = `rebind.example:${s.port}`;
    const same = { host: evil, origin: `http://${evil}` };
    await fails(request(s.baseUrl, { path: '/api/keys', headers: { host: evil } }), 403);
    await fails(create(s, { name: 'Rebound' }, same), 403);
    await fails(revoke(s, 'key_000000000000', same), 403);
    assert.deepEqual((await ok(request(s.baseUrl, { path: '/api/keys' }))).json.keys, []);
  });

  test('percent-encoded spellings of the key routes get the same refusal', async () => {
    const evil = `rebind.example:${s.port}`;
    const same = { host: evil, origin: `http://${evil}` };
    await fails(request(s.baseUrl, { path: '/api/%6beys', headers: { host: evil } }), 403);
    await fails(postJson(s.baseUrl, '/api/%6beys', { name: 'Rebound', scopes: ['write:recs'] }, same), 403);
    await fails(postJson(s.baseUrl, '/api/%6beys/key_000000000000/%72evoke', {}, same), 403);
    assert.deepEqual((await ok(request(s.baseUrl, { path: '/api/keys' }))).json.keys, []);
  });

  test('liveness: an encoded key route on an allowed Host is still served', async () => {
    await ok(request(s.baseUrl, { path: '/api/%6beys' }));
  });

  test('liveness: IP literal, localhost and a configured host are served', async () => {
    for (const host of [`127.0.0.1:${s.port}`, `localhost:${s.port}`, 'agent.example.test']) {
      await ok(request(s.baseUrl, { path: '/api/keys', headers: { host } }));
    }
    const { record } = (await ok(create(s, { name: 'Via configured host' }, { host: 'agent.example.test', origin: 'http://agent.example.test' }))).json;
    await ok(revoke(s, record.id, { host: 'agent.example.test', origin: 'http://agent.example.test' }));
  });
});

describe('GET /api/mcp', () => {
  let s;
  // The Host allowlist covers every /api route, so the DNS name these tests send is configured.
  before(async () => { s = await spawnServer({ env: { FATHOM_ENGINE: 'fake', FATHOM_PUBLIC_URL: undefined, FATHOM_ALLOWED_HOSTS: 'fathom.example.test' } }); }, T);
  after(async () => { if (s) await s.stop(); });

  test('url defaults to http on the request Host; tools and scopes are listed', async () => {
    const r = await ok(mcpInfo(s));
    assert.equal(r.json.url, `${s.baseUrl}/mcp`);
    assert.equal(r.json.publicUrlSet, false);
    assert.ok(Array.isArray(r.json.tools) && r.json.tools.length > 0);
    for (const x of r.json.tools) {
      assert.deepEqual(Object.keys(x).sort(), ['description', 'name', 'scope']);
      assert.ok(['read', 'write:recs', 'write:facts', 'write:steps', 'write:goals', 'write:preferences'].includes(x.scope));
    }
    const byName = Object.fromEntries(r.json.tools.map(x => [x.name, x.scope]));
    assert.equal(byName.set_recommendation_status, 'write:recs');
    for (const n of ['household_summary', 'list_packs', 'get_pack_entry', 'search_pack_entries']) assert.equal(byName[n], 'read', n);
    assert.deepEqual(r.json.scopes.map(x => x.id), ['read', 'write:recs', 'write:preferences', 'write:facts', 'write:steps', 'write:goals']);
    for (const sc of r.json.scopes) {
      assert.ok(typeof sc.label === 'string' && sc.label.length > 0);
      assert.ok(typeof sc.access === 'string' && sc.access.length > 0);
    }
  });

  test('demo URL without public configuration uses the socket scheme and ignores forwarding headers', async () => {
    for (const forwarded of ['https', 'https, http', 'http', 'ftp', 'javascript']) {
      const r = await ok(mcpInfo(s, { host: 'fathom.example.test:8443', 'x-forwarded-proto': forwarded, 'x-forwarded-host': 'foreign.example.test' }));
      assert.equal(r.json.url, 'http://fathom.example.test:8443/mcp');
    }
  });

  test('configured MCP URL is always the public origin plus /mcp', T3, async () => {
    const cases = [
      ['https://fathom.example.test', 'https://fathom.example.test/mcp'],
      ['https://fathom.example.test/', 'https://fathom.example.test/mcp'],
      ['http://localhost:9000', 'http://localhost:9000/mcp'],
    ];
    for (const [publicUrl, want] of cases) {
      await withServer({ env: { FATHOM_ENGINE: 'fake', FATHOM_PUBLIC_URL: publicUrl, FATHOM_ALLOWED_HOSTS: 'other.example.test' } }, async p => {
        const r = await ok(mcpInfo(p, { host: 'other.example.test', 'x-forwarded-proto': 'http' }));
        assert.equal(r.json.url, want, publicUrl);
        assert.equal(r.json.publicUrlSet, true);
      });
    }
  });
});

describe('routes and config', () => {
  test('the route table registers the key and MCP info routes', () => {
    const has = (method, path) => routes.some(r => r.method === method && r.path === path);
    assert.ok(has('GET', '/api/keys'));
    assert.ok(has('POST', '/api/keys'));
    assert.ok(has('POST', '/api/keys/:id/revoke'));
    assert.ok(has('GET', '/api/mcp'));
  });

  test('loadConfig defaults: no public url, no extra allowed hosts', () => {
    const c = loadConfig({});
    assert.equal(c.publicUrl, null);
    assert.deepEqual(c.allowedHosts, []);
  });

  test('loadConfig accepts HTTPS DNS names and explicit HTTP localhost ports', () => {
    const c = loadConfig({ FATHOM_PUBLIC_URL: 'https://Fathom.Example.Test', FATHOM_ALLOWED_HOSTS: 'Agent.Example.Test,box.example.test:8080' });
    assert.equal(typeof c.publicUrl, 'string');
    const u = new URL(c.publicUrl);
    assert.equal(u.protocol, 'https:');
    assert.equal(u.host, 'fathom.example.test');
    assert.deepEqual(c.allowedHosts, ['agent.example.test', 'box.example.test:8080']);
    assert.equal(new URL(loadConfig({ FATHOM_PUBLIC_URL: 'http://localhost:8080' }).publicUrl).origin, 'http://localhost:8080');
  });

  test('loadConfig refuses a bad public url', () => {
    for (const bad of ['not a url', 'ftp://fathom.example.test', 'javascript:alert(1)', 'https://user:pw@fathom.example.test',
      'https://user@fathom.example.test', 'https://fathom.example.test/base', 'http://example.test', 'http://localhost', 'http://127.0.0.1:8080', 'https://127.0.0.1', 'https://[::1]', 'https://fathom.example.test/?q=1', 'https://fathom.example.test/#frag', 'fathom.example.test']) {
      assert.throws(() => loadConfig({ FATHOM_PUBLIC_URL: bad }), ConfigError, bad);
    }
  });

  test('the server refuses to start with a bad FATHOM_PUBLIC_URL', T, async () => {
    const dataDir = await tempDir();
    const r = await expectServerExit({ dataDir, env: { FATHOM_ENGINE: 'fake', FATHOM_PUBLIC_URL: 'ftp://fathom.example.test' } });
    assert.equal(r.started, false, r.output);
    assert.notEqual(r.code, 0);
    assert.match(r.output, /FATHOM_PUBLIC_URL/);
  });
});
