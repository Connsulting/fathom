import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tempInstance, serveAppFixture } from './helpers/server.mjs';
import { getTool, CAPABILITIES } from '../src/tools/index.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { loadConfig } from '../src/config.mjs';
import { rpcResult, callToolRpc } from '../src/mcp/test/helpers.mjs';

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
  const { key } = app.keys.create({ householdId: s.householdId, name: 'Synthetic services' });
  const mcp = rpcResult(await callToolRpc(app.baseUrl, key, 'transactions', { operation: 'search' }));
  assert.ok(!mcp.isError, mcp.content[0].text);
  assert.equal(JSON.parse(mcp.content[0].text).statements, null, 'MCP uses its explicit evidence, never a conversation');
  const thread = 'ask:123456abcdef', other = 'ask:abcdef123456', now = '2026-11-07T12:00:00.000Z';
  for (const id of [thread, other]) s.db.prepare('INSERT INTO conversations (key, created_at) VALUES (?, ?)').run(id, now);
  const insert = (conversation, role, text, actor) => s.db.prepare('INSERT INTO messages (conversation_key, role, text, ts, provenance) VALUES (?, ?, ?, ?, ?)')
    .run(conversation, role, text, now, JSON.stringify({ ownerInput: { actorId: actor } }));
  insert(thread, 'me', 'Use 4 percent.', 'person-a');
  insert(thread, 'me', 'Use 8 percent.', 'person-b');
  insert(thread, 'fathom', 'Use 9 percent.', 'person-a');
  insert(other, 'me', 'Use 7 percent.', 'person-a');
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
  const second = await tempInstance(); t.after(() => second.close());
  const otherHousehold = await second.household(null, { engine, scheduler });
  assert.notEqual(otherHousehold.services, app.household.services);
  assert.equal(otherHousehold.services.config.dataDir, second.root);
});
