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
import { fakeExtractRows } from '../src/packs/your-plans.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { createLiveAnswerer } from '../src/api/answerer.mjs';
import { proposalBasis, proposalTools } from '../src/actions/proposals.mjs';
import { tools } from '../src/tools/index.mjs';

const s = scratch('fathom-refresh-');
after(async () => await s.cleanup());
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
  const server = createToolServer({ scopes, ctx, authorize: () => true, runTool: fn => fn() });
  const c = new Client({ name: 'synthetic-test', version: '1' });
  const [a,b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), c.connect(b)]);
  return { call: async (name,args) => {
    const result = await c.callTool({ name, arguments: args });
    if (result.isError) return result;
    return JSON.parse(result.content[0].text);
  }, close: async () => { await c.close(); await server.close(); } };
}
const api = ctx => ({ actorId: ctx.actorId, db: ctx.db, household: ctx.household, ...ctx.services, config: ctx.services.config, params: {}, body: {} });

test('MCP base64 imports share the HTTP pipeline, imports read matches list, retry matches route', async () => {
  const ctx = await setup(), rpc = await client(ctx);
  try {
    const bytes = Buffer.from(note.text);
    const imported = await rpc.call('refresh', { operation: 'import_file', name: note.name, mime: note.mime, contentBase64: bytes.toString('base64') });
    assert.equal(imported.file.status, 'waiting_for_engine');
    const row = await ctx.db.prepare('SELECT * FROM files WHERE id=?').get(imported.file.id);
    assert.equal(row.name, note.name);
    assert.equal(row.size, bytes.length);
    assert.equal(imported.undo.available, false);
    const other = await setup();
    const route = await uploadFiles({ ...api(other), uploads: [{ field: 'files', name: note.name, mime: note.mime, bytes }] });
    const otherRow = await other.db.prepare('SELECT * FROM files WHERE id=?').get(route.files[0].fileId);
    for (const k of ['id','name','mime','size','sha256','status','parser','counts']) assert.equal(row[k], otherRow[k], k);
    assert.deepEqual(await rpc.call('household', { operation: 'imports' }), await listFiles(api(ctx)));
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
  assert.equal((await ctx.db.prepare('SELECT count(*) n FROM files').get()).n, 0);
  await assert.rejects(callTool('refresh', { operation: 'import_file', ...note }, { ...ctx, household: { ...ctx.household, db: {} } }), /own this store/);
  assert.equal((await ctx.db.prepare('SELECT count(*) n FROM action_receipts').get()).n, 0);
  for (const job of ['brief-email','deadline-alerts','trash-purge']) await assert.rejects(callTool('refresh', { operation: 'run_job', job }, ctx));
  for (const args of [ { operation: 'import_file', ...note }, { operation: 'retry_import', fileId: 'unknown' }, { operation: 'build_your_plans' }, { operation: 'run_job', job: 'plan' }, { operation: 'run_job', job: 'confirm-guess' } ])
    await assert.rejects(callTool('refresh', args, { ...ctx, channel: 'ask' }));
  await setSetting(ctx.db, 'mode', 'demo');
  await assert.rejects(callTool('refresh', { operation: 'run_job', job: 'plan' }, ctx), /real stores only/);
  await assert.rejects(runJob({ ...api(ctx), params: { id: 'plan' } }), /real stores only/);
});

test('read-only MCP denies each new write before validation', async () => {
  const rpc = await client(await setup(), ['read']);
  try {
    for (const [name,operation] of [ ...['forget','save_definition','delete_definition','pack'].map(op => ['update_preferences',op]), ...['import_file','retry_import','review_import','build_your_plans','run_job'].map(op => ['refresh',op]) ]) {
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
    const rows = req.schema?.properties?.title ? fakeExtractRows(req.document.text) : [{ facts: [], goals: [] }];
    return inner.extract({ ...req, fake: [{ text: JSON.stringify({ rows }), costUsd: 0 }] });
  };
  const engine = { mode: 'fake', isOn: () => true, extract: extraction, async call(request) {
    const result = await inner.call({ ...request, fake: [ { toolCalls: [{ name: 'refresh', args }], costUsd: 0 }, { text: 'The requested refresh was queued.', costUsd: 0 } ] });
    queued = result.toolResults.find(r => r.name === 'refresh');
    return result;
  } };
  ctx.services.engine = engine;
  ctx.services.scheduler.runNow = async job => {
    assert.equal(inside, false);
    await inner.extract({ document: { type: 'text', text: 'Synthetic job input' }, schema: { type: 'object' }, system: 'Synthetic', maxTokens: 100,
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
    const receipt = await ctx.db.prepare('SELECT * FROM action_receipts WHERE id=?').get(queued.result.receipt.id);
    const outcome = JSON.parse(receipt.after_value);
    assert.notEqual(outcome.status, 'queued');
    assert.notEqual(outcome.status, 'failed', JSON.stringify(outcome));
    if (operation === 'import_file' || operation === 'retry_import') { assert.ok(outcome.file.id); assert.equal(outcome.file.status, 'waiting_for_engine'); }
    if (operation === 'build_your_plans') assert.equal(outcome.written, true);
  } finally { tool.handler = original; }
});

test('refresh proposals snapshot files, settings and jobs, and queue failures persist safe outcomes', async () => {
  const ctx = await setup();
  for (const args of [{ operation: 'import_file', ...note }, { operation: 'build_your_plans' }, { operation: 'run_job', job: 'freshness' }]) {
    let p;
    await proposalTools(tools).find(t => t.name === 'refresh').handler({ ...args, propose: true }, { ...ctx, channel: 'ask', onProposal: v => { p = v; }, queueAfterTools() {} });
    assert.equal(typeof p.basis, 'string');
    assert.equal(p.basis, await proposalBasis(ctx.db, 'refresh', p.scopes, p.args));
  }
  let task;
  const result = await callTool('refresh', { operation: 'run_job', job: 'confirm-guess' }, { ...ctx, channel: 'ask', queueAfterTools: fn => { task = fn; } });
  ctx.services.scheduler.runNow = async () => { throw new Error('synthetic failure with private details'); };
  await task();
  const outcome = JSON.parse((await ctx.db.prepare('SELECT after_value FROM action_receipts WHERE id=?').get(result.receipt.id)).after_value);
  assert.equal(outcome.status, 'failed');
  assert.ok(!JSON.stringify(outcome).includes('private details'));
});

test('HTTP proposal confirmation executes a pasted-note refresh and persisted receipts offer no Undo', async t => {
  const { tempInstance, serveAppFixture } = await import('./helpers/server.mjs');
  const { rmSync } = await import('node:fs');
  const { loadConfig } = await import('../src/config.mjs');
  const { rpcResult, callToolRpc } = await import('../src/mcp/test/helpers.mjs');
  const instance = await tempInstance();
  let calls = 0;
  const inner = createEngine({ mode: 'fake' });
  const engine = { mode: 'fake', isOn: () => true,
    extract: req => inner.extract({ ...req, fake: [{ text: '{"rows":[{"facts":[],"goals":[]}]}', costUsd: 0 }] }),
    call(req) {
      if (req.purpose === 'chat') calls++;
      if (req.purpose === 'job') return inner.call({ ...req, fake: [{ text: '{}', costUsd: 0 }] });
      if (req.purpose === 'title') return Promise.resolve({ text: '{"title":"Synthetic import"}' });
      return inner.call({ ...req, fake: [{ toolCalls: [{ name: 'refresh', args: { operation: 'import_file', ...note, propose: true } }], costUsd: 0 },
        { text: 'Import your pasted note? Confirm below.', costUsd: 0 }] });
    },
  };
  const config = loadConfig({ FATHOM_DATA: instance.dataDir, FATHOM_ENGINE: 'off' });
  const app = await serveAppFixture({ db: instance.db, platform: instance.platform, config, secrets: instance.secrets, engine, authenticated: true });
  t.after(async () => { await app.household.scheduler.stop(); await app.close(); instance.close(); rmSync(instance.dataDir, { recursive: true, force: true }); });
  const proposed = await app.postJson('/api/threads', { text: 'Import the following note: ' + note.text });
  assert.equal(proposed.status, 200, proposed.text);
  assert.equal(proposed.json.message.provenance.pendingAction.operation, 'import_file');
  assert.equal((await instance.db.prepare('SELECT count(*) n FROM files').get()).n, 0);
  const beforeCalls = calls;
  const confirmed = await app.postJson('/api/ask', { key: proposed.json.thread.key, text: 'yes' });
  assert.equal(confirmed.status, 200, confirmed.text);
  assert.equal(calls, beforeCalls, 'confirmation makes no chat call');
  const receipt = confirmed.json.message.provenance.actions[0];
  assert.equal(receipt.after.file.status, 'waiting_for_engine');
  assert.equal(receipt.undo.available, false);
  assert.ok(!confirmed.json.message.text.includes('undo it below'));
  const { key } = app.keys.create({ householdId: instance.householdId, name: 'Synthetic importer', scopes: ['read','write:imports'], userId: app.session.user.id });
  const imports = rpcResult(await callToolRpc(app.baseUrl, key, 'household', { operation: 'imports' }));
  assert.deepEqual(JSON.parse(imports.content[0].text), (await app.request({ path: '/api/files' })).json);
  const result = rpcResult(await callToolRpc(app.baseUrl, key, 'refresh', { operation: 'import_file', name: 'Other notes.md', mime: note.mime,
    contentBase64: Buffer.from('A different synthetic note.').toString('base64') }));
  assert.equal(result.isError, undefined, result.content[0].text);
  const imported = JSON.parse(result.content[0].text);
  assert.equal(imported.file.status, 'waiting_for_engine');
  const form = new FormData();
  form.append('files', new Blob(['A different synthetic note.'], { type: note.mime }), 'Other notes.md');
  const upload = await fetch(app.baseUrl + '/api/files', { method: 'POST', headers: app.headers, body: form });
  assert.equal(upload.status, 200);
  const uploaded = await upload.json();
  assert.equal(uploaded.files[0].fileId, imported.file.id);
  // H1: identical bytes of a file still waiting answer its stored status, not 'duplicate'.
  assert.equal(uploaded.files[0].status, imported.file.status);
  assert.equal(uploaded.files[0].duplicateOf, imported.file.id);
  const undone = await app.postJson(`/api/actions/${receipt.id}/undo`, {});
  assert.equal(undone.status, 409);
});

test('refresh receipt rendering omits Undo while ordinary reversible receipts keep it', async () => {
  const { registerHooks } = await import('node:module');
  const hook = registerHooks({ resolve(specifier, context, next) {
    return next(specifier.startsWith('/shared/') ? new URL('../src/shared/' + specifier.slice(8), import.meta.url).href : specifier, context);
  } });
  try {
    const chat = await import('../web/horizon/screens/chat.js');
    chat.bind({ esc: String, arr: v => v });
    const html = receipt => chat.workHtml({ role: 'fathom', provenance: { actions: [receipt] } });
    const receipt = { id: 'synthetic', scope: 'write:imports', label: 'Data refresh', before: null, after: { status: 'imported' } };
    assert.match(html(receipt), /data-undo-action/);
    const pack = html({ ...receipt, scope: 'write:preferences', label: 'Knowledge pack activation', before: false, after: true });
    assert.match(pack, /Knowledge pack activation/);
    assert.doesNotMatch(pack, /Memory updated|See all memories/);
    assert.doesNotMatch(html({ ...receipt, undo: { available: false, reason: 'This refresh cannot be undone here.' } }), /data-undo-action/);
  } finally { hook.deregister(); }
});

test('MCP rebuild completes inline and all allowed jobs use the household scheduler', async () => {
  const ctx = await setup();
  const inner = createEngine({ mode: 'fake' });
  ctx.services.engine = { isOn: () => true, extract: req => inner.extract({ ...req,
    fake: [{ text: JSON.stringify({ rows: req.schema?.properties?.title ? fakeExtractRows(req.document.text) : [{ facts: [], goals: [] }] }), costUsd: 0 }] }) };
  const rpc = await client(ctx);
  try {
    const imported = await rpc.call('refresh', { operation: 'import_file', ...note });
    assert.equal(imported.file.status, 'waiting_for_engine');
    const built = await rpc.call('refresh', { operation: 'build_your_plans', fileIds: [imported.file.id] });
    assert.equal(built.status, 'built');
    assert.equal(built.written, true);
    assert.equal(built.receipt.after.written, true);
    assert.equal(built.undo.available, false);
    for (const job of ['plan', 'simplefin-sync', 'freshness', 'confirm-guess']) {
      const result = await rpc.call('refresh', { operation: 'run_job', job });
      assert.equal(result.run.id, `run-${job}`);
      assert.equal(result.run.status, 'ok');
      assert.equal(result.receipt.scope, 'write:jobs');
      assert.equal(result.undo.available, false);
    }
  } finally { await rpc.close(); }
});

test('large import lists keep newest rows within the tool result bound and preserve API parity', async () => {
  const ctx = await setup();
  const insert = ctx.db.prepare('INSERT INTO files(id,name,uploaded_at,status) VALUES (?,?,?,?)');
  ctx.db.exec('BEGIN');
  for (let i = 0; i < 1500; i++) await insert.run(`file-${i}`, 'Synthetic file ' + 'x'.repeat(180), now, 'imported');
  ctx.db.exec('COMMIT');
  await ctx.db.prepare('UPDATE files SET removed_at = ? WHERE id = ?').run(now, 'file-1499');
  const result = await callTool('household', { operation: 'imports' }, ctx);
  assert.equal(result.truncated, true);
  assert.equal(result.files[0].id, 'file-1498');
  assert.ok(!result.files.some(file => file.id === 'file-1499'));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 256 * 1024);
  assert.deepEqual(result, await listFiles(api(ctx)));
});
