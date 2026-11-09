import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createAuthStore } from '../src/auth/store.mjs';
import { SERVER_TIMEOUT, createSessionFixture, serveAppFixture, tempInstance, request, contextHeaders } from './helpers/server.mjs';
import { aggregatorCsv } from './helpers/ingest.mjs';

const TEXT = 'Prefer a simple household plan.';
const rpc = (name, args) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const WRITE = rpc('act_on_recommendation', { operation: 'status', id: 'synthetic-rec', status: 'doing' });
const READ = rpc('household', { operation: 'summary' });
const boundary = 'synthetic-delayed-upload';
const UPLOAD = `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="synthetic.csv"\r\nContent-Type: text/csv\r\n\r\n${aggregatorCsv([{ date: '2032-03-09', amount: '12.50', description: 'SYNTHETIC SHOP' }])}\r\n--${boundary}--\r\n`;

async function fixture(t) {
  const instance = await tempInstance();
  const config = loadConfig({ FATHOM_DEMO: '0', FATHOM_ENGINE: 'off', FATHOM_PUBLIC_URL: 'http://localhost:8080' });
  const app = await serveAppFixture({ ...instance, config: { ...config, dataDir: instance.dataDir }, secrets: instance.secrets });
  t.after(async () => { await app.close(); await app.runtimes.close(); await instance.close(); });
  const session = await createSessionFixture(instance.platform, { email: 'member@example.test', role: 'member' });
  const key = app.keys.create({ householdId: instance.householdId, userId: session.user.id, name: 'Synthetic agent', scopes: ['write:recs'] });
  await instance.db.prepare("INSERT INTO recs (id, def, status, tasks_done, sort, updated_at) VALUES (?, ?, 'proposed', '[]', 0, ?)").run('synthetic-rec', JSON.stringify({ id: 'synthetic-rec', title: 'Synthetic recommendation', domain: 'data' }), new Date().toISOString());
  return { ...instance, app, session, key, store: createAuthStore(instance.platform) };
}

// Node sends 100 Continue and synchronously enters the real handler before yielding to this
// client. The handler has captured its household and is waiting for the withheld body.
function withhold(t, f, kind, payload) {
  const url = new URL(f.app.baseUrl);
  return new Promise((resolve, reject) => {
    const headers = { expect: '100-continue', 'content-length': Buffer.byteLength(payload), origin: url.origin };
    if (kind === 'mcp') Object.assign(headers, { authorization: `Bearer ${f.key.key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' });
    else Object.assign(headers, { cookie: f.session.cookie, ...contextHeaders(f.session), 'content-type': kind === 'upload' ? `multipart/form-data; boundary=${boundary}` : 'application/json' });
    const path = kind === 'mcp' ? '/mcp' : kind === 'upload' ? '/api/files' : '/api/preferences';
    let complete;
    const response = new Promise((yes, no) => { complete = { yes, no }; });
    response.catch(() => {});
    const req = http.request({ hostname: url.hostname, port: url.port, method: 'POST', path, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        complete.yes({ status: res.statusCode, headers: res.headers, text, json: JSON.parse(text) });
      });
    });
    t.after(() => req.destroy());
    req.on('error', err => { reject(err); complete.no(err); });
    req.on('continue', () => resolve({ finish: () => { req.end(payload); return response; } }));
    req.flushHeaders();
  });
}

function vaultFiles(f) {
  const dir = join(f.root, 'files');
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}
const changes = async f => (await f.db.prepare('SELECT total_changes() AS n').get()).n;
const jobs = async f => await f.db.prepare('SELECT * FROM job_runs ORDER BY rowid').all();
function refuse(r, status) {
  assert.equal(r.status, status, r.text.slice(0, 300));
  assert.ok(Object.keys(r.json).every(k => ['error', 'code'].includes(k)), r.text);
  assert.equal(typeof r.json.error, 'string');
  assert.match(r.headers['cache-control'], /no-store/);
}
async function mutate(f, reason) {
  if (reason === 'revocation') await f.app.keys.revoke(f.key.record.id, { householdId: f.householdId });
  else if (reason === 'session revocation') await f.store.revokeSession(f.session.token);
  else if (reason === 'membership removal') {
    await f.platform.prepare("UPDATE household_memberships SET status = 'removed' WHERE user_id = ? AND household_id = ?").run(f.session.user.id, f.householdId);
  } else if (reason === 'suspension') await f.platform.prepare("UPDATE households SET status = 'suspended' WHERE id = ?").run(f.householdId);
  else if (reason === 'membership version') await f.platform.prepare('UPDATE household_memberships SET version = version + 1 WHERE user_id = ? AND household_id = ?').run(f.session.user.id, f.householdId);
  else if (reason === 'restore generation') await f.platform.prepare('UPDATE households SET generation = generation + 1 WHERE id = ?').run(f.householdId);
  else if (reason === 'household change') {
    const at = Date.now();
    await f.platform.prepare("INSERT INTO households (id, status, mode, created_at, updated_at) VALUES ('synthetic-other-household', 'active', 'real', ?, ?)").run(at, at);
    await f.platform.prepare("INSERT INTO household_memberships (user_id, household_id, role, status, created_at, updated_at) VALUES (?, 'synthetic-other-household', 'member', 'active', ?, ?)").run(f.session.user.id, at, at);
    await f.platform.prepare("UPDATE auth_sessions SET household_id = 'synthetic-other-household' WHERE user_id = ?").run(f.session.user.id);
  }
}

for (const reason of ['revocation', 'membership removal', 'suspension', 'membership version', 'restore generation']) {
  for (const [operation, payload] of [['read', READ], ['write', WRITE]]) {
    test(`MCP refuses a delayed ${operation} after ${reason}`, { timeout: SERVER_TIMEOUT * 3 }, async t => {
      const f = await fixture(t);
      const pending = await withhold(t, f, 'mcp', payload);
      const before = await changes(f);
      const used = (await f.platform.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(f.key.record.id)).last_used_at;
      await mutate(f, reason);
      const fresh = await request(f.app.baseUrl, { method: 'POST', path: '/mcp', headers: { authorization: `Bearer ${f.key.key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: payload });
      refuse(fresh, 401);
      const result = await pending.finish();
      refuse(result, 401);
      assert.equal(result.headers['www-authenticate'], 'Bearer');
      assert.equal(await changes(f), before);
      assert.equal((await f.db.prepare('SELECT count(*) AS n FROM preferences').get()).n, 0);
      assert.equal((await f.platform.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(f.key.record.id)).last_used_at, used);
    });
  }
}

