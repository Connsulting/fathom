import test from 'node:test';
import assert from 'node:assert/strict';
import * as receipts from '../src/actions/receipts.mjs';
import { WRITE_SCOPES } from '../src/shared/action-scopes.mjs';
import { SCOPE_INFO, toolsForScopes } from '../src/mcp/keys.mjs';
import { buildRegistry, tools } from '../src/tools/index.mjs';
import { createRegistryServer } from '../src/engine/tools.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { threadCreate, ask } from '../src/api/handlers.mjs';
import { proposalTools } from '../src/actions/proposals.mjs';
import { tempDb, tempInstance, serveAppFixture } from './helpers/server.mjs';
import { rpcResult, callToolRpc, listToolNames } from '../src/mcp/test/helpers.mjs';

const additions = {
  'write:accounts': 'Rename accounts, set their last four, owner and kind, and merge duplicates with confirmation.',
  'write:categories': 'Correct transaction categories and set merchant rules.',
  'write:confirm': 'Answer and reopen Confirm questions and mark expected tax documents.',
  'write:imports': 'Import files and retry or build from imported documents.',
  'write:jobs': 'Run planning, sync, freshness and guess jobs now.',
  'write:decisions': 'Pick and decide war-game options and reopen decisions.',
};
const now = '2026-11-07T12:00:00.000Z';

test('new write scopes have exact access text and are offered only for chat', async () => {
  for (const [scope, access] of Object.entries(additions)) {
    assert.ok(WRITE_SCOPES.includes(scope), scope);
    assert.equal(SCOPE_INFO.find(s => s.id === scope)?.access, access);
    const { tools: registry } = buildRegistry([{ operations: [{ tool: 'refresh', name: 'probe', scope,
      summary: 'Exercise scope gating.', route: 'Exercise gating', routes: [], params: {}, required: [], handler: () => ({ ok: true }) }] }]);
    for (const purpose of ['chat', 'plan', 'brief', 'title', 'extract', 'confirm']) {
      const server = createRegistryServer(registry, { purpose });
      assert.equal(server.names.includes('refresh'), purpose === 'chat', `${scope} ${purpose}`);
      await server.instance.close();
    }
  }
});

test('registered table kinds restore inserts, edits and deletes by primary key', async t => {
  const s = await tempDb(); t.after(() => s.close());
  s.db.exec('CREATE TABLE c2_rows (id TEXT PRIMARY KEY, value TEXT)');
  receipts.registerReceiptKind('c2_table', { table: 'c2_rows', pk: 'id' });
  const ctx = { db: s.db, actorId: 'person-a', now };
  const before = { id: 'row', value: 'before' }, after = { id: 'row', value: 'after' };
  for (const [from, to] of [[null, after], [before, after], [before, null]]) {
    s.db.exec('DELETE FROM c2_rows');
    if (to) s.db.prepare('INSERT INTO c2_rows VALUES (?, ?)').run(to.id, to.value);
    const r = receipts.saveReceipt(ctx, { scope: 'write:accounts', kind: 'c2_table', id: 'row', label: 'Test change', before: from, after: to });
    await receipts.undoAction(ctx, r.id, 'write:accounts');
    const restored = s.db.prepare('SELECT * FROM c2_rows').get();
    assert.deepEqual(restored ? { ...restored } : null, from);
  }
});

test('restore hooks run in the receipt transaction and refusals preserve the action', async t => {
  const s = await tempDb(); t.after(() => s.close());
  let refuse = true, calls = 0;
  receipts.registerReceiptKind('c2_inverse', { restore(ctx, { id, before, after }) {
    calls++;
    assert.equal(id, 'inverse'); assert.equal(before, null); assert.equal(after, 'after');
    ctx.db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('inverse', 'true', now);
    if (refuse) throw new Error('changed since');
  } });
  const ctx = { db: s.db, actorId: 'person-a', now };
  const r = receipts.saveReceipt(ctx, { scope: 'write:decisions', kind: 'c2_inverse', id: 'inverse', label: 'Inverse', before: null, after: 'after' });
  await assert.rejects(receipts.undoAction(ctx, r.id, r.scope), /changed since/);
  assert.equal(s.db.prepare("SELECT * FROM settings WHERE key = 'inverse'").get(), undefined);
  assert.equal(s.db.prepare('SELECT undone_at FROM action_receipts WHERE id = ?').get(r.id).undone_at, null);
  refuse = false;
  assert.equal((await receipts.undoAction(ctx, r.id, r.scope)).receipt.undone, true);
  assert.equal(calls, 2);
});

