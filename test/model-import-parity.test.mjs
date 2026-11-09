import test from 'node:test';
import assert from 'node:assert/strict';
import { modelApp, interpretation, csv, note } from './helpers/model-import-tools.mjs';
import { callTool } from '../src/tools/index.mjs';
import { mapSeries } from '../src/shared/series.mjs';

const comparable = result => ({ status: result.status, version: result.version, counts: result.counts, summary: result.summary,
  receipt: result.receipt ? { scope: result.receipt.scope, label: result.receipt.label, scopes: result.receipt.scopes, after: { status: result.receipt.after.status, counts: result.receipt.after.counts } } : null });

test('HTTP and MCP share import, retry, correction, approval, reinterpretation and batch Undo', async t => {
  const http = await modelApp(t), mcp = await modelApp(t);
  const output = await interpretation(csv);
  http.responses.push(output); mcp.responses.push(output);
  let a = await http.upload(), b = (await mcp.mcp('import_file', { name: 'synthetic.csv', mime: 'text/csv', text: csv })).file;
  assert.equal(a.status, 'needs_confirmation'); assert.deepEqual(comparable(a), comparable(b));
  assert.equal((await http.db.prepare('SELECT count(*) n FROM transactions').get()).n, 0);
  a = (await http.app.postJson(`/api/files/${a.fileId}/retry`, { mode: 'retry' })).json.file;
  b = (await mcp.mcp('retry_import', { fileId: b.fileId, mode: 'retry' })).file;
  assert.deepEqual(comparable(a), comparable(b)); assert.equal(http.extracts, 1); assert.equal(mcp.extracts, 1);
  const corrected = await interpretation(csv, { negate: true });
  http.responses.push(corrected); mcp.responses.push(corrected);
  a = (await http.review(a, 'correct', 'Change the sign.')).json;
  b = await mcp.mcp('review_import', { proposalId: b.proposalId, version: b.version, decision: 'correct', evidence: 'Change the sign.' });
  assert.equal(a.status, 'needs_confirmation'); assert.equal(a.version, 2); assert.deepEqual(comparable(a), comparable(b));
  assert.equal(http.extracts, 2); assert.equal(mcp.extracts, 2);
  const approvedA = (await http.review(a)).json;
  const approvedB = await mcp.mcp('review_import', { proposalId: b.proposalId, version: b.version, decision: 'approve', evidence: 'yes' });
  assert.equal(approvedA.status, 'imported'); assert.deepEqual(comparable(approvedA), comparable(approvedB));
  assert.equal(approvedB.undo.available, true); assert.equal(approvedB.undo.args.id, approvedB.receipt.id);
  assert.equal((await mcp.db.prepare('SELECT amount FROM transactions').get()).amount, 12.25);
  const fileId = (await mcp.db.prepare('SELECT id FROM files').get()).id;
  http.responses.push(output); mcp.responses.push(output);
  a = (await http.app.postJson(`/api/files/${fileId}/retry`, { mode: 'reinterpret' })).json.file;
  b = (await mcp.mcp('retry_import', { fileId, mode: 'reinterpret' })).file;
  assert.equal(a.version, 3); assert.deepEqual(comparable(a), comparable(b));
  assert.equal((await mcp.db.prepare('SELECT amount FROM transactions').get()).amount, 12.25);
  assert.equal((await mcp.app.request({ path: '/api/files' })).json.files[0].proposal.version, 3);
  const stale = await mcp.mcp('review_import', { proposalId: b.proposalId, version: 2, decision: 'approve', evidence: 'yes' });
  assert.match(stale.error, /proposal changed/i);
  const finalA = (await http.review(a)).json;
  const finalB = await mcp.mcp('review_import', { proposalId: b.proposalId, version: 3, decision: 'approve', evidence: 'yes' });
  assert.deepEqual(comparable(finalA), comparable(finalB));
  assert.equal((await mcp.db.prepare('SELECT amount FROM transactions').get()).amount, -12.25);
  assert.equal((await http.app.postJson(`/api/actions/${finalA.receipt.id}/undo`, {})).status, 200);
  assert.equal((await mcp.tool('undo', { operation: 'undo', id: finalB.receipt.id })).receipt.undone, true);
  assert.equal((await mcp.db.prepare('SELECT amount FROM transactions').get()).amount, 12.25);
  assert.deepEqual(await mcp.tool('household', { operation: 'imports' }), (await mcp.app.request({ path: '/api/files' })).json);
});