for (const kind of ['json', 'upload']) {
  for (const reason of ['session revocation', 'membership removal', 'suspension', 'household change']) {
    test(`${kind} refuses a delayed body after ${reason} without side effects`, { timeout: SERVER_TIMEOUT * 3 }, async t => {
      const f = await fixture(t);
      const pending = await withhold(t, f, kind, kind === 'upload' ? UPLOAD : JSON.stringify({ text: TEXT }));
      const before = { changes: await changes(f), vault: vaultFiles(f), jobs: await jobs(f) };
      await mutate(f, reason);
      const fresh = await request(f.app.baseUrl, { path: '/api/scenario', headers: { cookie: f.session.cookie, ...contextHeaders(f.session) } });
      if (reason === 'household change') {
        const session = await request(f.app.baseUrl, { path: '/api/auth/session', headers: { cookie: f.session.cookie } });
        assert.equal(session.status, 200);
        assert.equal(session.json.identity.householdId, 'synthetic-other-household');
        assert.equal(session.json.identity.role, 'member');
      }
      // A household change leaves the request's asserted context stale (MT-09): 409 before any effect.
      const status = reason === 'session revocation' ? 401 : reason === 'household change' ? 409 : 403;
      refuse(fresh, status);
      refuse(await pending.finish(), status);
      assert.equal(await changes(f), before.changes);
      assert.deepEqual(vaultFiles(f), before.vault);
      assert.deepEqual(await jobs(f), before.jobs);
      for (const table of ['files', 'transactions', 'accounts', 'preferences']) assert.equal((await f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()).n, 0, table);
    });
  }
}

for (const kind of ['mcp', 'json', 'upload']) {
  test(`${kind} accepts a valid delayed body`, { timeout: SERVER_TIMEOUT * 3 }, async t => {
    const f = await fixture(t);
    const pending = await withhold(t, f, kind, kind === 'upload' ? UPLOAD : kind === 'mcp' ? WRITE : JSON.stringify({ text: TEXT }));
    const r = await pending.finish();
    assert.equal(r.status, 200, r.text);
    if (kind === 'upload') {
      assert.equal(r.json.files[0].status, 'imported', r.text);
      assert.equal((await f.db.prepare('SELECT count(*) AS n FROM transactions').get()).n, 1);
      assert.equal(vaultFiles(f).length, 1);
    } else {
      if (kind === 'mcp') {
        assert.ok(!r.json.result.isError, r.text);
        assert.equal((await f.db.prepare('SELECT status FROM recs').get()).status, 'doing');
      } else assert.equal((await f.db.prepare('SELECT text FROM preferences').get()).text, TEXT);
    }
  });
}
