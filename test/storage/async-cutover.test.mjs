// PG-2 cutover at the real boundaries: an authorization or admission result that arrives late and
// refuses, and a transaction that rejects after its first write, through the HTTP server and a CLI.
// Neither leaks a response body beyond the refusal nor commits a row.
// Run directly: node test/storage/async-cutover.test.mjs

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { twoHouseholds, serverEnv } from '../helpers/tenancy-runtime.mjs';
import { runCommand } from '../helpers/server.mjs';

let h;
before(async () => { h = await twoHouseholds(); });
after(async () => { await h?.close(); });

// POST json whose body arrives in two parts; between them `meanwhile()` runs, after the router has
// passed its first authorization check and while it waits for the body.
function slowPost(path, headers, json, meanwhile) {
  const body = Buffer.from(JSON.stringify(json));
  return new Promise((resolve, reject) => {
    const req = http.request(new URL(path, h.baseUrl), {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'content-length': body.length },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(body.subarray(0, 1));
    delay(150).then(meanwhile).then(() => req.end(body.subarray(1)), reject);
  });
}

const goals = async id => (await (await h.ctx(id)).db.prepare("SELECT count(*) AS n FROM goals WHERE def LIKE '%Synthetic cutover%'").get()).n;

test('a session revoked while the body is read is refused after the body: 401, nothing written', async () => {
  const before = await goals(h.A.id);
  const r = await slowPost('/api/goals', h.B.client.headers, { title: 'Synthetic cutover goal', horizon: '1-3y' }, async () => {
    await h.store.revokeSession(h.B.admin.token);
  });
  assert.equal(r.status, 401, r.text);
  assert.deepEqual(JSON.parse(r.text), { error: 'unauthorized' });
  assert.equal(await goals(h.B.id), 0);
  assert.equal(await goals(h.A.id), before);
});

test('a membership removed while the body is read refuses the write before the handler runs', async () => {
  const member = await h.store.membership(h.dual.user.id, h.A.id);
  assert.ok(member, 'fixture: the dual member belongs to A');
  const headers = { ...h.A.client.headers };
  const r = await slowPost('/api/goals', headers, { title: 'Synthetic cutover goal two', horizon: '1-3y' }, async () => {
    await h.platform.prepare("UPDATE household_memberships SET status = 'removed', version = version + 1 WHERE household_id = ? AND user_id = ?")
      .run(h.A.id, h.A.admin.user.id);
  });
  assert.ok([401, 403].includes(r.status), `${r.status} ${r.text}`);
  assert.ok(!/Synthetic cutover/.test(r.text), 'the refusal carries no household data');
  assert.equal(await goals(h.A.id), 0);
  await h.platform.prepare("UPDATE household_memberships SET status = 'active', version = version + 1 WHERE household_id = ? AND user_id = ?")
    .run(h.A.id, h.A.admin.user.id);
});

test('engine admission withdrawn while the body is read: the answer is the off notice and no model round runs', async () => {
  const B = h.A;
  const resumed = await B.client.postJson('/api/household/outbound', { email: true, engine: true });
  assert.equal(resumed.status, 200, resumed.text);
  const ctx = await h.ctx(B.id);
  const spend = async () => (await ctx.db.prepare('SELECT count(*) AS n FROM spend_ledger').get()).n;
  const before = await spend();
  const r = await slowPost('/api/threads', B.client.headers, { text: 'Synthetic cutover question' }, async () => {
    await h.platform.prepare("UPDATE household_outbound SET engine = 0 WHERE household_id = ?").run(B.id);
  });
  assert.equal(r.status, 200, r.text);
  const message = JSON.parse(r.text).message;
  assert.equal(message.notice, true, 'a refused admission answers with a notice');
  assert.match(message.text, /off|paused/i);
  assert.equal(await spend(), before, 'no round was recorded');
  // A direct engine round with a budget is refused the same way while admission is withdrawn.
  await assert.rejects(ctx.engine.call({ purpose: 'chat', messages: [{ role: 'user', content: 'Synthetic' }], budget: { maxCostUsd: 0.5 } }),
    err => err?.name === 'EngineOffError');
  assert.equal(await spend(), before);
});

test('a transaction that rejects after its first write rolls back through HTTP and leaks nothing', async () => {
  const A = h.A;
  const ctx = await h.ctx(A.id);
  const OPTIONS = JSON.stringify([{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }]);
  const item = async n => (await ctx.db.prepare(`INSERT INTO confirm_items (kind, subject, question, options, context, status, created_at)
    VALUES ('fact_check', ?, ?, ?, ?, 'pending', '2026-11-05T00:00:00Z') RETURNING id`)
    .get(`synthetic.cutover${n}`, `Is synthetic cutover fact ${n} right?`, OPTIONS, JSON.stringify({ key: `synthetic.cutover${n}`, value: 'Synthetic' }))).id;
  const first = await item(1), second = await item(2);
  const status = async id => (await ctx.db.prepare('SELECT status FROM confirm_items WHERE id = ?').get(id)).status;
  // Trusted test DDL: the batch's second answer aborts after the first one was written.
  await ctx.db.applySchema(`CREATE TRIGGER pg2_probe BEFORE UPDATE OF status ON confirm_items WHEN NEW.id = ${Number(second)}
    BEGIN SELECT RAISE(ABORT, 'synthetic probe'); END`);
  try {
    const r = await A.client.postJson('/api/confirm/answers', { answers: [{ id: first, answer: 'yes' }, { id: second, answer: 'yes' }] });
    assert.equal(r.status, 500, r.text);
    assert.deepEqual(JSON.parse(r.text), { error: 'internal error' });
    assert.equal(await status(first), 'pending', 'the first answer, written before the rejection, was rolled back');
    assert.equal(await status(second), 'pending');
  } finally {
    await ctx.db.applySchema('DROP TRIGGER pg2_probe');
  }
  const ok = await A.client.postJson('/api/confirm/answers', { answers: [{ id: first, answer: 'yes' }, { id: second, answer: 'yes' }] });
  assert.equal(ok.status, 200, ok.text);
  assert.notEqual(await status(first), 'pending');
});

test('a CLI whose transaction refuses commits nothing', async () => {
  const port = new URL(h.baseUrl).port;
  const env = serverEnv({ dataDir: h.dataDir, port, keys: h.keys });
  const invites = async () => (await h.platform.prepare("SELECT count(*) AS n FROM household_invitations WHERE email = 'cutover-admin@example.test'").get()).n;
  const r = await runCommand(process.execPath, ['scripts/user-invite.mjs', 'cutover-admin@example.test', '--admin'], { env, timeoutMs: 30000 });
  assert.notEqual(r.code, 0, 'an enrolled admin already exists, so the invite is refused');
  assert.equal(await invites(), 0);
});
