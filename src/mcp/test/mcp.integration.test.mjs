// AC1/AC5: the MCP SDK client over Streamable HTTP against the real server on the demo store,
// using the URL the app advertises at GET /api/mcp and keys made through POST /api/keys.

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ROOT, SERVER_TIMEOUT, spawnServer, request } from '../../../test/helpers/server.mjs';
import { PERMISSION_TEXT, createKey, revokeKey, withStore } from './helpers.mjs';

const T = { timeout: SERVER_TIMEOUT };
const PACK_TOOLS = ['list_packs', 'get_pack_entry', 'search_pack_entries'];

// The first pack (by id) under packs/ and its first manifest entry, read from disk.
function firstPackEntry() {
  const dir = join(ROOT, 'packs');
  const ids = readdirSync(dir, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(join(dir, d.name, 'manifest.json')))
    .map(d => d.name).sort();
  const manifest = JSON.parse(readFileSync(join(dir, ids[0], 'manifest.json'), 'utf8'));
  const entry = manifest.entries[0];
  return { manifest, entry, markdown: readFileSync(join(dir, ids[0], entry.file), 'utf8') };
}

let s;
let mcpUrl;
const open = [];

async function connect(key) {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  const client = new Client({ name: 'fathom-integration-test', version: '1.0.0' });
  await client.connect(transport);
  open.push(client);
  return client;
}

const textOf = result => result.content.find(c => c.type === 'text').text;

before(async () => {
  s = await spawnServer({ env: { FATHOM_ENGINE: 'fake' } });
  const info = await request(s.baseUrl, { path: '/api/mcp' });
  assert.equal(info.status, 200, info.text.slice(0, 200));
  mcpUrl = info.json.url;
}, T);

after(async () => {
  for (const c of open) { try { await c.close(); } catch { /* already closed */ } }
  if (s) await s.stop();
});

describe('read key', () => {
  let key;
  let client;
  before(async () => {
    key = (await createKey(s.baseUrl, 'SDK read agent')).key;
    client = await connect(key);
  }, T);

  test('the advertised url is this server', () => {
    assert.equal(mcpUrl, `${s.baseUrl}/mcp`);
  });

  test('lists read tools, including the pack tools, and not the write tool', async () => {
    const { tools } = await client.listTools();
    const names = tools.map(x => x.name);
    assert.ok(!names.includes('set_recommendation_status'));
    for (const n of ['household_summary', ...PACK_TOOLS]) assert.ok(names.includes(n), `lists ${n}`);
    for (const x of tools) assert.equal(x.annotations && x.annotations.readOnlyHint, true, `${x.name} is read-only`);
  });

  test('household_summary returns the household overview', async () => {
    const r = await client.callTool({ name: 'household_summary', arguments: {} });
    assert.ok(!r.isError, textOf(r));
    const body = JSON.parse(textOf(r));
    assert.equal(typeof body.facts, 'object');
    assert.equal(typeof body.needsYouCount, 'number');
    assert.equal(typeof body.clock, 'string');
  });

  test('get_pack_entry returns a real entry with its citations', async () => {
    const { manifest, entry, markdown } = firstPackEntry();
    const r = await client.callTool({ name: 'get_pack_entry', arguments: { packId: manifest.id, file: entry.file } });
    assert.ok(!r.isError, textOf(r));
    const body = JSON.parse(textOf(r));
    assert.equal(body.packId, manifest.id);
    assert.equal(body.packName, manifest.name);
    assert.equal(body.file, entry.file);
    assert.equal(body.title, entry.title);
    assert.equal(body.markdown, markdown);
    assert.deepEqual(body.citations.map(c => c.url).sort(), entry.cites.map(c => c.url).sort());
    assert.deepEqual(body.citations.map(c => c.label).sort(), entry.cites.map(c => c.label).sort());
  });

  test('list_packs and search_pack_entries answer', async () => {
    const packs = JSON.parse(textOf(await client.callTool({ name: 'list_packs', arguments: {} })));
    assert.ok(Array.isArray(packs) && packs.length > 0);
    const search = await client.callTool({ name: 'search_pack_entries', arguments: { query: 'tax' } });
    assert.ok(!search.isError, textOf(search));
    assert.ok(Array.isArray(JSON.parse(textOf(search)).results));
  });

  test('the write tool is refused with a permission error', async () => {
    const recs = JSON.parse(textOf(await client.callTool({ name: 'list_recommendations', arguments: {} })));
    const r = await client.callTool({ name: 'set_recommendation_status', arguments: { id: recs[0].id, status: 'doing' } });
    assert.equal(r.isError, true);
    assert.equal(textOf(r), PERMISSION_TEXT);
  });
});

describe('write key', () => {
  test('lists the write tool and set_recommendation_status writes a tool rec event', T, async () => {
    const key = (await createKey(s.baseUrl, 'SDK write agent', ['write:recs'])).key;
    const client = await connect(key);
    const names = (await client.listTools()).tools.map(x => x.name);
    assert.ok(names.includes('set_recommendation_status'));
    for (const n of PACK_TOOLS) assert.ok(names.includes(n));

    const recs = JSON.parse(textOf(await client.callTool({ name: 'list_recommendations', arguments: {} })));
    const target = recs.find(r => r.status !== 'doing');
    assert.ok(target, 'a rec to move');
    const before = await withStore(s.dbFile, db => db.prepare("SELECT count(*) AS n FROM rec_events WHERE actor LIKE 'key:%' AND rec_id = ?").get(target.id).n);
    const r = await client.callTool({ name: 'set_recommendation_status', arguments: { id: target.id, status: 'doing' } });
    assert.ok(!r.isError, textOf(r));
    assert.equal(JSON.parse(textOf(r)).status, 'doing');
    const events = await withStore(s.dbFile, db => db.prepare(
      "SELECT * FROM rec_events WHERE actor LIKE 'key:%' AND rec_id = ? ORDER BY id").all(target.id).map(e => ({ ...e })));
    assert.equal(events.length, before + 1);
    const last = events[events.length - 1];
    assert.equal(last.to_status, 'doing');
    assert.equal(last.from_status, target.status);
    const status = await withStore(s.dbFile, db => db.prepare('SELECT status FROM recs WHERE id = ?').get(target.id).status);
    assert.equal(status, 'doing');
  });
});

describe('revocation', () => {
  test('after revoke the next connection fails with 401', T, async () => {
    const { key, record } = await createKey(s.baseUrl, 'SDK short lived');
    const first = await connect(key);
    assert.ok((await first.listTools()).tools.length > 0, 'works before revoke');
    await first.close();
    await revokeKey(s.baseUrl, record.id);
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
      requestInit: { headers: { Authorization: `Bearer ${key}` } },
    });
    const client = new Client({ name: 'fathom-integration-test', version: '1.0.0' });
    await assert.rejects(client.connect(transport), err => {
      assert.ok(err.code === 401 || /401|unauthori[sz]ed/i.test(String(err.message)), String(err && err.message));
      return true;
    });
    try { await client.close(); } catch { /* not connected */ }
  });
});
