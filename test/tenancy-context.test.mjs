// MT-03 AC1: every financial API, scenario, answerer, tool, pack and packet caller receives one
// matching DB, root and runtime; concurrent equal-byte uploads in two synthetic households both
// import.
//
// One real in-process server (startServer) on an empty data directory gives household A. B is
// provisioned through the operator route after multi_household_enabled is seeded in this
// disposable platform DB, and becomes active when its admin consumes the first admin invitation
// (plan revision 8). Each household gets unique synthetic canaries (an upload whose account and
// file names carry the canary, an onboarding note, an Ask thread, a goal, a private Your plans
// entry with the same pack and entry id in both, an MCP key, a rec sent to review with its advisor
// packet, a pending Confirm item, a test email). A's responses must contain A's canary where it
// applies and never B's.
//
// Assumptions (the plan is silent):
// 1. No existing fake Ask script calls the pack entry tool (src/api/fake-answers.mjs scripts
//    household.summary, household.figures, recommendations.detail and the proposal tools), so the Ask tool
//    context is proven at the engine boundary: each household's runtime engine runs a scripted fake
//    round calling knowledge.entry with the tool context the answerer builds (db, now, the household
//    root), and through the packs entry route and MCP tools/call (cases 2 and 5).
// 2. B resumes only email and engine outbound work, so no background job writes to B's store
//    while case 2 compares B's logical digest before and after A's foreign-id requests.
// 3. A household context's `root` is the absolute path of households/<id> (compared by realpath).
// 4. The financial GET inventory is `routes` minus /healthz, /api/auth/*, /api/admin/*,
//    /api/operator/* and /api/identity (the caller's own membership metadata); a new GET route
//    fails case 2 until it is classified here.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, src, request } from './helpers/server.mjs';
import { aggregatorCsv } from './helpers/ingest.mjs';
import {
  CLOCK, PLAN_ENTRY, MEMBERSHIP_REQUIRED, sha256, twoHouseholds, writePlansPack, uploadFiles, getBytes, mcp, toolText, realpath,
  enrollSession, sessionHash,
} from './helpers/tenancy-runtime.mjs';

const T = { timeout: 300_000 };
const A_CANARY = 'ALPHAWREN';
const B_CANARY = 'BRAVOKITE';
const NOW = `${CLOCK}T09:00:00.000Z`;
const OPTIONS = JSON.stringify([{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }]);
const canaryCsv = (canary, number) => aggregatorCsv([
  { date: '2026-10-03', amount: '12.34', description: `${canary} grocer`, account: `${canary} checking`, number },
]);
const SHARED_CSV = aggregatorCsv([
  { date: '2026-10-05', amount: '19.99', description: 'Synthetic shared row', account: 'Synthetic shared checking', number: '5550009999' },
]);

let h;
const seeds = {};
let HV;

async function ok(promise, label) {
  const r = await promise;
  assert.equal(r.status, 200, `${label}: ${r.status} ${String(r.text).slice(0, 300)}`);
  return r.json;
}