test('unknown kinds fail closed and registrations reject duplicate or unsafe definitions', async t => {
  const s = await tempDb(); t.after(() => s.close());
  const ctx = { db: s.db, actorId: 'person-a', now };
  s.db.prepare(`INSERT INTO action_receipts
    (id, scope, kind, entity_id, actor_id, label, before_state, after_state, before_value, after_value, created_at)
    VALUES ('unknown', 'write:goals', 'missing_kind', 'x', 'person-a', 'Unknown', 'null', '1', 'null', '1', ?)`).run(now);
  await assert.rejects(receipts.undoAction(ctx, 'unknown', 'write:goals'), /receipt kind/i);
  for (const definition of [{ table: 'settings; DROP TABLE facts', pk: 'key' }, { table: 'settings', pk: 'key OR 1=1' }, {},
    { table: 'settings', pk: 'key', restore() {} }]) {
    assert.throws(() => receipts.registerReceiptKind('c2_invalid', definition), /receipt kind/i);
  }
  assert.throws(() => receipts.registerReceiptKind('setting', { table: 'settings', pk: 'key' }), /already registered/i);
});

test('setting undo rejects later edits, another actor and a missing scope before restoring', async t => {
  const s = await tempDb(); t.after(() => s.close());
  const ctx = { db: s.db, actorId: 'person-a', now };
  s.db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('pick', '2', now);
  const r = receipts.saveReceipt(ctx, { scope: 'write:decisions', kind: 'setting', id: 'pick', label: 'Pick', before: { key: 'pick', value: '1' }, after: { key: 'pick', value: '2' } });
  await assert.rejects(receipts.undoAction({ ...ctx, actorId: 'person-b' }, r.id, r.scope), /available to you/);
  await assert.rejects(receipts.undoAction({ ...ctx, scopes: ['write:recs'] }, r.id, r.scope), /Permission denied:/);
  s.db.prepare("UPDATE settings SET value = '3' WHERE key = 'pick'").run();
  await assert.rejects(receipts.undoAction(ctx, r.id, r.scope), /changed since/);
  s.db.prepare("UPDATE settings SET value = '2' WHERE key = 'pick'").run();
  await receipts.undoAction(ctx, r.id, r.scope);
  assert.equal(s.db.prepare("SELECT value FROM settings WHERE key = 'pick'").get().value, '1');
});

