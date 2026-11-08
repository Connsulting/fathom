import test from 'node:test';
import assert from 'node:assert/strict';
import { modelApp, interpretation, csv, note } from './helpers/model-import-tools.mjs';

for (const operation of ['import_file', 'note', 'retry_import', 'review_import']) test(`Ask ${operation} uses the real interpreter after the tool round`, { timeout: 5000 }, async t => {
  const x = await modelApp(t), pasted = operation === 'note', text = pasted ? note : csv;
  const response = await interpretation(text, { pasted });
  let args = { operation: 'import_file', name: pasted ? 'synthetic.md' : 'synthetic.csv', mime: pasted ? 'text/markdown' : 'text/csv', text };
  if (operation === 'retry_import' || operation === 'review_import') {
    if (operation === 'retry_import') {
      const { setSetting } = await import('../src/store/db.mjs');
      setSetting(x.db, 'engine', { on: false });
      const initial = await x.mcp('import_file', { name: 'synthetic.csv', mime: 'text/csv', text: csv });
      args = { operation, fileId: initial.file.fileId };
      setSetting(x.db, 'engine', { on: true });
    } else {
      x.responses.push(response); const initial = await x.upload();
      args = { operation, proposalId: initial.proposalId, version: initial.version, decision: 'correct', evidence: 'Change the sign.' };
    }
  }
  x.responses.push(response);
  const before = x.extracts;
  let queued;
  x.onChat = request => {
    const offered = request.tools.find(tool => tool.name === 'refresh'), original = offered.handler;
    offered.handler = async (...params) => {
      const result = await original(...params);
      assert.equal(x.extracts, before, 'the tool did not call the interpreter');
      assert.equal(result.status, 'queued'); queued = result;
      return result;
    };
  };
  x.onExtract = () => assert.ok(queued, 'queued response precedes interpretation');
  x.chat = [{ toolCalls: [{ name: 'refresh', args }], costUsd: 0 }, { text: 'Your request is queued.', costUsd: 0 }];
  const result = await x.app.postJson('/api/threads', { text: operation === 'review_import' ? 'Change the sign.' : 'Please import this file.' });
  assert.equal(result.status, 200, result.text);
  assert.equal(x.extracts, before + 1, 'real interpreter called with the same engine and ledger');
  assert.match(result.json.message.text, /Fathom is reading/);
  assert.match(result.json.message.text, /Files.*Confirm/);
  const proposal = x.db.prepare('SELECT * FROM import_proposals ORDER BY version DESC LIMIT 1').get();
  assert.equal(proposal.status, 'needs_confirmation');
  assert.equal(proposal.version, operation === 'review_import' ? 2 : 1);
  assert.equal(x.db.prepare('SELECT count(*) n FROM transactions').get().n, 0);
  assert.equal(x.db.prepare('SELECT count(*) n FROM facts').get().n, 0);
});