// Gives household `side` its canaries through the HTTP routes (and the context DB for the rows no
// route creates directly: a rec to send to review and a pending Confirm question).
async function seed(side, canary, number) {
  const hh = h[side];
  const ctx = h.ctx(hh.id);
  const s = { canary };
  const up = await uploadFiles(h.baseUrl, hh.admin, [{ name: `${canary}-checking.csv`, bytes: Buffer.from(canaryCsv(canary, number)) }]);
  assert.equal(up.status, 200, up.text.slice(0, 300));
  assert.equal(up.json.files[0].status, 'imported');
  s.fileId = up.json.files[0].fileId;
  await ok(hh.client.postJson('/api/onboarding/notes', { text: `We keep a ${canary} reserve for the household.` }), `${side} note`);
  s.threadId = (await ok(hh.client.postJson('/api/threads', { text: `How is the ${canary} plan going?` }), `${side} thread`)).thread.id;
  s.goalId = (await ok(hh.client.postJson('/api/goals', { title: `${canary} cushion`, horizon: '1-3y' }), `${side} goal`)).goal.id;
  writePlansPack(h.rootOf(hh.id), canary);
  ctx.packs.refresh();
  const key = await ok(hh.client.postJson('/api/keys', { name: `${canary} agent`, scopes: ['read'] }), `${side} key`);
  s.key = key.key;
  s.keyId = key.record.id;
  s.recId = `syn-${canary.toLowerCase()}`;
  await ctx.db.prepare("INSERT INTO recs (id, def, status, tasks_done, sort, updated_at) VALUES (?, ?, 'proposed', '[]', 0, ?)")
    .run(s.recId, JSON.stringify({ id: s.recId, title: `${canary} review`, summary: `${canary} summary`, domain: 'data' }), NOW);
  await ok(hh.client.postJson('/api/advisor/reviews', { recId: s.recId }), `${side} review`);
  s.packetId = (await ok(hh.client.postJson('/api/advisor/packets', {}), `${side} packet`)).packetId;
  const factKey = `synthetic.${canary.toLowerCase()}`;
  s.confirmId = Number((await ctx.db.prepare(`INSERT INTO confirm_items (kind, subject, question, options, context, status, created_at)
    VALUES ('fact_check', ?, ?, ?, ?, 'pending', ?)`).run(factKey, `Is the ${canary} fact right?`, OPTIONS,
    JSON.stringify({ key: factKey, value: `${canary} value` }), NOW)).lastInsertRowid);
  s.accountId = (await ctx.db.prepare('SELECT id FROM accounts WHERE name LIKE ?').get(`%${canary}%`)).id;
  await ok(hh.client.postJson('/api/email/test', {}), `${side} test email`);
  seeds[side] = s;
}

before(async () => {
  HV = await src('src/platform/household-vault.mjs');
  h = await twoHouseholds();
  await ok(h.B.client.postJson('/api/household/outbound', { email: true, engine: true }), 'B resumes email and engine');
  await seed('A', A_CANARY, '4100000001');
  await seed('B', B_CANARY, '4200000002');
});

after(async () => { await h?.close(); });

const bIds = () => [B_CANARY, seeds.B.threadId, seeds.B.fileId, seeds.B.accountId, seeds.B.packetId, seeds.B.keyId, seeds.B.goalId, seeds.B.recId];

// ============================================================================================
// 1. Concurrent equal-byte uploads
// ============================================================================================

