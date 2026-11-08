import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpHouseholds, mcp, toolText, result, digest } from './helpers/tenancy-mcp.mjs';
import { tools } from '../src/tools/index.mjs';
import { request } from './helpers/server.mjs';

test('bearer household controls reads, colliding writes and private packs despite foreign cookie and arguments', async () => {
  const f = await mcpHouseholds();
  try {
    for (const [own, other] of [[f.A, f.B], [f.B, f.A]]) {
      const headers = { cookie: other.admin.cookie, 'x-fathom-household': other.id };
      const before = digest(other.db);
      const facts = result(await f.call(own, 'household', { operation: 'facts' }, headers));
      assert.deepEqual(facts.map(r => [r.key, r.value]), [['synthetic.canary', own.canary]]);
      const rec = result(await f.call(own, 'act_on_recommendation', { operation: 'status', id: 'colliding-rec', status: 'done' }, headers));
      assert.equal(rec.id, 'colliding-rec');
      assert.equal(own.db.prepare("SELECT status FROM recs WHERE id = 'colliding-rec'").get().status, 'done');
      const pack = result(await f.call(own, 'knowledge', { operation: 'entry', packId: 'your-plans', file: 'shared.md' }, headers));
      assert.equal(pack.markdown, `# ${own.canary}\n\n${own.canary} private guidance.\n`);
      const missing = await f.call(own, 'knowledge', { operation: 'entry', packId: 'your-plans', file: `${other.canary}.md` }, headers);
      assert.equal(missing.json.result.isError, true);
      assert.match(toolText(missing), /no entry/);
      for (const args of [{ operation: 'summary', householdId: other.id }, { operation: 'summary', household: other.id }]) {
        const invalid = await f.call(own, 'household', args, headers);
        assert.equal(invalid.json.result.isError, true);
        assert.match(toolText(invalid), /not a known argument/);
      }
      const foreign = await f.call(own, 'act_on_recommendation', { operation: 'status', id: `${other.canary}-only`, status: 'done' }, headers);
      assert.equal(foreign.json.result.isError, true);
      assert.equal(digest(other.db), before);
    }
  } finally { await f.close(); }
});

test('each registered MCP tool executes with only its bearer household context', async () => {
  const f = await mcpHouseholds();
  try {
    for (const [own, other] of [[f.A, f.B], [f.B, f.A]]) {
      const before = digest(other.db);
      const transactionId = Number(own.db.prepare("INSERT INTO transactions (account_id,date,amount,description) VALUES ('colliding-account','2026-11-01',-25,'Synthetic store')").run().lastInsertRowid);
      const samples = {
        accounts: { operation: 'list' }, act_on_recommendation: { operation: 'owner', id: 'colliding-rec', owner: 'both' },
        answer: { operation: 'fact', key: 'household.expectedDate', value: '2027-03-19', evidence: 'Set the expected date to 2027-03-19' },
        business: { operation: 'pnl' }, calculate: { operation: 'sum', operands: [{ ref: { tool: 'accounts', args: { operation: 'net_worth' }, path: 'total' } }], label: 'Synthetic balance' },
        goals: { operation: 'list' }, household: { operation: 'summary' }, knowledge: { operation: 'packs' },
        recommendations: { operation: 'list' }, spending: { operation: 'total' }, tax: { operation: 'estimate' }, transactions: { operation: 'search' },
        categorize: { operation: 'transaction', transactionId, category: 'Groceries' },
        update_account: { operation: 'rename', id: 'colliding-account', displayName: own.canary + ' reserve' },
        update_goal: { operation: 'create', title: 'Synthetic reserve' },
        update_preferences: { operation: 'remember', text: 'Prefer a steady reserve', evidence: 'Prefer a steady reserve' },
      };
      const thread = await own.admin.client.post('/api/threads', { text: 'Set the expected date to 2027-03-19. Prefer a steady reserve' });
      assert.equal(thread.status, 200, thread.text);
      for (const name of ['answer', 'update_preferences']) samples[name].conversationKey = `ask:${thread.json.thread.id}`;
      const changed = result(await f.call(own, 'act_on_recommendation', { operation: 'status', id: 'colliding-rec', status: 'doing' }));
      samples.undo = { operation: 'undo', id: changed.receipt.id };
      assert.deepEqual(Object.keys(samples).sort(), tools.map(t => t.name).sort(), 'every tool needs a successful household fixture');
      for (const tool of tools) {
        const response = await f.call(own, tool.name, samples[tool.name], { cookie: other.admin.cookie });
        result(response);
        assert.ok(!toolText(response).includes(other.canary), tool.name);
      }
      assert.equal(digest(other.db), before, 'no foreign writes or receipts');
    }
  } finally { await f.close(); }
});

test('exact MCP transport retains bearer-only auth, stateless responses and Host/Origin guards', async () => {
  const f = await mcpHouseholds();
  try {
    assert.equal((await mcp(f.baseUrl, null, 'tools/list', {}, { cookie: f.A.admin.cookie })).status, 401);
    assert.equal((await mcp(f.baseUrl, f.A.key.key, 'tools/list', {}, { host: 'untrusted.example.invalid' })).status, 403);
    assert.equal((await mcp(f.baseUrl, f.A.key.key, 'tools/list', {}, { origin: 'https://untrusted.example.invalid' })).status, 403);
    for (const method of ['GET', 'HEAD', 'DELETE']) {
      const response = await request(f.baseUrl, { method, path: '/mcp', headers: { authorization: `Bearer ${f.A.key.key}` } });
      assert.equal(response.status, 405);
    }
    for (const path of ['/mcp/', '/mcp/nested', '/%6dcp']) {
      const response = await request(f.baseUrl, { method: 'POST', path, headers: { authorization: `Bearer ${f.A.key.key}`, 'content-type': 'application/json' }, body: '{}' });
      assert.notEqual(response.status, 200);
    }
    const listed = await mcp(f.baseUrl, f.A.key.key, 'tools/list');
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.result.tools.map(t => t.name), tools.map(t => t.name));
  } finally { await f.close(); }
});
