import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { scratch, createRealStore, householdOf } from './helpers/real-store.mjs';
import { callTool } from '../src/tools/index.mjs';
import { createToolServer } from '../src/mcp/server.mjs';
import { SCOPES } from '../src/mcp/keys.mjs';
import { uploadFiles, listFiles, retryFile } from '../src/api/ingest-handlers.mjs';
import { runJob } from '../src/api/email-handlers.mjs';
import { setSetting } from '../src/store/db.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { proposalBasis, proposalTools } from '../src/actions/proposals.mjs';
import { tools } from '../src/tools/index.mjs';

const s = scratch('fathom-refresh-');
after(() => s.cleanup());
const now = '2026-11-08T12:00:00.000Z';
const note = { name: 'Synthetic notes.md', mime: 'text/markdown', text: '# Household notes\n\nUse short answers.' };
async function setup() {
  const db = s.track(await createRealStore(s.dir()));
  const household = householdOf(db), config = { clock: '2026-11-08' };
  const scheduler = { runNow: async id => ({ id: `run-${id}`, status: 'ok', startedAt: now, finishedAt: now }), trigger() {}, jobs: () => [], runs: () => [] };
  const engine = createEngine({ mode: 'off' });
  const services = { household, scheduler, engine, config };
  return { db, now, actorId: 'person-a', household, services, channel: 'mcp' };
}
async function client(ctx, scopes = SCOPES) {
  const server = createToolServer({ scopes, ctx });
  const c = new Client({ name: 'synthetic-test', version: '1' });
  const [a,b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), c.connect(b)]);
  return { call: async (name,args) => {
    const result = await c.callTool({ name, arguments: args });
    if (result.isError) return result;
    return JSON.parse(result.content[0].text);
  }, close: async () => { await c.close(); await server.close(); } };
}
const api = ctx => ({ db: ctx.db, household: ctx.household, ...ctx.services, config: ctx.services.config, params: {}, body: {} });

test('MCP base64 imports share the HTTP pipeline, imports read matches list, retry matches route', async () => {
  const ctx = await setup(), rpc = await client(ctx);
  try {
    const bytes = Buffer.from(note.text);
    const imported = await rpc.call('refresh', { operation: 'import_file', name: note.name, mime: note.mime, contentBase64: bytes.toString('base64') });
    assert.equal(imported.file.status, 'needs_extraction');
    const row = ctx.db.prepare('SELECT * FROM files WHERE id=?').get(imported.file.id);
    assert.equal(row.name, note.name);
    assert.equal(row.size, bytes.length);
    assert.equal(imported.undo.available, false);
    const other = await setup();
    const route = await uploadFiles({ ...api(other), uploads: [{ field: 'files', name: note.name, mime: note.mime, bytes }] });
    const otherRow = other.db.prepare('SELECT * FROM files WHERE id=?').get(route.files[0].fileId);
    for (const k of ['id','name','mime','size','sha256','status','parser','counts']) assert.equal(row[k], otherRow[k], k);
    assert.deepEqual(await rpc.call('household', { operation: 'imports' }), listFiles(api(ctx)));
    const retried = await rpc.call('refresh', { operation: 'retry_import', fileId: imported.file.id });
    const retryRoute = await retryFile({ ...api(other), params: { id: imported.file.id } });
    assert.deepEqual(retried.file, { ...retryRoute.file, id: retryRoute.file.fileId });
    const job = await rpc.call('refresh', { operation: 'run_job', job: 'freshness' });
    assert.equal(job.run.status, 'ok');
    assert.equal(job.undo.available, false);
    assert.deepEqual(job.run, (await runJob({ ...api(ctx), params: { id: 'freshness' } })).run);
  } finally { await rpc.close(); }
});

test('refresh validates size, encoding, job allowlist, queue capability and demo planning before effects', async () => {
  const ctx = await setup();
  for (const input of [ { ...note, text: 'a'.repeat(1024 * 1024) }, { ...note, contentBase64: 'YWJj' },
    { name: note.name, mime: note.mime, contentBase64: '???' }, { name: note.name, mime: note.mime } ])
    await assert.rejects(callTool('refresh', { operation: 'import_file', ...input }, ctx));
  assert.equal(ctx.db.prepare('SELECT count(*) n FROM files').get().n, 0);
  for (const job of ['brief-email','deadline-alerts','trash-purge']) await assert.rejects(callTool('refresh', { operation: 'run_job', job }, ctx));
  for (const args of [ { operation: 'import_file', ...note }, { operation: 'retry_import', fileId: 'unknown' }, { operation: 'build_your_plans' }, { operation: 'run_job', job: 'plan' }, { operation: 'run_job', job: 'confirm-guess' } ])
    await assert.rejects(callTool('refresh', args, { ...ctx, channel: 'ask' }));
  setSetting(ctx.db, 'mode', 'demo');
  await assert.rejects(callTool('refresh', { operation: 'run_job', job: 'plan' }, ctx), /real stores only/);
  await assert.rejects(runJob({ ...api(ctx), params: { id: 'plan' } }), /real stores only/);
});