test('concurrent equal-byte uploads in two households both import, into separate roots and ciphertexts', T, async () => {
  const bytes = Buffer.from(SHARED_CSV);
  const id = 'f-' + sha256(bytes).slice(0, 24);
  const file = { name: 'synthetic-shared.csv', bytes };
  const [ra, rb] = await Promise.all([uploadFiles(h.baseUrl, h.A.admin, [file]), uploadFiles(h.baseUrl, h.B.admin, [file])]);
  for (const [label, r] of [['A', ra], ['B', rb]]) {
    assert.equal(r.status, 200, `${label}: ${r.text.slice(0, 300)}`);
    assert.equal(r.json.files.length, 1);
    assert.equal(r.json.files[0].status, 'imported', `${label}: imported, not a duplicate`);
    assert.equal(r.json.files[0].fileId, id);
  }
  for (const hh of [h.A, h.B]) {
    const list = await ok(hh.client.request({ path: '/api/files' }), 'files');
    const listed = list.files.find(f => f.id === id);
    assert.ok(listed, 'listed in its own household');
    assert.equal(listed.status, 'imported');
  }

  const blobA = readFileSync(join(h.rootOf(h.A.id), 'files', `${id}.bin`));
  const blobB = readFileSync(join(h.rootOf(h.B.id), 'files', `${id}.bin`));
  assert.ok(!blobA.equals(blobB), 'different ciphertext bytes');
  const handleA = await HV.unwrapDataKey(h.platform, { householdId: h.A.id, platformKey: h.keys.platformKey });
  const handleB = await HV.unwrapDataKey(h.platform, { householdId: h.B.id, platformKey: h.keys.platformKey });
  const rootA = await HV.householdRoot({ dataRoot: h.dataDir, householdId: h.A.id, relativeRoot: `households/${h.A.id}` });
  const rootB = await HV.householdRoot({ dataRoot: h.dataDir, householdId: h.B.id, relativeRoot: `households/${h.B.id}` });
  const storedPath = `files/${id}.bin`;
  assert.ok(Buffer.from(await HV.readObject({ root: rootA, handle: handleA, purpose: 'upload', objectId: id, storedPath })).equals(bytes));
  assert.ok(Buffer.from(await HV.readObject({ root: rootB, handle: handleB, purpose: 'upload', objectId: id, storedPath })).equals(bytes));
  const authFailed = err => err.code === 'vault_auth_failed';
  assert.throws(() => HV.openObject(handleA, { purpose: 'upload', objectId: id, blob: blobB }), authFailed, 'A cannot open B');
  assert.throws(() => HV.openObject(handleB, { purpose: 'upload', objectId: id, blob: blobA }), authFailed, 'B cannot open A');
  await assert.rejects(async () => HV.readObject({ root: rootB, handle: handleA, purpose: 'upload', objectId: id, storedPath }),
    err => err.code === 'vault_household_mismatch');
});

// ============================================================================================
// 2. Canary isolation over every financial GET route, and foreign ids
// ============================================================================================

