import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpHouseholds, mcp, toolText, result, digest, expectedTransactionFixture, refreshImportFixture, accountCategoryFixtures } from './helpers/tenancy-mcp.mjs';
import { callTool, tools } from '../src/tools/index.mjs';
import { isMcpTool } from '../src/mcp/keys.mjs';

import { groupReceipts } from '../src/actions/receipts.mjs';
import { request } from './helpers/server.mjs';

const mcpTools = tools.filter(isMcpTool);

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
      const samples = {
        accounts: { operation: 'list' }, act_on_recommendation: { operation: 'owner', id: 'colliding-rec', owner: 'both' },
        advisor_review: { operation: 'send', recId: 'colliding-rec' },
        answer: { operation: 'fact', key: 'household.expectedDate', value: '2027-03-19', evidence: 'Set the expected date to 2027-03-19' },
        business: { operation: 'pnl' }, calculate: { operation: 'sum', operands: [{ ref: { tool: 'accounts', args: { operation: 'net_worth' }, path: 'total' } }], label: 'Synthetic balance' },
        goals: { operation: 'list' }, household: { operation: 'summary' }, knowledge: { operation: 'packs' },
        recommendations: { operation: 'list' }, refresh: refreshImportFixture(own), retirement: own.retirement, sources: { operation: 'archive_account', id: 'colliding-account' }, spending: { operation: 'total' }, tax: { operation: 'estimate' }, transactions: { operation: 'search' },
        ...accountCategoryFixtures(own),
        update_goal: { operation: 'create', title: 'Synthetic reserve' },
        update_preferences: { operation: 'remember', text: 'Prefer a steady reserve', evidence: 'Prefer a steady reserve' },
      };
      const thread = await own.admin.client.post('/api/threads', { text: 'Set the expected date to 2027-03-19. Prefer a steady reserve. ' + expectedTransactionFixture(own).evidence });
      assert.equal(thread.status, 200, thread.text);
      for (const name of ['answer', 'update_preferences']) samples[name].conversationKey = `ask:${thread.json.thread.id}`;
      const changed = result(await f.call(own, 'act_on_recommendation', { operation: 'status', id: 'colliding-rec', status: 'doing' }));
      samples.undo = { operation: 'undo', id: changed.receipt.id };
      assert.deepEqual(Object.keys(samples).sort(), mcpTools.map(t => t.name).sort(), 'every tool needs a successful household fixture');
      for (const tool of mcpTools) {
        const response = await f.call(own, tool.name, samples[tool.name], { cookie: other.admin.cookie });
        const data = result(response);
        if (tool.name === 'retirement') {
          assert.equal(data.figure.value, own.retirementBalance);
          assert.ok(toolText(response).includes(own.canary));
        }
        assert.ok(!toolText(response).includes(other.canary), tool.name);
      }
      const expectation = result(await f.call(own, 'answer', { ...expectedTransactionFixture(own), conversationKey: `ask:${thread.json.thread.id}` }));
      assert.equal(expectation.expectedTransaction.subject, own.canary);
      assert.equal(own.db.prepare('SELECT count(*) n FROM expected_transactions').get().n, 1);
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
    assert.deepEqual(listed.json.result.tools.map(t => t.name), mcpTools.map(t => t.name));
  } finally { await f.close(); }
});

test('an imports-only MCP key cannot apply or undo fact, goal or step actions in a group', async () => {
  const f = await mcpHouseholds();
  try {
    const own = f.A, other = f.B, before = digest(other.db);
    const imports = await f.create(own, own.admin.client, ['read', 'write:imports']);
    const ctx = { db: own.db, actorId: own.admin.userId, ownerText: 'Set expected date to 2032-06-19', now: '2032-03-02T14:00:00Z' };
    const fact = { operation: 'fact', key: 'household.expectedDate', value: '2032-06-19', evidence: ctx.ownerText };
    const goal = { operation: 'create', title: 'Synthetic reserve' };
    const step = { operation: 'step', id: 'colliding-rec', index: 0, checked: true };
    const children = [await callTool('answer', fact, ctx), await callTool('update_goal', goal, ctx), await callTool('act_on_recommendation', step, ctx)];
    const receipt = groupReceipts(ctx, children.map(c => c.receipt), { id: 'synthetic-group' });
    for (const [name, args] of [['answer', fact], ['update_goal', goal], ['act_on_recommendation', step], ['undo', { operation: 'undo', id: receipt.id }]]) {
      const response = await mcp(f.baseUrl, imports.key, 'tools/call', { name, arguments: args });
      assert.equal(response.json.result.isError, true);
      assert.match(toolText(response), /Permission denied/);
    }
    assert.equal(own.db.prepare('SELECT undone_at FROM action_receipts WHERE id=?').get(receipt.id).undone_at, null);
    result(await f.call(own, 'undo', { operation: 'undo', id: receipt.id }));
    assert.equal(own.db.prepare('SELECT count(*) n FROM goals').get().n, 0);
    assert.equal(digest(other.db), before);
  } finally { await f.close(); }
});