test('read-only MCP denies each new write before validation', async () => {
  const rpc = await client(await setup(), ['read']);
  try {
    for (const [name,operation] of [ ...['forget','save_definition','delete_definition','pack'].map(op => ['update_preferences',op]), ...['import_file','retry_import','build_your_plans','run_job'].map(op => ['refresh',op]) ]) {
      const result = await rpc.call(name, { operation });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, new RegExp(`Permission denied: ${name}\\.${operation} needs`));
    }
  } finally { await rpc.close(); }
});

for (const operation of ['import_file','retry_import','build_your_plans','plan','confirm-guess']) test(`Ask ${operation} queues within the round and completes after ledger release`, { timeout: 5000 }, async () => {
  const ctx = await setup();
  const imported = operation === 'retry_import' || operation === 'build_your_plans'
    ? await callTool('refresh', { operation: 'import_file', ...note }, ctx) : null;
  const args = operation === 'import_file' ? { operation, ...note }
    : operation === 'retry_import' ? { operation, fileId: imported.file.id }
    : operation === 'build_your_plans' ? { operation, fileIds: [imported.file.id] }
    : { operation: 'run_job', job: operation };
  let inside = false, extracts = 0, queued;
  const inner = createEngine({ mode: 'fake' });
  const extraction = req => {
    assert.equal(inside, false, 'engine is called only after the tool round');
    extracts++;
    return inner.extract({ ...req, fake: [{ text: JSON.stringify({ rows: [{ facts: [], goals: [] }] }), costUsd: 0 }] });
  };
  const engine = { mode: 'fake', isOn: () => true, extract: extraction, async call(request) {
    const result = await inner.call({ ...request, fake: [ { toolCalls: [{ name: 'refresh', args }], costUsd: 0 }, { text: 'The requested refresh was queued.', costUsd: 0 } ] });
    queued = result.toolResults.find(r => r.name === 'refresh');
    return result;
  } };
  ctx.services.engine = engine;
  ctx.services.scheduler.runNow = async job => {
    assert.equal(inside, false);
    await inner.extract({ purpose: 'extract', system: 'Synthetic', messages: [{ role: 'user', content: 'Synthetic' }], maxTokens: 100,
      fake: [{ text: '{"rows":[]}', costUsd: 0 }] });
    return { id: `run-${job}`, status: 'ok', startedAt: now, finishedAt: now };
  };
  const tool = tools.find(t => t.name === 'refresh');
  const original = tool.handler;
  tool.handler = async (...params) => {
    inside = true;
    try { const out = await original(...params); assert.equal(out.status ?? out.run?.status, 'queued'); return out; }
    finally { inside = false; }
  };
  try {
    await createLiveAnswerer({ engine, root: ctx.household.root, services: ctx.services }).answer({ db: ctx.db,
      key: 'ask:123456abcdef', text: 'Please refresh the data.', actorId: ctx.actorId,
      replan: () => ctx.services.scheduler.runNow('plan') });
    assert.equal(queued?.isError, undefined, JSON.stringify(queued));
    assert.equal(queued.result.status ?? queued.result.run?.status, 'queued');
    assert.equal(queued.result.undo.available, false);
    const receipt = ctx.db.prepare('SELECT * FROM action_receipts WHERE id=?').get(queued.result.receipt.id);
    const outcome = JSON.parse(receipt.after_value);
    assert.notEqual(outcome.status, 'queued');
    assert.notEqual(outcome.status, 'failed', JSON.stringify(outcome));
    if (operation === 'import_file' || operation === 'retry_import') { assert.ok(outcome.file.id); assert.ok(extracts > 0); }
  } finally { tool.handler = original; }
});

test('refresh proposals snapshot files, settings and jobs, and queue failures persist safe outcomes', async () => {
  const ctx = await setup();
  for (const args of [{ operation: 'import_file', ...note }, { operation: 'build_your_plans' }, { operation: 'run_job', job: 'freshness' }]) {
    let p;
    await proposalTools(tools).find(t => t.name === 'refresh').handler({ ...args, propose: true }, { ...ctx, channel: 'ask', onProposal: v => { p = v; }, queueAfterTools() {} });
    assert.equal(typeof p.basis, 'string');
    assert.equal(p.basis, proposalBasis(ctx.db, 'refresh', p.scopes, p.args));
  }
  let task;
  const result = await callTool('refresh', { operation: 'run_job', job: 'confirm-guess' }, { ...ctx, channel: 'ask', queueAfterTools: fn => { task = fn; } });
  ctx.services.scheduler.runNow = async () => { throw new Error('synthetic failure with private details'); };
  await task();
  const outcome = JSON.parse(ctx.db.prepare('SELECT after_value FROM action_receipts WHERE id=?').get(result.receipt.id).after_value);
  assert.equal(outcome.status, 'failed');
  assert.ok(!JSON.stringify(outcome).includes('private details'));
});