describe('household A sees only its own data on every financial route', T, () => {
  const EXCLUDED = p => p === '/healthz' || p === '/api/identity' || /^\/api\/(auth|admin|operator)\//.test(p);
  // path template -> { path (A's concrete path), own (A's canary must appear), zip, status (expected, default 200) }
  const classify = A => ({
    '/api/scenario': { own: true },
    '/api/pace': {},
    '/api/packs/:id/entries/:entryId': { path: `/api/packs/your-plans/entries/${PLAN_ENTRY}`, own: true },
    '/api/threads': { own: true },
    '/api/threads/:id': { path: `/api/threads/${A.threadId}`, own: true },
    '/api/threads/:id/blocks': { path: `/api/threads/${A.threadId}/blocks` },
    '/api/accounts/:id': { path: `/api/accounts/${encodeURIComponent(A.accountId)}`, own: true },
    '/api/accounts/:id/transactions': { path: `/api/accounts/${encodeURIComponent(A.accountId)}/transactions`, own: true },
    '/api/accounts/:id/merge-candidates': { path: `/api/accounts/${encodeURIComponent(A.accountId)}/merge-candidates` },
    '/api/pnl': {},
    // These synthetic households hold no business entity, so the drill-down refuses with a fixed
    // 400 after the household gate; the body must still carry none of B's data.
    '/api/pnl/rows': { path: '/api/pnl/rows?section=expenses&category=Travel', status: 400 },
    '/api/spending': {},
    '/api/spending/rows': { path: '/api/spending/rows?bucket=household&category=Groceries' },
    '/api/goals/suggestions': {},
    '/api/keys': { own: true },
    '/api/mcp': {},
    '/api/files': { own: true },
    '/api/sources': { own: true },
    '/api/confirm': { own: true },
    '/api/confirm/:id': { path: `/api/confirm/${A.confirmId}`, own: true },
    '/api/email': {},
    '/api/email/subscriptions': {},
    '/api/jobs': {},
    '/api/advisor/packets/:id': { path: `/api/advisor/packets/${A.packetId}`, own: true },
    '/api/yearend/packet': { zip: true },
    '/api/household/outbound': {},
    '/api/household/backups/:id/status': { path: '/api/household/backups/synthetic-missing/status', status: 404 },
  });

  test('every GET route answers A with A\'s canary where it applies and none of B\'s data', async () => {
    const { routes } = await src('src/api/router.mjs');
    const { readZip } = await src('src/yearend/zip.mjs');
    const gets = routes.filter(r => r.method === 'GET' && !EXCLUDED(r.path)).map(r => r.path);
    const plan = classify(seeds.A);
    assert.deepEqual(gets.filter(p => !plan[p]), [], 'every financial GET route is classified');
    assert.ok(gets.includes('/api/household/outbound'), 'the outbound route is in the table');
    for (const template of gets) {
      const spec = plan[template];
      const path = spec.path ?? template;
      let text;
      if (spec.zip) {
        const r = await getBytes(h.baseUrl, path, h.A.client.headers);
        assert.equal(r.status, 200, `${path}: ${r.status}`);
        const entries = readZip(r.bytes);
        assert.ok(entries.length > 0, `${path}: a zip with entries`);
        text = entries.map(e => `${e.name}\n${e.data.toString('latin1')}`).join('\n');
      } else {
        const r = await h.A.client.request({ path });
        assert.equal(r.status, spec.status ?? 200, `${path}: ${r.status} ${r.text.slice(0, 200)}`);
        text = r.text;
      }
      for (const foreign of bIds()) assert.ok(!text.includes(foreign), `${path} leaks B (${foreign === B_CANARY ? 'canary' : 'an id'})`);
      if (spec.own) assert.ok(text.includes(A_CANARY), `${path} carries A's canary`);
    }
  });

  test('the colliding pack entry id and Confirm question resolve to A\'s own record', async () => {
    const entry = await ok(h.A.client.request({ path: `/api/packs/your-plans/entries/${PLAN_ENTRY}` }), 'entry');
    assert.equal(entry.entry.title, `${A_CANARY} plan`);
    assert.match(entry.entry.body, new RegExp(A_CANARY));
    const item = await ok(h.A.client.request({ path: `/api/confirm/${seeds.A.confirmId}` }), 'confirm');
    assert.equal(item.item.question, `Is the ${A_CANARY} fact right?`);
    const own = await ok(h.B.client.request({ path: `/api/packs/your-plans/entries/${PLAN_ENTRY}` }), 'B entry');
    assert.equal(own.entry.title, `${B_CANARY} plan`, 'B reads its own entry');
  });

  test('a foreign-only id behaves like a nonexistent one and leaves B unchanged', async () => {
    const { logicalDigest } = await src('src/platform/digest.mjs');
    const bDb = h.ctx(h.B.id).db;
    const before = await logicalDigest(bDb);
    const B = seeds.B;
    const pairs = [
      ['GET', `/api/threads/${B.threadId}`, '/api/threads/0123456789ab'],
      ['GET', `/api/threads/${B.threadId}/blocks`, '/api/threads/0123456789ab/blocks'],
      ['GET', `/api/accounts/${encodeURIComponent(B.accountId)}`, '/api/accounts/acct-synthetic-none'],
      ['GET', `/api/advisor/packets/${B.packetId}`, '/api/advisor/packets/advpkt-0000000000000000'],
      ['POST', `/api/files/${B.fileId}/retry`, '/api/files/f-000000000000000000000000/retry'],
      ['POST', `/api/goals/${B.goalId}/archive`, '/api/goals/g000000000000/archive'],
      ['POST', `/api/keys/${B.keyId}/revoke`, '/api/keys/key_000000000000/revoke'],
      ['POST', `/api/threads/${B.threadId}/rename`, '/api/threads/0123456789ab/rename'],
    ];
    for (const [method, foreign, none] of pairs) {
      const send = path => (method === 'GET' ? h.A.client.request({ path }) : h.A.client.postJson(path, { title: 'Synthetic rename' }));
      const [f, n] = [await send(foreign), await send(none)];
      assert.equal(n.status, 404, `${none}: nonexistent is 404`);
      assert.equal(f.status, 404, `${method} ${foreign}: foreign is 404 (${f.status})`);
      assert.equal(typeof f.json?.error, 'string');
      assert.ok(!f.text.includes(B_CANARY));
    }
    assert.equal(await logicalDigest(bDb), before, 'B\'s store is unchanged');
    const keys = await ok(h.B.client.request({ path: '/api/keys' }), 'B keys');
    assert.equal(keys.keys.find(k => k.id === B.keyId)?.revokedAt ?? null, null, 'B\'s key is still live');
  });
});

