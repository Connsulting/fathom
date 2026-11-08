import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer, postJson, request } from '../../../test/helpers/server.mjs';
import { createKey, callToolRpc, listToolNames, rpcResult } from './helpers.mjs';

test('MCP action scopes deny before validation and permit only matching writes and undo', async () => {
  await withServer({ env: { FATHOM_ENGINE: 'fake', FATHOM_FAKE_STREAM_MS: '0' } }, async s => {
    const read = (await createKey(s.baseUrl, 'Read actions')).key;
    const scopes = [
      ['write:facts', 'answer', 'fact'], ['write:steps', 'act_on_recommendation', 'step'], ['write:goals', 'update_goal', 'create'],
      ['write:recs', 'act_on_recommendation', 'start_over'],
      ...['decide', 'revisit', 'pick_point'].map(operation => ['write:decisions', 'act_on_recommendation', operation]),
      ...['send', 'verdict', 'checkin', 'packet'].map(operation => ['write:recs', 'advisor_review', operation]),
      ...['archive', 'delete', 'suggestion'].map(operation => ['write:goals', 'update_goal', operation]),
      ...['curve', 'forget', 'save_definition', 'delete_definition', 'pack'].map(operation => ['write:preferences', 'update_preferences', operation]),
      ...['import_file', 'retry_import', 'build_your_plans'].map(operation => ['write:imports', 'refresh', operation]),
      ['write:jobs', 'refresh', 'run_job'],
    ];
    for (const [scope, tool, operation] of scopes) {
      const denied = rpcResult(await callToolRpc(s.baseUrl, read, tool, { operation, malformed: true }));
      assert.equal(denied.isError, true);
      assert.equal(denied.content[0].text, `Permission denied: ${tool}.${operation} needs the ${scope} scope, which this key does not have.`);
      const key = (await createKey(s.baseUrl, `${scope}:${operation}`, [scope])).key;
      assert.ok((await listToolNames(s.baseUrl, key)).includes(tool));
      assert.ok(!(await listToolNames(s.baseUrl, read)).includes(tool));
    }
    const key = (await createKey(s.baseUrl, 'Steps', ['write:steps'])).key;
    const changed = rpcResult(await callToolRpc(s.baseUrl, key, 'act_on_recommendation', { operation: 'step',  id: 'babyprep', index: 0, checked: true }));
    assert.equal(changed.isError, undefined);
    const out = JSON.parse(changed.content[0].text);
    assert.ok(out.receipt.actorId.startsWith('key:'));
    const wrongScope = rpcResult(await callToolRpc(s.baseUrl, read, 'undo', { operation: 'undo', id: out.receipt.id }));
    assert.match(wrongScope.content[0].text, /^Permission denied:/);
    const undone = rpcResult(await callToolRpc(s.baseUrl, key, 'undo', { operation: 'undo',  id: out.receipt.id }));
    assert.equal(undone.isError, undefined);
    const scenario = (await request(s.baseUrl, { path: '/api/scenario' })).json;
    assert.equal(scenario.recs.find(r => r.id === 'babyprep').tasks[0].done, false);
    const goalKey = (await createKey(s.baseUrl, 'Goals', ['write:goals'])).key;
    const goal = rpcResult(await callToolRpc(s.baseUrl, goalKey, 'update_goal', { operation: 'create',  title: 'Cash reserve' }));
    assert.equal(goal.isError, undefined);
    const factKey = (await createKey(s.baseUrl, 'Facts', ['write:facts'])).key;
    const invented = rpcResult(await callToolRpc(s.baseUrl, factKey, 'answer', { operation: 'fact',
      key: 'household.expectedDate', value: '2027-03-19', evidence: 'Set expected date to 2027-03-19',
    }));
    assert.equal(invented.isError, true);
    const before = (await request(s.baseUrl, { path: '/api/scenario' })).json;
    const first = await postJson(s.baseUrl, '/api/threads', { text: 'Set the expected date to 2027-03-19' });
    assert.equal(first.status, 200);
    assert.notEqual(before.recs.find(r => r.id === 'babyprep').window.close, '2027-03-19');
    const second = rpcResult(await callToolRpc(s.baseUrl, factKey, 'answer', { operation: 'fact',
      key: 'household.expectedDate', value: '2027-03-19', evidence: 'Set the expected date to 2027-03-19',
    }));
    assert.equal(second.isError, undefined);
  });
});
