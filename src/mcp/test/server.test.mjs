import { instructions } from '../../tools/index.mjs';
// AC1 (raw HTTP): POST /mcp on the real server child. Auth, Host and Origin guards, methods,
// scope-filtered tools, the permission refusal, last-use tracking and log hygiene.

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { SERVER_TIMEOUT, spawnServer, request } from '../../../test/helpers/server.mjs';
import {
  UNAUTHORIZED, PERMISSION_TEXT, createKey, revokeKey, mcpPost, bearer, initializeParams, rpcResult,
  listToolNames, callToolRpc, withStore, apiKeyRow, unknownKey,
} from './helpers.mjs';

const T = { timeout: SERVER_TIMEOUT };
const PUBLIC_HOST = 'fathom.example.test';
const EXTRA_HOST = 'agent.example.test';
const PACK_TOOLS = ['knowledge', 'knowledge', 'knowledge'];

let s;
let readKey;
let writeKey;
let revokedKey;
const seenKeys = [];
const seenResults = [];

before(async () => {
  s = await spawnServer({
    env: { FATHOM_ENGINE: 'fake', FATHOM_PUBLIC_URL: `https://${PUBLIC_HOST}`, FATHOM_ALLOWED_HOSTS: `${EXTRA_HOST},box.example.test:7000` },
  });
  readKey = await createKey(s.baseUrl, 'Read agent');
  writeKey = await createKey(s.baseUrl, 'Write agent', ['write:recs']);
  revokedKey = await createKey(s.baseUrl, 'Revoked agent');
  await revokeKey(s.baseUrl, revokedKey.record.id);
  seenKeys.push(readKey.key, writeKey.key, revokedKey.key);
}, T);
after(async () => { if (s) await s.stop(); });

const hostHeader = () => new URL(s.baseUrl).host;

function assertUnauthorized(r, label) {
  assert.equal(r.status, 401, `${label}: expected 401, got ${r.status}: ${r.text.slice(0, 200)}`);
  assert.equal(r.text, UNAUTHORIZED, `${label}: body is exactly the generic refusal`);
  assert.match(r.headers['www-authenticate'] || '', /^Bearer\b/, `${label}: WWW-Authenticate`);
}

describe('authentication', () => {
  test('missing, malformed, unknown and revoked keys get the identical 401', async () => {
    const cases = [
      ['missing', undefined],
      ['empty', ''],
      ['scheme only', 'Bearer'],
      ['scheme and space', 'Bearer '],
      ['basic scheme', `Basic ${Buffer.from('user:pass').toString('base64')}`],
      ['no scheme', readKey.key],
      ['two tokens', `Bearer ${readKey.key} ${readKey.key}`],
      ['wrong prefix', `Bearer other_${readKey.key.slice(7)}`],
      ['short', `Bearer ${readKey.key.slice(0, 20)}`],
      ['long', `Bearer ${readKey.key}x`],
      ['unknown', `Bearer ${unknownKey()}`],
      ['revoked', bearer(revokedKey.key)],
    ];
    const bodies = new Set();
    for (const [label, auth] of cases) {
      const r = await mcpPost(s.baseUrl, { auth, method: 'tools/list' });
      assertUnauthorized(r, label);
      bodies.add(r.text);
    }
    assert.equal(bodies.size, 1);
  });

  test('liveness: a valid read key with a normal Host and no Origin is served', async () => {
    const r = await mcpPost(s.baseUrl, { auth: bearer(readKey.key), method: 'tools/list' });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(rpcResult(r).tools.length > 0);
  });

  test('the Bearer scheme is case-insensitive', async () => {
    for (const scheme of ['bearer', 'BEARER', 'Bearer']) {
      const r = await mcpPost(s.baseUrl, { auth: `${scheme} ${readKey.key}`, method: 'tools/list' });
      assert.equal(r.status, 200, `${scheme}: ${r.text.slice(0, 200)}`);
    }
  });

  test('a revoked key that worked before is refused after revoke', async () => {
    const k = await createKey(s.baseUrl, 'Revoke live');
    seenKeys.push(k.key);
    assert.equal((await mcpPost(s.baseUrl, { auth: bearer(k.key) })).status, 200);
    await revokeKey(s.baseUrl, k.record.id);
    assertUnauthorized(await mcpPost(s.baseUrl, { auth: bearer(k.key) }), 'after revoke');
  });
});