test('automatic approved-layout imports expose their batch receipt and shared Undo', async t => {
  const x = await modelApp(t);
  x.responses.push(await interpretation(csv)); const first = await x.upload();
  assert.equal((await x.review(first)).json.status, 'imported');
  const second = await x.mcp('import_file', { name: 'repeat.csv', mime: 'text/csv', text: csv.replace('-12.25', '-9.25').replace('03-02', '03-09') });
  assert.equal(second.file.status, 'imported');
  assert.equal(second.receipt.id, second.file.receipt.id); assert.equal(second.undo.available, true);
  assert.equal(x.extracts, 1);
  assert.equal((await x.tool('undo', { operation: 'undo', id: second.receipt.id })).receipt.undone, true);
  assert.equal((await x.db.prepare('SELECT count(*) n FROM transactions').get()).n, 1);
});

test('typed pasted notes retain counts and grouped action receipts across HTTP and MCP', async t => {
  const a = await modelApp(t), b = await modelApp(t), output = await interpretation(note, { pasted: true });
  a.responses.push(output); b.responses.push(output);
  const first = (await a.app.postJson('/api/onboarding/notes', { text: note })).json.file;
  const second = (await b.mcp('import_file', { name: 'synthetic.md', mime: 'text/markdown', text: note })).file;
  assert.equal(first.status, 'needs_confirmation'); assert.deepEqual(comparable(first), comparable(second));
  const denied = await b.tool('refresh', { operation: 'review_import', proposalId: second.proposalId, version: second.version, decision: 'approve', evidence: 'yes' }, ['read', 'write:imports']);
  assert.match(denied.error, /write:facts/);
  assert.equal((await b.db.prepare('SELECT count(*) n FROM action_receipts').get()).n, 1, 'only the initial refresh receipt exists');
  assert.equal((await b.db.prepare('SELECT count(*) n FROM facts').get()).n, 0);
  const approvedA = (await a.review(first)).json;
  const approvedB = await b.mcp('review_import', { proposalId: second.proposalId, version: second.version, decision: 'approve', evidence: 'yes' });
  assert.equal(approvedB.status, 'imported'); assert.deepEqual(comparable(approvedA), comparable(approvedB));
  assert.equal(approvedB.counts.actions, 1); assert.deepEqual(approvedB.receipt.scopes, ['write:facts', 'write:imports']);
  assert.equal(JSON.parse((await b.db.prepare("SELECT value FROM facts WHERE key='household.filingStatus'").get()).value), 'single');
});

test('Ask corrections refuse a missing round-end queue before changing the proposal', async t => {
  const x = await modelApp(t);
  x.responses.push(await interpretation(csv)); const proposal = await x.upload();
  const before = JSON.stringify(await x.db.prepare('SELECT * FROM import_proposals').all());
  await assert.rejects(callTool('refresh', { operation: 'review_import', proposalId: proposal.proposalId, version: proposal.version,
    decision: 'correct', evidence: 'Change the sign.' }, { db: x.db, household: x.app.household, services: x.app.household.services,
    actorId: x.app.session.user.id, ownerText: 'Change the sign.', channel: 'ask' }), /round-end queue/);
  assert.equal(JSON.stringify(await x.db.prepare('SELECT * FROM import_proposals').all()), before);
});

test('foreign file and proposal references refuse before receipts or mutations', async t => {
  const a = await modelApp(t), b = await modelApp(t);
  a.responses.push(await interpretation(csv)); const imported = await a.upload();
  const tables = ['files', 'import_proposals', 'import_batches', 'transactions', 'action_receipts'];
  const snapshot = async x => JSON.stringify(await mapSeries(tables, async table => await x.db.prepare(`SELECT * FROM ${table}`).all()));
  const before = [await snapshot(a), await snapshot(b)];
  for (const mode of ['retry', 'reinterpret']) {
    assert.equal((await b.app.postJson(`/api/files/${imported.fileId}/retry`, { mode })).status, 404);
    assert.match((await b.mcp('retry_import', { fileId: imported.fileId, mode })).error, /[Nn]o such file/);
  }
  for (const decision of ['approve', 'correct']) {
    assert.equal((await b.review(imported, decision)).status, 404);
    assert.match((await b.mcp('review_import', { proposalId: imported.proposalId, version: imported.version, decision, evidence: 'yes' })).error, /[Nn]o such proposal/);
  }
  assert.deepEqual([await snapshot(a), await snapshot(b)], before);
});
