import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { fixture, recipe } from '../helpers/model-import.mjs';
import { createSessionFixture, contextHeaders } from '../helpers/server.mjs';
import { applyLayout } from '../../src/ingest/model-layout.mjs';
import { stageUpdate } from '../../src/ingest/model-updates.mjs';
import { stageImport, reviewImport } from '../../src/ingest/model-review.mjs';
import { createHandler } from '../../src/api/router.mjs';
import { createAuthService } from '../../src/auth/service.mjs';
import { createRuntimeRegistry } from '../../src/platform/runtime.mjs';
import { createKeyService } from '../../src/mcp/keys.mjs';

test('authenticated HTTP review guards, exact owner statement, versions, foreign ids and body identity rejection', async () => {
  const x = await fixture();
  const config = { ...x.config, publicUrl: 'https://app.example.test', allowedHosts: ['127.0.0.1', 'app.example.test'] };
  const session = await createSessionFixture(x.platform);
  const auth = createAuthService({ platform: x.platform, config, transport: { send: async () => {} } });
  const keys = createKeyService({ platform: x.platform, secret: () => x.secrets.mcpSecret(), creatorActive: auth.creatorActive });
  const runtimes = createRuntimeRegistry({ platform: x.platform, config, secrets: x.secrets });
  const server = http.createServer(createHandler({ platform: x.platform, config, auth, keys, runtimes }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  async function post(id, body, headers = {}) {
    const response = await fetch(base + '/api/import-proposals/' + id + '/review', { method: 'POST',
      headers: { 'content-type': 'application/json', cookie: session.cookie, origin: config.publicUrl, ...contextHeaders(session), ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  try {
    const source = await x.source();
    const staged = stageImport({ ...x.ctx, actorId: session.user.id }, { source, proposal: applyLayout(source, recipe()), layout: recipe() });
    const args = { version: 1, decision: 'approve', evidence: 'looks right' };
    assert.equal((await post(staged.proposalId, args, { cookie: '' })).status, 401);
    assert.equal((await post(staged.proposalId, args, { origin: 'https://other.example.test' })).status, 403);
    assert.equal((await post('foreign-proposal', args)).status, 404);
    for (const body of [{ ...args, actorId: 'another' }, { ...args, householdId: 'another' }, { ...args, proposalId: staged.proposalId }, { ...args, version: 0 }, { ...args, evidence: '' }, { ...args, evidence: 'x'.repeat(4001) }]) {
      assert.equal((await post(staged.proposalId, body)).status, 400);
    }
    const out = await post(staged.proposalId, args);
    assert.equal(out.status, 200, JSON.stringify(out.body));
    assert.equal(out.body.status, 'imported'); assert.equal(out.body.receipt.actorId, session.user.id);
    const stale = await post(staged.proposalId, args);
    assert.equal(stale.status, 409); assert.equal(stale.body.code, 'proposal_stale');
    const next = await x.source('Account,Date,Amount USD,Description\naccount-synthetic,2032-03-09,-4,Synthetic correction\n');
    const p = stageImport({ ...x.ctx, actorId: session.user.id }, { source: next, proposal: applyLayout(next, recipe()) });
    const correction = await post(p.proposalId, { version: 1, decision: 'correct', evidence: 'Change the sign.' });
    assert.equal(correction.status, 200); assert.equal(correction.body.status, 'queued'); assert.equal(correction.body.version, 2);
    await assert.rejects(reviewImport({ ...x.ctx, scopes: [] }, { proposalId: p.proposalId, version: 2, decision: 'correct', evidence: 'yes' }), e => e.code === 'forbidden');
    const note = await x.source('The payroll provider pays next Tuesday.', 'text');
    const span = { fileId: note.fileId, sha256: note.sha256, byteStart: 0, byteEnd: note.bytes.length };
    const update = stageUpdate({ ...x.ctx, actorId: session.user.id }, { source: note, capturedAt: '2032-03-02T14:00:00Z', actions: [
      { tool: 'answer', operation: 'expected_transaction', span, args: { subject: 'payroll provider', direction: 'inflow', amount: null,
        dueDate: '2032-03-09', datePrecision: 'day', relativeDate: 'next Tuesday', evidence: 'The payroll provider pays next Tuesday.' } },
    ] });
    assert.equal(x.db.prepare('SELECT count(*) n FROM expected_transactions').get().n, 0);
    const committed = await post(update.proposalId, args);
    assert.equal(committed.status, 200, JSON.stringify(committed.body));
    assert.equal(x.db.prepare('SELECT count(*) n FROM expected_transactions').get().n, 1);
    const undo = await fetch(base + '/api/actions/' + committed.body.receipt.id + '/undo', { method: 'POST', headers: {
      'content-type': 'application/json', cookie: session.cookie, origin: config.publicUrl, ...contextHeaders(session) }, body: '{}' });
    assert.equal(undo.status, 200, await undo.text());
    assert.equal(x.db.prepare('SELECT count(*) n FROM expected_transactions').get().n, 0);
    assert.equal(x.db.prepare('SELECT count(*) n FROM files WHERE id=?').get(note.fileId).n, 1);
  } finally {
    await new Promise(resolve => server.close(resolve)); runtimes.close(); x.close();
  }
});