test('every write scope lists undo and restores a receipt through MCP and Ask', async t => {
  const s = await tempInstance(); t.after(() => s.close());
  const app = await serveAppFixture({ db: s.db, platform: s.platform, config: { dataDir: s.dataDir }, secrets: s.secrets });
  t.after(() => app.close());
  for (const scope of WRITE_SCOPES) {
    const { key } = app.keys.create({ householdId: s.householdId, name: 'Synthetic scope', scopes: [scope] });
    assert.ok((await listToolNames(app.baseUrl, key)).includes('undo'), scope);
    assert.ok(!toolsForScopes(['read']).some(t => t.name === 'undo'));
    for (const channel of ['mcp', 'ask']) {
      s.db.prepare('INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('surface', '2', now);
      const ctx = { db: s.db, actorId: `key:${app.keys.verify(key).id}`, scopes: [scope], now, replan: () => ({ status: 'ok' }) };
      const r = receipts.saveReceipt(ctx, { scope, kind: 'setting', id: 'surface', label: 'Surface', before: { key: 'surface', value: '1' }, after: { key: 'surface', value: '2' } });
      let out;
      if (channel === 'mcp') out = rpcResult(await callToolRpc(app.baseUrl, key, 'undo', { operation: 'undo', id: r.id }));
      else {
        const transport = createEngine({ mode: 'fake' });
        let chats = 0;
        const engine = { mode: 'live', isOn: () => true, async call(request) {
          if (request.purpose === 'title') return { text: JSON.stringify({ title: 'Synthetic undo' }), toolResults: [] };
          chats++;
          const response = await transport.call({ ...request, fake: [
            { toolCalls: [{ name: 'undo', args: { operation: 'undo', id: r.id, propose: true } }] }, { text: 'Undo your change? Confirm below.' },
          ] });
          return response;
        } };
        const askCtx = { db: s.db, config: {}, identity: { id: ctx.actorId }, scopes: [scope],
          scheduler: { runNow: ctx.replan }, answerer: createLiveAnswerer({ engine, root: s.root, services: app.household.services }) };
        const proposed = await threadCreate({ ...askCtx, body: { text: 'Undo my change.' } });
        assert.deepEqual(proposed.message.provenance.pendingAction.scopes, [scope]);
        assert.equal(s.db.prepare("SELECT value FROM settings WHERE key = 'surface'").get().value, '2');
        const confirmed = await ask({ ...askCtx, body: { key: proposed.thread.key, text: 'yes' } });
        const result = confirmed.message.provenance.tools.find(r => r.name === 'undo');
        out = { isError: result.isError, content: [{ type: 'text', text: JSON.stringify(result.result) }] };
        assert.equal(chats, 1, 'confirmation executes without another model call');
      }
      assert.ok(!out.isError, out.content[0].text);
      assert.equal(JSON.parse(out.content[0].text).receipt.undone, true);
      assert.equal(s.db.prepare("SELECT value FROM settings WHERE key = 'surface'").get().value, '1');
    }
  }
  const { key } = app.keys.create({ householdId: s.householdId, name: 'Restricted', scopes: ['write:recs'] });
  const r = receipts.saveReceipt({ db: s.db, actorId: `key:${app.keys.verify(key).id}`, now }, {
    scope: 'write:facts', kind: 'setting', id: 'surface', label: 'Restricted', before: null, after: { key: 'surface', value: '1' } });
  const denied = rpcResult(await callToolRpc(app.baseUrl, key, 'undo', { operation: 'undo', id: r.id }));
  assert.equal(denied.isError, true); assert.match(denied.content[0].text, /^Permission denied:/);
  const proposalServer = createRegistryServer(proposalTools(tools), { purpose: 'chat', ctx: {
    db: s.db, actorId: `key:${app.keys.verify(key).id}`, scopes: ['write:recs'], onProposal() { assert.fail('unauthorized proposal'); },
  } });
  const proposalDenied = await proposalServer.invoke('undo', { operation: 'undo', id: r.id, propose: true });
  assert.equal(proposalDenied.isError, true); assert.match(proposalDenied.content[0].text, /^Permission denied:/);
  await proposalServer.instance.close();
  const otherActor = createRegistryServer(proposalTools(tools), { purpose: 'chat', ctx: {
    db: s.db, actorId: 'person-b', scopes: ['write:facts'], onProposal() { assert.fail('another actor proposal'); },
  } });
  const actorDenied = await otherActor.invoke('undo', { operation: 'undo', id: r.id, propose: true });
  assert.equal(actorDenied.isError, true); assert.match(actorDenied.content[0].text, /not available to you/);
  await otherActor.instance.close();
  const readKey = app.keys.create({ householdId: s.householdId, name: 'Read only' }).key;
  const readDenied = rpcResult(await callToolRpc(app.baseUrl, readKey, 'undo', { operation: 'undo' }));
  assert.equal(readDenied.isError, true); assert.match(readDenied.content[0].text, /^Permission denied:/);
});