describe('Host and Origin guards', () => {
  test('a foreign Host is 403 before auth, with or without a key', async () => {
    for (const host of ['evil.example', `evil.example:${s.port}`, `${PUBLIC_HOST}.evil.example`, `other.example.test:${s.port}`, `box.example.test:7001`]) {
      for (const auth of [bearer(readKey.key), undefined]) {
        const r = await mcpPost(s.baseUrl, { auth, headers: { host } });
        assert.equal(r.status, 403, `${host}: ${r.text.slice(0, 200)}`);
        assert.deepEqual(r.json, { error: 'forbidden host' });
      }
    }
  });

  test('liveness: IP literal, localhost, the public url host and configured hosts are allowed', async () => {
    const allowed = [
      hostHeader(), `127.0.0.1:${s.port}`, '127.0.0.1', '10.20.30.40:8080', '[::1]', `[::1]:${s.port}`,
      `localhost:${s.port}`, 'localhost', `fathom.localhost:${s.port}`, 'LOCALHOST',
      PUBLIC_HOST, EXTRA_HOST, `${EXTRA_HOST}:9999`, 'box.example.test:7000',
    ];
    for (const host of allowed) {
      const r = await mcpPost(s.baseUrl, { auth: bearer(readKey.key), headers: { host } });
      assert.equal(r.status, 200, `${host}: ${r.text.slice(0, 200)}`);
    }
  });

  test('a foreign Origin is 403', async () => {
    for (const origin of ['http://evil.example', 'null', `http://evil.example:${s.port}`, `http://127.0.0.1:${Number(s.port) + 1}`, `file://${hostHeader()}`]) {
      const r = await mcpPost(s.baseUrl, { auth: bearer(readKey.key), headers: { origin } });
      assert.equal(r.status, 403, `${origin}: ${r.text.slice(0, 200)}`);
      assert.deepEqual(r.json, { error: 'forbidden origin' });
    }
  });

  test('liveness: an Origin matching the Host is allowed over http and https', async () => {
    for (const origin of [`http://${hostHeader()}`, `https://${hostHeader()}`]) {
      const r = await mcpPost(s.baseUrl, { auth: bearer(readKey.key), headers: { origin } });
      assert.equal(r.status, 200, `${origin}: ${r.text.slice(0, 200)}`);
    }
    const r = await mcpPost(s.baseUrl, { auth: bearer(readKey.key), headers: { host: `localhost:${s.port}`, origin: `http://localhost:${s.port}` } });
    assert.equal(r.status, 200, r.text.slice(0, 200));
  });
});

describe('methods and bodies', () => {
  test('GET and DELETE with a valid key are 405 with Allow: POST', async () => {
    for (const method of ['GET', 'DELETE']) {
      const r = await request(s.baseUrl, { method, path: '/mcp', headers: { authorization: bearer(readKey.key), accept: 'application/json, text/event-stream' } });
      assert.equal(r.status, 405, `${method}: ${r.text.slice(0, 200)}`);
      assert.equal(r.headers.allow, 'POST');
    }
  });

  test('GET without a key is 401, not 405', async () => {
    const r = await request(s.baseUrl, { path: '/mcp' });
    assertUnauthorized(r, 'GET no key');
  });

  test('a body over 1 MiB is 413; malformed JSON is 400', async () => {
    // A declared length over the cap is refused before any body is read. A raw socket keeps this
    // deterministic: the server closes the connection after the 413, which a client still
    // streaming a megabyte can see as a reset before it reads the reply.
    const head = [
      'POST /mcp HTTP/1.1', `Host: 127.0.0.1:${s.port}`, `Authorization: ${bearer(readKey.key)}`,
      'Content-Type: application/json', 'Accept: application/json, text/event-stream',
      `Content-Length: ${1024 * 1024 + 10}`, 'Connection: close', '', '',
    ].join('\r\n');
    const reply = await new Promise((resolve, reject) => {
      const sock = net.connect(Number(s.port), '127.0.0.1', () => sock.write(head));
      let text = '';
      sock.on('data', c => { text += c; if (text.includes('\r\n\r\n')) sock.destroy(); });
      sock.on('close', () => resolve(text));
      sock.on('error', reject);
    });
    assert.match(reply, /^HTTP\/1\.1 413 /);
    assert.equal((await mcpPost(s.baseUrl, { auth: bearer(readKey.key), body: '{"jsonrpc":' })).status, 400);
    // Liveness: the same call under the cap is served.
    assert.equal((await mcpPost(s.baseUrl, { auth: bearer(readKey.key) })).status, 200);
  });
});

