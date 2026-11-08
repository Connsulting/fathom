import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { createAuthStore } from '../src/auth/store.mjs';
import { createSessionFixture, serveAppFixture, tempInstance, request } from './helpers/server.mjs';
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
  t.after(async () => { await app.close(); await app.runtimes.close(); instance.close(); });
  const session = await createSessionFixture(instance.platform, { email: 'member@example.test', role: 'member' });
  const key = app.keys.create({ householdId: instance.householdId, userId: session.user.id, name: 'Synthetic agent', scopes: ['write:recs'] });
  instance.db.prepare("INSERT INTO recs (id, def, status, tasks_done, sort, updated_at) VALUES (?, ?, 'proposed', '[]', 0, ?)").run('synthetic-rec', JSON.stringify({ id: 'synthetic-rec', title: 'Synthetic recommendation', domain: 'data' }), new Date().toISOString());
  return { ...instance, app, session, key, store: createAuthStore(instance.platform) };
}

// Node sends 100 Continue and synchronously enters the real handler before yielding to this
// client. The handler has captured its household and is waiting for the withheld body.
function withhold(t, f, kind, payload) {
  const url = new URL(f.app.baseUrl);
  return new Promise((resolve, reject) => {
    const headers = { expect: '100-continue', 'content-length': Buffer.byteLength(payload), origin: url.origin };
    if (kind === 'mcp') Object.assign(headers, { authorization: `Bearer ${f.key.key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' });
    else Object.assign(headers, { cookie: f.session.cookie, 'content-type': kind === 'upload' ? `multipart/form-data; boundary=${boundary}` : 'application/json' });
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
const changes = f => f.db.prepare('SELECT total_changes() AS n').get().n;
const jobs = f => f.db.prepare('SELECT * FROM job_runs ORDER BY rowid').all();
function refuse(r, status) {
  assert.equal(r.status, status, r.text.slice(0, 300));
  assert.ok(Object.keys(r.json).every(k => ['error', 'code'].includes(k)), r.text);
  assert.equal(typeof r.json.error, 'string');
  assert.match(r.headers['cache-control'], /no-store/);
}
function mutate(f, reason) {
  if (reason === 'revocation') f.app.keys.revoke(f.key.record.id, { householdId: f.householdId });
  else if (reason === 'session revocation') f.store.revokeSession(f.session.token);
  else if (reason === 'membership removal') {
    f.platform.prepare("UPDATE household_memberships SET status = 'removed' WHERE user_id = ? AND household_id = ?").run(f.session.user.id, f.householdId);
  } else if (reason === 'suspension') f.platform.prepare("UPDATE households SET status = 'suspended' WHERE id = ?").run(f.householdId);

}

for (const reason of ['revocation', 'membership removal', 'suspension']) {
  for (const [operation, payload] of [['read', READ], ['write', WRITE]]) {
    test(`MCP refuses a delayed ${operation} after ${reason}`, { timeout: 20000 }, async t => {
      const f = await fixture(t);
      const pending = await withhold(t, f, 'mcp', payload);
      const before = changes(f);
      const used = f.platform.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(f.key.record.id).last_used_at;
      mutate(f, reason);
      const fresh = await request(f.app.baseUrl, { method: 'POST', path: '/mcp', headers: { authorization: `Bearer ${f.key.key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: payload });
      refuse(fresh, 401);
      const result = await pending.finish();
      refuse(result, 401);
      assert.equal(result.headers['www-authenticate'], 'Bearer');
      assert.equal(changes(f), before);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM preferences').get().n, 0);
      assert.equal(f.platform.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(f.key.record.id).last_used_at, used);
    });
  }
}

for (const kind of ['json', 'upload']) {
  for (const reason of ['session revocation', 'membership removal', 'suspension']) {
    test(`${kind} refuses a delayed body after ${reason} without side effects`, { timeout: 20000 }, async t => {
      const f = await fixture(t);
      const pending = await withhold(t, f, kind, kind === 'upload' ? UPLOAD : JSON.stringify({ text: TEXT }));
      const before = { changes: changes(f), vault: vaultFiles(f), jobs: jobs(f) };
      mutate(f, reason);
      const fresh = await request(f.app.baseUrl, { path: '/api/scenario', headers: { cookie: f.session.cookie } });
      const status = reason === 'session revocation' ? 401 : 403;
      refuse(fresh, status);
      refuse(await pending.finish(), status);
      assert.equal(changes(f), before.changes);
      assert.deepEqual(vaultFiles(f), before.vault);
      assert.deepEqual(jobs(f), before.jobs);
      for (const table of ['files', 'transactions', 'accounts', 'preferences']) assert.equal(f.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
    });
  }
}

for (const kind of ['mcp', 'json', 'upload']) {
  test(`${kind} accepts a valid delayed body`, { timeout: 20000 }, async t => {
    const f = await fixture(t);
    const pending = await withhold(t, f, kind, kind === 'upload' ? UPLOAD : kind === 'mcp' ? WRITE : JSON.stringify({ text: TEXT }));
    const r = await pending.finish();
    assert.equal(r.status, 200, r.text);
    if (kind === 'upload') {
      assert.equal(r.json.files[0].status, 'imported', r.text);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM transactions').get().n, 1);
      assert.equal(vaultFiles(f).length, 1);
    } else {
      if (kind === 'mcp') {
        assert.ok(!r.json.result.isError, r.text);
        assert.equal(f.db.prepare('SELECT status FROM recs').get().status, 'doing');
      } else assert.equal(f.db.prepare('SELECT text FROM preferences').get().text, TEXT);
    }
  });
}