// ============================================================================================
// 3. Ask tool context
// ============================================================================================

test('a scripted tool round reads the private pack entry of its own household only, and spends in its own ledger', T, async () => {
  const { tools } = await src('src/tools/index.mjs');
  const spend = async db => (await db.prepare('SELECT count(*) AS n FROM spend_ledger').get()).n;
  for (const [hh, own, other] of [[h.A, A_CANARY, B_CANARY], [h.B, B_CANARY, A_CANARY]]) {
    const ctx = h.ctx(hh.id);
    const otherCtx = h.ctx(hh === h.A ? h.B.id : h.A.id);
    const [mine, theirs] = [await spend(ctx.db), await spend(otherCtx.db)];
    const res = await ctx.engine.call({
      purpose: 'chat', messages: [{ role: 'user', content: 'Synthetic question' }], tools: tools.filter(t => t.kind === 'read'),
      toolContext: { db: ctx.db, now: NOW, dataDir: ctx.root },
      fake: [{ toolCalls: [{ name: 'knowledge', args: { operation: 'entry', packId: 'your-plans', file: PLAN_ENTRY } }] }, { text: 'Synthetic answer.' }],
    });
    const results = JSON.stringify(res.toolResults);
    assert.equal(res.toolResults[0].isError ?? false, false, results.slice(0, 300));
    assert.ok(results.includes(own), 'own entry');
    assert.ok(!results.includes(other), 'never the other household\'s entry');
    assert.ok(await spend(ctx.db) > mine, 'spend recorded in its own ledger');
    assert.equal(await spend(otherCtx.db), theirs, 'the other ledger is untouched');
  }
});

// ============================================================================================
// 4. Packets
// ============================================================================================

test('packets carry only their own household\'s data', T, async () => {
  const a = await h.A.client.request({ path: `/api/advisor/packets/${seeds.A.packetId}` });
  assert.equal(a.status, 200);
  assert.ok(a.text.includes(`${A_CANARY} review`));
  assert.ok(!a.text.includes(B_CANARY));
  const b = await h.B.client.request({ path: `/api/advisor/packets/${seeds.B.packetId}` });
  assert.equal(b.status, 200);
  assert.ok(b.text.includes(`${B_CANARY} review`));
  assert.ok(!b.text.includes(A_CANARY));
  assert.equal((await h.A.client.request({ path: `/api/advisor/packets/${seeds.B.packetId}` })).status, 404);
  const { readZip } = await src('src/yearend/zip.mjs');
  for (const [hh, other] of [[h.A, B_CANARY], [h.B, A_CANARY]]) {
    const r = await getBytes(h.baseUrl, '/api/yearend/packet', hh.client.headers);
    assert.equal(r.status, 200);
    const text = readZip(r.bytes).map(e => `${e.name}\n${e.data.toString('latin1')}`).join('\n');
    assert.ok(!text.includes(other), 'the year-end packet holds no other household data');
  }
});

// ============================================================================================
// 5. MCP
// ============================================================================================