describe('protocol', () => {
  test('initialize works and advertises tools', async () => {
    const r = await mcpPost(s.baseUrl, { auth: bearer(readKey.key), method: 'initialize', params: initializeParams() });
    const result = rpcResult(r);
    assert.ok(result.serverInfo && typeof result.serverInfo.name === 'string');
    assert.ok(result.capabilities && result.capabilities.tools);
    assert.equal(typeof result.protocolVersion, 'string');
    assert.equal(result.instructions, instructions);
  });

  test('tools/list is filtered by scope with read-only annotations', async () => {
    const readTools = rpcResult(await mcpPost(s.baseUrl, { auth: bearer(readKey.key), method: 'tools/list' })).tools;
    const names = readTools.map(x => x.name);
    assert.ok(!names.includes('act_on_recommendation'));
    for (const n of ['household', 'recommendations', ...PACK_TOOLS]) assert.ok(names.includes(n), `read key lists ${n}`);
    for (const x of readTools) {
      assert.equal(typeof x.description, 'string');
      assert.equal(x.inputSchema.type, 'object');
      assert.deepEqual(x.annotations, { readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    }
    const writeTools = rpcResult(await mcpPost(s.baseUrl, { auth: bearer(writeKey.key), method: 'tools/list' })).tools;
    const w = writeTools.find(x => x.name === 'act_on_recommendation');
    assert.ok(w, 'write key lists the write tool');
    assert.deepEqual(w.annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: false });
    assert.equal(writeTools.length, readTools.length + 2);
  });

  test('a read tool call returns its result as JSON text', async () => {
    const result = rpcResult(await callToolRpc(s.baseUrl, readKey.key, 'household', { operation: 'summary' }));
    assert.ok(!result.isError);
    assert.equal(result.content[0].type, 'text');
    const body = JSON.parse(result.content[0].text);
    assert.ok(['clear', 'attention'].includes(body.verdictLevel) || typeof body.verdictLevel === 'string');
    assert.equal(typeof body.needsYouCount, 'number');
    seenResults.push(result.content[0].text);
  });

  test('the write tool with a read key is a permission error and writes nothing', async () => {
    const recs = JSON.parse(rpcResult(await callToolRpc(s.baseUrl, readKey.key, 'recommendations', { operation: 'list' })).content[0].text);
    const target = recs.find(r => r.status !== 'dismissed') || recs[0];
    const before = await withStore(s.dbFile, db => db.prepare("SELECT count(*) AS n FROM rec_events WHERE actor = 'tool'").get().n);
    const result = rpcResult(await callToolRpc(s.baseUrl, readKey.key, 'act_on_recommendation', { operation: 'status',  id: target.id, status: 'dismissed' }));
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, PERMISSION_TEXT);
    const after = await withStore(s.dbFile, db => ({
      n: db.prepare("SELECT count(*) AS n FROM rec_events WHERE actor = 'tool'").get().n,
      status: db.prepare('SELECT status FROM recs WHERE id = ?').get(target.id).status,
    }));
    assert.equal(after.n, before);
    assert.equal(after.status, target.status);
  });

  test('liveness: the write tool with a write key succeeds', async () => {
    const recs = JSON.parse(rpcResult(await callToolRpc(s.baseUrl, writeKey.key, 'recommendations', { operation: 'list' })).content[0].text);
    const target = recs.find(r => r.status !== 'doing') || recs[0];
    const result = rpcResult(await callToolRpc(s.baseUrl, writeKey.key, 'act_on_recommendation', { operation: 'status',  id: target.id, status: 'doing' }));
    assert.ok(!result.isError, result.content && result.content[0] && result.content[0].text);
    assert.equal(JSON.parse(result.content[0].text).status, 'doing');
    seenResults.push(result.content[0].text);
  });

  test('unknown tools and bad arguments are isError results', async () => {
    const unknown = rpcResult(await callToolRpc(s.baseUrl, readKey.key, 'no_such_tool'));
    assert.equal(unknown.isError, true);
    assert.equal(unknown.content[0].text, 'no tool no_such_tool');
    const bad = rpcResult(await callToolRpc(s.baseUrl, readKey.key, 'recommendations', { operation: 'detail', }));
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /id/);
    const missing = rpcResult(await callToolRpc(s.baseUrl, readKey.key, 'recommendations', { operation: 'detail',  id: 'no-such-rec' }));
    assert.equal(missing.isError, true);
  });

  test('last_used_at is set after an authenticated call', async () => {
    const k = await createKey(s.baseUrl, 'Usage tracked');
    seenKeys.push(k.key);
    assert.equal((await apiKeyRow(s.platformFile, k.record.id)).last_used_at, null);
    assert.equal((await listToolNames(s.baseUrl, k.key)).length > 0, true);
    const used = (await apiKeyRow(s.platformFile, k.record.id)).last_used_at;
    assert.ok(typeof used === 'string' && !Number.isNaN(Date.parse(used)), `last_used_at: ${used}`);
    const listed = (await request(s.baseUrl, { path: '/api/keys' })).json.keys.find(x => x.id === k.record.id);
    assert.equal(listed.lastUsedAt, used);
  });

  test('a refused request does not touch last_used_at', async () => {
    const row = await apiKeyRow(s.platformFile, revokedKey.record.id);
    assert.equal(row.last_used_at, null);
  });
});

