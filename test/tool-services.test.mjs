import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempInstance, tempDir, serveAppFixture, createSessionFixture } from './helpers/server.mjs';
import { getTool, CAPABILITIES } from '../src/tools/index.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { loadConfig } from '../src/config.mjs';
import { startServer } from '../src/server.mjs';
import { rpcResult, callToolRpc } from '../src/mcp/test/helpers.mjs';
import { registerReceiptKind, saveReceipt } from '../src/actions/receipts.mjs';

test('confirmed Ask proposals keep household services and owner statements', async t => {
  const s = await tempInstance();
  let receiptId, confirmedContext;
  const transport = createEngine({ mode: 'fake' });
  const engine = { mode: 'live', isOn: () => true, call(request) {
    if (request.purpose === 'title') return Promise.resolve({ text: JSON.stringify({ title: 'Synthetic undo' }), toolResults: [] });
    return transport.call({ ...request, fake: [
      { toolCalls: [{ name: 'undo', args: { operation: 'undo', id: receiptId, propose: true } }] },
      { text: 'Undo your change? Confirm below.' },
    ] });
  } };
  registerReceiptKind('c2_services_confirmation', { async restore(ctx) {
    confirmedContext = ctx;
    assert.ok(ctx.services);
    await ctx.db.prepare("UPDATE settings SET value = '1' WHERE key = 'confirmation-setting'").run();
  } });
  const config = loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'off' });
  const app = await serveAppFixture({ db: s.db, platform: s.platform, config, secrets: s.secrets, engine, authenticated: true });
  t.after(async () => { await app.close(); s.close(); rmSync(s.dataDir, { recursive: true, force: true }); });
  await s.db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('confirmation-setting', '2', '2026-11-07');
  receiptId = (await saveReceipt({ db: s.db, actorId: app.session.user.id }, { scope: 'write:decisions', kind: 'c2_services_confirmation',
    id: 'confirmation-setting', label: 'Synthetic choice', before: '1', after: '2' })).id;
  const proposed = await app.postJson('/api/threads', { text: 'Undo my change.' });
  assert.equal(proposed.status, 200);
  assert.deepEqual(proposed.json.message.provenance.pendingAction.scopes, ['write:decisions']);
  const confirmed = await app.postJson('/api/ask', { key: proposed.json.thread.key, text: 'yes' });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmedContext.services, app.household.services);
  assert.equal(confirmedContext.household, app.household);
  assert.equal(confirmedContext.dataDir, s.root);
  assert.ok(confirmedContext.ownerStatements().includes('Undo my change.'));
  assert.ok(confirmedContext.ownerStatements().includes('yes'));
  assert.equal((await s.db.prepare("SELECT value FROM settings WHERE key = 'confirmation-setting'").get()).value, '1');
});

test('answerers require household services', () => {
  assert.throws(() => createLiveAnswerer({ engine: { call() {} }, root: 'synthetic-root' }), /household services/);
});