test('an MCP key answers for its own household only, whatever session cookie rides along', T, async () => {
  for (const [key, own, other, cookie] of [[seeds.A.key, A_CANARY, B_CANARY, h.B.admin.cookie], [seeds.B.key, B_CANARY, A_CANARY, h.A.admin.cookie]]) {
    const extra = { cookie };
    const list = await mcp(h.baseUrl, key, 'tools/list', {}, extra);
    assert.equal(list.status, 200, list.text.slice(0, 200));
    const names = list.json.result.tools.map(t => t.name);
    for (const n of ['household', 'accounts', 'knowledge']) assert.ok(names.includes(n), n);
    const accounts = await mcp(h.baseUrl, key, 'tools/call', { name: 'accounts', arguments: { operation: 'list' } }, extra);
    assert.equal(accounts.status, 200);
    assert.ok(toolText(accounts).includes(own), 'own accounts');
    assert.ok(!toolText(accounts).includes(other), 'no foreign accounts');
    const entry = await mcp(h.baseUrl, key, 'tools/call', { name: 'knowledge', arguments: { operation: 'entry', packId: 'your-plans', file: PLAN_ENTRY } }, extra);
    assert.equal(entry.status, 200);
    assert.ok(toolText(entry).includes(own), 'own private entry');
    assert.ok(!toolText(entry).includes(other), 'never the foreign entry');
    const summary = await mcp(h.baseUrl, key, 'tools/call', { name: 'household', arguments: { operation: 'summary' } }, extra);
    assert.equal(summary.status, 200);
    assert.ok(!toolText(summary).includes(other));
  }
  const cookieOnly = await mcp(h.baseUrl, null, 'tools/list', {}, { cookie: h.A.admin.cookie });
  assert.equal(cookieOnly.status, 401, 'a browser session alone never authenticates /mcp');
});

// ============================================================================================
// 6. No default household
// ============================================================================================

describe('there is no default household', T, () => {
  const financial = () => [
    '/api/scenario', '/api/files', '/api/threads', '/api/keys', '/api/jobs', '/api/email', '/api/confirm', '/api/household/outbound',
    `/api/packs/your-plans/entries/${PLAN_ENTRY}`,
  ];

  test('anonymous financial requests are 401', async () => {
    for (const path of financial()) assert.equal((await request(h.baseUrl, { path })).status, 401, path);
    const post = await request(h.baseUrl, { method: 'POST', path: '/api/goals', headers: { 'content-type': 'application/json', origin: h.baseUrl }, body: '{"title":"x"}' });
    assert.equal(post.status, 401);
  });

  test('a member of two households with no session household gets 403 membership required', async () => {
    const identity = await ok(h.dual.client.request({ path: '/api/identity' }), 'identity');
    assert.equal(identity.identity.householdId, null);
    assert.equal(identity.identity.memberships.length, 2);
    for (const path of financial()) {
      const r = await h.dual.client.request({ path });
      assert.equal(r.status, 403, path);
      assert.deepEqual(r.json, MEMBERSHIP_REQUIRED, path);
    }
    const post = await h.dual.client.postJson('/api/goals', { title: 'Synthetic unscoped goal' });
    assert.equal(post.status, 403);
    assert.deepEqual(post.json, MEMBERSHIP_REQUIRED);
    const up = await uploadFiles(h.baseUrl, h.dual, [{ name: 'synthetic.csv', bytes: Buffer.from(SHARED_CSV) }]);
    assert.equal(up.status, 403);
  });

  test('a provisioning household with no root is never served', async () => {
    const id = 'hh-synthetic-provisioning';
    const at = Date.now();
    await h.platform.prepare(`INSERT INTO households (id, status, mode, display_name, serves_store, created_at, updated_at)
      VALUES (?, 'provisioning', 'real', 'Synthetic provisioning', 0, ?, ?)`).run(id, at, at);
    const member = await enrollSession(h.platform, id, 'provisioning-member@example.test', 'member');
    await h.platform.prepare('UPDATE auth_sessions SET household_id = ? WHERE hash = ?').run(id, sessionHash(member.token));
    const headers = { cookie: member.cookie };
    for (const path of financial()) {
      const r = await request(h.baseUrl, { path, headers });
      assert.equal(r.status, 403, path);
      assert.deepEqual(r.json, MEMBERSHIP_REQUIRED);
    }
    assert.equal(h.app.runtimes.get(id), null);
    assert.ok(!existsSync(join(h.dataDir, 'households', id)), 'no root was created for it');
  });
});