describe('log hygiene', () => {
  test('server output holds no key and no tool result', async () => {
    const pack = rpcResult(await callToolRpc(s.baseUrl, readKey.key, 'knowledge', { operation: 'packs' }));
    seenResults.push(pack.content[0].text);
    await new Promise(r => setTimeout(r, 200));
    const out = s.output();
    for (const key of seenKeys) {
      assert.ok(!out.includes(key.slice(7)), 'a key body appears in the server output');
    }
    assert.ok(!/fathom_[A-Za-z0-9_-]{20,}/.test(out), 'something key shaped appears in the server output');
    for (const text of seenResults) {
      assert.ok(!out.includes(text), 'a tool result appears in the server output');
      assert.ok(!out.includes(text.slice(0, 60)), 'the start of a tool result appears in the server output');
    }
    for (const marker of ['needsYouCount', 'verdictLevel', 'Permission denied']) {
      assert.ok(!out.includes(marker), `server output mentions ${marker}`);
    }
  });
});

describe('FATHOM_CLOCK', () => {
  test('tools report the configured clock, as the UI does', T, async () => {
    const c = await spawnServer({ env: { FATHOM_ENGINE: 'fake', FATHOM_CLOCK: '2027-01-05' } });
    try {
      const k = await createKey(c.baseUrl, 'Clock agent');
      const summary = JSON.parse(rpcResult(await callToolRpc(c.baseUrl, k.key, 'household', { operation: 'summary' })).content[0].text);
      assert.equal(summary.clock, '2027-01-05');
    } finally {
      await c.stop();
    }
  });
});

test('operation scopes narrow listed enums and reject step before invalid arguments', async () => {
  const readTools = rpcResult(await mcpPost(s.baseUrl, { auth: bearer(readKey.key), method: 'tools/list' })).tools;
  assert.ok(!readTools.some(t => t.annotations.readOnlyHint === false));
  const mixed = rpcResult(await mcpPost(s.baseUrl, { auth: bearer(writeKey.key), method: 'tools/list' })).tools;
  const rec = mixed.find(t => t.name === 'act_on_recommendation');
  assert.deepEqual(rec.inputSchema.properties.operation.enum, ['owner', 'status']);
  const denied = rpcResult(await callToolRpc(s.baseUrl, writeKey.key, 'act_on_recommendation', { operation: 'step', index: 'invalid', extra: true }));
  assert.equal(denied.isError, true);
  assert.ok(denied.content[0].text.startsWith('Permission denied: act_on_recommendation.step needs the write:steps scope'));
});