test('public demo builds its decorated answerer with its sandbox services', async t => {
  const dir = await tempDir();
  const origin = 'http://localhost:5031';
  const config = { ...loadConfig({ FATHOM_PUBLIC_DEMO: '1', FATHOM_DEMO: '1', FATHOM_DATA: dir,
    FATHOM_PUBLIC_DEMO_DATA: dir, FATHOM_PUBLIC_URL: origin, FATHOM_ENGINE: 'fake', FATHOM_FAKE_STREAM_MS: '0' }), port: 0 };
  const contexts = [];
  const op = getTool('household').operations.find(o => o.name === 'summary');
  const original = op.handler;
  op.handler = (args, ctx) => { contexts.push(ctx); return original(args, ctx); };
  t.after(() => { op.handler = original; });
  const server = await startServer(config);
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const response = await fetch(server.url + '/api/threads', { method: 'POST',
    headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ text: 'What do you know about this household?' }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(!body.message.notice);
  assert.ok(contexts.length > 0);
  for (const ctx of contexts) {
    assert.ok(ctx.services);
    assert.equal(ctx.services.config.dataDir, ctx.dataDir);
    assert.equal(ctx.services.household, ctx.household);
    assert.equal(ctx.household.db, ctx.db);
    assert.equal(ctx.services.engine, ctx.household.engine);
  }
});

test('Ask and MCP share the resolved household services and root, with actor-bound statements', async t => {
  const s = await tempInstance();
  t.after(() => { s.close(); rmSync(s.dataDir, { recursive: true, force: true }); });
  const seen = [];
  const probe = getTool('transactions').operations.find(o => o.name === 'search');
  const original = probe.handler;
  probe.handler = (_args, ctx) => {
    seen.push(ctx);
    return { status: 'observed', statements: ctx.ownerStatements?.() ?? null };
  };
  t.after(() => { probe.handler = original; });
  const fake = createEngine({ mode: 'fake' });
  const engine = { mode: 'live', isOn: () => true, call: request => fake.call({ ...request, fake: [
    { toolCalls: [{ name: 'transactions', args: { operation: 'search' } }] }, { text: 'Your request is recorded.' },
  ] }) };
  const scheduler = { runNow: () => ({ status: 'ok' }), stop() {} };
  const config = loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'off', FATHOM_CLOCK: '2026-11-07' });
  const app = await serveAppFixture({ db: s.db, platform: s.platform, config, secrets: s.secrets, engine, scheduler });
  t.after(() => app.close());
  const creator = await createSessionFixture(s.platform, { email: 'services@example.test', role: 'member' });
  const { key } = app.keys.create({ householdId: s.householdId, userId: creator.user.id, name: 'Synthetic services' });
  const mcp = rpcResult(await callToolRpc(app.baseUrl, key, 'transactions', { operation: 'search' }));
  assert.ok(!mcp.isError, mcp.content[0].text);
  assert.equal(JSON.parse(mcp.content[0].text).statements, null, 'MCP uses its explicit evidence, never a conversation');
  const thread = 'ask:123456abcdef', other = 'ask:abcdef123456', now = '2026-11-07T12:00:00.000Z';
  for (const id of [thread, other]) await s.db.prepare('INSERT INTO conversations (key, created_at) VALUES (?, ?)').run(id, now);
  const insert = async (conversation, role, text, actor) => await s.db.prepare('INSERT INTO messages (conversation_key, role, text, ts, provenance) VALUES (?, ?, ?, ?, ?)')
    .run(conversation, role, text, now, JSON.stringify({ ownerInput: { actorId: actor } }));
  await insert(thread, 'me', 'Use 4 percent.', 'person-a');
  await insert(thread, 'me', 'Use 8 percent.', 'person-b');
  await insert(thread, 'fathom', 'Use 9 percent.', 'person-a');
  await insert(other, 'me', 'Use 7 percent.', 'person-a');
  await app.household.answerer.answer({ db: s.db, key: thread, text: 'Keep that assumption.', actorId: 'person-a', ownerText: 'Keep that assumption.' });
  assert.equal(seen.length, 2);
  const [mcpCtx, askCtx] = seen;
  assert.ok(mcpCtx.services);
  assert.equal(mcpCtx.services, askCtx.services);
  assert.equal(askCtx.services.scheduler, scheduler);
  assert.equal(askCtx.services.engine, engine);
  assert.equal(askCtx.services.config.dataDir, s.root);
  assert.equal(askCtx.services.config.clock, '2026-11-07');
  assert.equal(askCtx.dataDir, s.root); assert.equal(mcpCtx.dataDir, s.root);
  assert.equal(askCtx.household, app.household); assert.equal(mcpCtx.household, app.household);
  assert.equal(askCtx.services.vault, app.household.vault);
  assert.deepEqual(askCtx.ownerStatements(), ['Keep that assumption.', 'Use 4 percent.']);
  assert.ok(CAPABILITIES.includes('ownerStatements'));
  const second = await tempInstance(); t.after(() => { second.close(); rmSync(second.dataDir, { recursive: true, force: true }); });
  const otherHousehold = await second.household(null, { engine, scheduler });
  assert.notEqual(otherHousehold.services, app.household.services);
  assert.equal(otherHousehold.services.config.dataDir, second.root);
});