// ============================================================================================
// 7. Context invariants
// ============================================================================================

test('each household context is frozen and holds its own DB, root, vault and runtime objects', T, async () => {
  const { storeIdentity } = await src('src/platform/db.mjs');
  for (const id of [h.A.id, h.B.id]) {
    const row = await h.platform.prepare('SELECT status, storage_root FROM households WHERE id = ?').get(id);
    assert.deepEqual({ ...row }, { status: 'active', storage_root: `households/${id}` }, 'B activated on its first admin enrollment');
  }
  const a = h.app.runtimes.get(h.A.id);
  const b = h.app.runtimes.get(h.B.id);
  for (const [ctx, id, canary] of [[a, h.A.id, A_CANARY], [b, h.B.id, B_CANARY]]) {
    assert.ok(ctx, `a context for ${id}`);
    assert.ok(Object.isFrozen(ctx), 'frozen');
    assert.equal(ctx.householdId, id);
    assert.ok(Number.isInteger(ctx.generation) && ctx.generation >= 1);
    assert.equal((await storeIdentity(ctx.db)).householdId, id, 'store_identity names the household');
    assert.ok(ctx.root.endsWith(join('households', id)), 'root is households/<id>');
    assert.equal(realpath(ctx.root), realpath(join(h.dataDir, 'households', id)));
    const vault = await ctx.vault();
    assert.equal(vault.handle.householdId, id, 'vault handle');
    assert.equal(vault.root.householdId, id, 'vault root');
    assert.ok(ctx.inFlight instanceof Set);
    assert.equal(ctx.packs.entry('your-plans', PLAN_ENTRY).title, `${canary} plan`, 'packs read its own root');
    assert.equal(h.app.runtimes.get(id), ctx, 'the same generation resolves to the same context');
  }
  assert.notEqual(a.inFlight, b.inFlight);
  for (const k of ['db', 'engine', 'packs', 'answerer', 'scheduler', 'transport', 'outbound']) {
    assert.ok(a[k] && b[k], `${k} present`);
    assert.notEqual(a[k], b[k], `${k} is not shared`);
  }
});

// ============================================================================================
// 8. Source guard
// ============================================================================================

test('server and router hold no process-global financial db or data directory', T, async () => {
  const router = readFileSync(join(ROOT, 'src/api/router.mjs'), 'utf8');
  assert.ok(!/config\.dataDir/.test(router), 'router.mjs never reads config.dataDir');
  const { createHandler } = await src('src/api/router.mjs');
  const m = /^(?:async\s+)?function\s+createHandler\s*\(\s*\{([^)]*)\}\s*\)/.exec(createHandler.toString());
  assert.ok(m, 'createHandler takes one destructured options object');
  const params = m[1].split(',').map(s => s.trim().split(/[\s=:]/)[0]).filter(Boolean);
  assert.ok(params.includes('runtimes'), 'createHandler takes the runtime registry');
  for (const p of ['db', 'engine', 'packs', 'answerer', 'scheduler']) assert.ok(!params.includes(p), `createHandler takes no ${p}`);
  const server = readFileSync(join(ROOT, 'src/server.mjs'), 'utf8');
  assert.ok(!/createLivePacks\(\s*db\b/.test(server), 'no process-wide live packs');
  assert.ok(!/createRuntimeEngine\(\s*\{\s*db\b/.test(server), 'no process-wide engine');
  assert.ok(!/createHandler\(\s*\{[^}]*\bdb\b/.test(server), 'the handler gets no db');
  assert.ok(!('db' in h.app), 'startServer returns no db');
});
