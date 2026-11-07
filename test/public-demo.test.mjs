import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { startServer, openStore } from '../src/server.mjs';
import { getSetting } from '../src/store/db.mjs';
import { createDemoControl, DEMO_LIMIT_MESSAGE, demoRouteBehavior } from '../src/public-demo/control.mjs';
import { routes } from '../src/api/router.mjs';
import { createPublicDemoEngine } from '../src/public-demo/engine.mjs';
import { ingestFile } from '../src/ingest/pipeline.mjs';

const ORIGIN = 'http://localhost:5031';
function config(dir, extra = {}) {
  return { ...loadConfig({ FATHOM_PUBLIC_DEMO: '1', FATHOM_DEMO: '1', FATHOM_PUBLIC_DEMO_DATA: dir,
    FATHOM_DATA: dir, FATHOM_PUBLIC_URL: ORIGIN, FATHOM_ENGINE: 'fake', FATHOM_FAKE_STREAM_MS: '0', ...extra }), port: 0 };
}
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'fathom-public-demo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function app(t, extra = {}) {
  const dir = directory(t);
  const c = config(dir, extra);
  const s = await startServer(c);
  t.after(() => s.close());
  return { ...s, dir, config: c };
}
function visitor(s) {
  let cookie = '';
  return async (path, body, headers = {}) => {
    const res = await fetch(s.url + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', origin: ORIGIN }),
        ...(cookie ? { cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (res.headers.has('set-cookie')) cookie = res.headers.get('set-cookie').split(';')[0];
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
}
function calls(s) {
  const db = new DatabaseSync(join(s.dir, 'public-demo.sqlite'), { readOnly: true });
  try { return db.prepare("SELECT coalesce(sum(calls), 0) AS n FROM usage WHERE subject = 'global'").get().n; }
  finally { db.close(); }
}

const refused = ['FATHOM_DATA_KEY_FILE', 'FATHOM_BACKUP_KEY_FILE', 'FATHOM_PLATFORM_KEY_FILE', 'FATHOM_MCP_SECRET_FILE',
  'FATHOM_MCP_KEY', 'FATHOM_MCP_KEY_FILE', 'FATHOM_SIMPLEFIN_TOKEN', 'FATHOM_SIMPLEFIN_ACCESS_URL',
  'FATHOM_SIMPLEFIN_ALLOWED_HOSTS', 'FATHOM_EMAIL_CREDENTIAL_FILE', 'FATHOM_EMAIL_SMTP_USER',
  'FATHOM_EMAIL_SMTP_HOST', 'FATHOM_EMAIL_SMTP_PORT', 'FATHOM_EMAIL_FROM', 'FATHOM_EMAIL_TO',
  'FATHOM_EMAIL_FROM_FILE', 'FATHOM_EMAIL_TO_FILE'];
for (const key of refused) test(`public demo refuses ${key}`, t => {
  assert.throws(() => config(directory(t), { [key]: 'configured' }), /public.demo/i);
});
test('public demo rejects real mode, service transport, wrong path and missing origin', t => {
  const dir = directory(t);
  for (const extra of [{ FATHOM_DEMO: '0' }, { FATHOM_EMAIL_TRANSPORT: 'smtp' },
    { FATHOM_DATA: join(dir, 'household') }, { FATHOM_PUBLIC_URL: '' }]) {
    assert.throws(() => config(dir, extra));
  }
  assert.equal(config(dir).publicDemo, true);
  assert.equal(loadConfig({}).publicDemo, false);
});
test('startup refuses unmarked demo and real stores without changing them', t => {
  for (const mode of ['demo', 'real']) {
    const dir = directory(t);
    const c = { ...loadConfig({ FATHOM_DATA: dir, FATHOM_DEMO: mode === 'demo' ? '1' : '0', FATHOM_PUBLIC_URL: ORIGIN }), port: 0 };
    const opened = openStore(c);
    if (mode === 'demo') opened.db.prepare("DELETE FROM settings WHERE key = 'synthetic_demo'").run();
    opened.db.close(); opened.platform.close();
    const before = readFileSync(join(dir, 'fathom.sqlite'));
    assert.throws(() => openStore(config(dir)), /public.demo/i);
    assert.deepEqual(readFileSync(join(dir, 'fathom.sqlite')), before);
  }
});
test('valid public startup serves no-login bootstrap and blocks unsafe routes before effects', async t => {
  const s = await app(t);
  const v = visitor(s);
  const session = await v('/api/auth/session');
  assert.deepEqual(session.body, { demo: true, publicDemo: true, identity: null });
  assert.match(session.headers.get('set-cookie'), /HttpOnly/);
  assert.match(session.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal((await v('/api/scenario')).body.live.publicDemo, true);
  for (const route of routes.filter(r => demoRouteBehavior(r.method, r.path) === 'off')) {
    const result = await v(route.path.replace(/:[^/]+/g, 'sample'), route.method === 'POST' ? {} : undefined);
    assert.equal(result.status, 403, `${route.method} ${route.path}`);
    assert.match(result.body.error, /disabled in public demo/i);
  }
  for (const path of ['/mcp', '/%6dcp', '/api/%6beys', '/api/backup', '/api/export']) {
    assert.equal((await v(path, {})).status, 403, path);
  }
  assert.equal((await v('/signin')).status, 403);
  assert.equal(existsSync(join(s.dir, 'api-key-secret')), false);
});
test('visitor writes, what-if, Ask and reset never touch another visitor or base store', async t => {
  const s = await app(t);
  const before = readFileSync(join(s.dir, 'fathom.sqlite'));
  const a = visitor(s), b = visitor(s);
  const pending = (await a('/api/confirm')).body.items;
  const item = pending.find(i => i.options?.length);
  assert.equal((await a(`/api/confirm/${item.id}/answer`, { answer: item.options[0].id })).status, 200);
  assert.ok((await b('/api/confirm')).body.items.some(i => i.id === item.id));
  assert.equal((await a('/api/goals', { title: 'Visitor private goal', horizon: 'now' })).status, 200);
  assert.ok(!(await b('/api/scenario')).body.goals.some(g => g.title === 'Visitor private goal'));
  const reply = await a('/api/threads', { text: 'What should I focus on?' });
  assert.equal(reply.status, 200);
  assert.ok(reply.body.message);
  assert.equal(reply.body.message.notice, false);
  assert.ok(!(await b('/api/threads')).body.active.some(row => row.id === reply.body.thread.id));
  const sc = (await a('/api/scenario')).body;
  const pack = sc.packs.find(p => p.id === 'scorp') || sc.packs[0];
  assert.equal((await a(`/api/packs/${pack.id}/whatif`, {})).status, 200);
  assert.equal((await a('/api/demo/reset', {})).status, 200);
  assert.deepEqual(readFileSync(join(s.dir, 'fathom.sqlite')), before);
  assert.equal(getSetting(s.db, 'synthetic_demo'), 'synthetic-v1');
});
test('turn cap survives reset and returns a fixed notice without another model call', async t => {
  const s = await app(t, { FATHOM_PUBLIC_DEMO_TURNS_PER_DAY: '1' });
  const v = visitor(s);
  assert.equal((await v('/api/threads', { text: 'What should I focus on?' })).status, 200);
  const before = calls(s);
  assert.ok(before > 0);
  await v('/api/demo/reset', {});
  const limited = await v('/api/threads', { text: 'What next?' });
  assert.equal(limited.status, 200);
  assert.match(limited.body.message.text, new RegExp(DEMO_LIMIT_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(calls(s), before);
});
test('IP limits ignore spoofed forwarded addresses and survive restarts', async t => {
  const s = await app(t, { FATHOM_PUBLIC_DEMO_REQUESTS_PER_MINUTE: '2' });
  const v = visitor(s);
  assert.equal((await v('/api/auth/session')).status, 200);
  assert.equal((await v('/api/auth/session')).status, 200);
  assert.equal((await v('/api/auth/session', undefined, { 'x-forwarded-for': '192.0.2.40' })).status, 429);
  await s.close();
  const restarted = await startServer(s.config);
  t.after(() => restarted.close());
  assert.equal((await visitor(restarted)('/api/auth/session')).status, 429);
});
test('durable quotas reserve atomically and roll over at UTC midnight', t => {
  const dir = directory(t);
  let time = Date.parse('2026-11-07T23:59:00Z');
  const c = config(dir, { FATHOM_PUBLIC_DEMO_TURNS_PER_DAY: '1', FATHOM_PUBLIC_DEMO_TOKENS_PER_DAY: '20',
    FATHOM_PUBLIC_DEMO_CALLS_PER_DAY: '2', FATHOM_PUBLIC_DEMO_USD_PER_DAY: '1' });
  let ctl = createDemoControl(c, { now: () => time });
  assert.equal(ctl.reserveTurn('a', 'ip'), true);
  assert.equal(ctl.reserveTurn('a', 'ip'), false);
  assert.equal(ctl.reserveRound('a', 10, 0.1), true);
  assert.equal(ctl.reserveRound('a', 11, 0.1), false);
  assert.equal(ctl.reserveRound('b', 10, 0.1), true);
  assert.equal(ctl.reserveRound('c', 10, 0.1), false);
  ctl.close();
  ctl = createDemoControl(c, { now: () => time });
  assert.equal(ctl.reserveTurn('a', 'ip'), false);
  assert.equal(ctl.reserveRound('c', 1, 0.01), false);
  time += 120000;
  assert.equal(ctl.reserveTurn('a', 'ip'), true);
  assert.equal(ctl.reserveRound('a', 10, 0.1), true);
  ctl.close();
});
test('the API enforces token and global call caps before any fake model round', async t => {
  for (const settings of [{ FATHOM_PUBLIC_DEMO_TOKENS_PER_DAY: '1' }, { FATHOM_PUBLIC_DEMO_CALLS_PER_DAY: '1' }]) {
    const s = await app(t, settings);
    const v = visitor(s);
    if (settings.FATHOM_PUBLIC_DEMO_CALLS_PER_DAY) {
      await v('/api/threads', { text: 'What should I focus on?' });
      assert.equal(calls(s), 1);
    }
    const before = calls(s);
    const result = await v('/api/threads', { text: 'What next?' });
    assert.equal(result.status, 200);
    assert.ok(result.body.message.text.includes(DEMO_LIMIT_MESSAGE));
    assert.equal(calls(s), before);
  }
});
test('static, health and blocked requests allocate no sandbox; trusted proxies get separate IP buckets', async t => {
  const s = await app(t, { FATHOM_PUBLIC_DEMO_REQUESTS_PER_MINUTE: '1', FATHOM_TRUSTED_PROXIES: '127.0.0.1/32' });
  await fetch(s.url + '/');
  await fetch(s.url + '/healthz');
  await fetch(s.url + '/api/keys');
  assert.equal(existsSync(join(s.dir, 'sandboxes')), false);
  const v = visitor(s);
  assert.equal((await v('/api/auth/session', undefined, { 'x-forwarded-for': '192.0.2.41' })).status, 200);
  assert.equal((await v('/api/auth/session', undefined, { 'x-forwarded-for': '192.0.2.42' })).status, 200);
  assert.equal((await v('/api/auth/session', undefined, { 'x-forwarded-for': '192.0.2.41' })).status, 429);
});
test('public startup refuses a demo after an import attempt', async t => {
  const dir = directory(t);
  const privateConfig = { ...loadConfig({ FATHOM_DATA: dir, FATHOM_DEMO: '1' }), port: 0 };
  const { db, platform } = openStore(privateConfig);
  try {
    await ingestFile(db, { name: 'sample.csv', bytes: Buffer.from('Date,Description,Amount\n2026-11-01,Sample,10\n') }, { config: privateConfig });
    assert.equal(getSetting(db, 'synthetic_demo', null), null);
  } finally { db.close(); platform.close(); }
  assert.throws(() => openStore(config(dir)), /synthetic seeder marker/);
});
test('a refused private-demo request preserves the marker and a successful write invalidates it', async t => {
  const dir = directory(t);
  const s = await startServer({ ...loadConfig({ FATHOM_DATA: dir, FATHOM_DEMO: '1', FATHOM_ENGINE: 'fake' }), port: 0 });
  t.after(() => s.close());
  const post = (path, body) => fetch(s.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('/api/jobs/plan/run', {})).status, 409);
  assert.equal(getSetting(s.db, 'synthetic_demo'), 'synthetic-v1');
  assert.equal((await post('/api/goals', { title: 'Private demo goal', horizon: 'now' })).status, 200);
  assert.equal(getSetting(s.db, 'synthetic_demo', null), null);
});
test('live demo boundary applies model/output caps and offers only local read tools', async t => {
  const dir = directory(t);
  const credentialFile = join(dir, 'model-key');
  writeFileSync(credentialFile, 'synthetic', { mode: 0o600 });
  const c = config(dir, { FATHOM_ENGINE: 'live', FATHOM_CLAUDE_CREDENTIAL_FILE: credentialFile,
    FATHOM_PUBLIC_DEMO_MAX_TOKENS: '32', FATHOM_PUBLIC_DEMO_CALLS_PER_DAY: '2' });
  const { db, platform } = openStore(c);
  const control = createDemoControl(c);
  t.after(() => { control.close(); db.close(); platform.close(); });
  const requests = [];
  // Messages API response shape: https://platform.claude.com/docs/en/api/messages/create
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).hostname, 'api.anthropic.com');
    const body = JSON.parse(options.body);
    requests.push(body);
    const first = requests.length === 1;
    return new Response(JSON.stringify({ id: 'msg_sample', type: 'message', role: 'assistant', model: c.publicDemoLimits.model,
      content: first ? [{ type: 'tool_use', id: 'tool_sample', name: 'read_sample', input: {} }] : [{ type: 'text', text: 'Safe sample answer.' }],
      stop_reason: first ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 8 } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const engine = createPublicDemoEngine({ db, config: c, control, visitorId: 'sample' });
  const tools = [{ name: 'read_sample', scope: 'read', description: 'Read synthetic state', inputSchema: { type: 'object', properties: {} }, handler: (_, ctx) => ({ demo: getSetting(ctx.db, 'mode') }) },
    { name: 'write_sample', scope: 'write:recs', description: 'Write state', inputSchema: { type: 'object', properties: {} }, handler: () => assert.fail('write tool ran') }];
  const result = await engine.call({ purpose: 'chat', messages: [{ role: 'user', content: 'Explain sample data' }], tools, toolContext: { db }, maxTokens: 999 });
  assert.equal(result.text, 'Safe sample answer.');
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.max_tokens, 32);
    assert.equal(request.model, c.publicDemoLimits.model);
    assert.deepEqual(request.tools.map(tool => tool.name), ['read_sample']);
  }
  assert.equal(requests[1].messages.at(-1).content[0].tool_use_id, 'tool_sample');
  await assert.rejects(engine.call({ purpose: 'chat', messages: [{ role: 'user', content: 'Again' }] }), e => e.demoLimit);
  assert.equal(requests.length, 2);
});
test('route documentation assigns every server route a demo behavior', () => {
  const docs = readFileSync(new URL('../docs/public-demo.md', import.meta.url), 'utf8');
  for (const route of routes) assert.ok(docs.includes(`| ${route.method} | \`${route.path}\` |`));
  assert.ok(docs.trimEnd().endsWith('provider key provisioning and external spend limits.'));
});
test('per-IP turn quota applies across visitors and persisted control handles', t => {
  const c = config(directory(t), { FATHOM_PUBLIC_DEMO_TURNS_PER_IP_PER_DAY: '1' });
  const first = createDemoControl(c), second = createDemoControl(c);
  try {
    assert.equal(first.reserveTurn('one', 'same-ip'), true);
    assert.equal(second.reserveTurn('two', 'same-ip'), false);
    assert.equal(second.reserveTurn('two', 'other-ip'), true);
  } finally { first.close(); second.close(); }
});
test('an existing cookie reopens only its own sandbox after a server restart', async t => {
  const s = await app(t);
  const v = visitor(s);
  await v('/api/goals', { title: 'Persistent visitor goal', horizon: 'now' });
  await s.close();
  const reopened = await startServer(s.config);
  t.after(() => reopened.close());
  s.url = reopened.url;
  assert.ok((await v('/api/scenario')).body.goals.some(g => g.title === 'Persistent visitor goal'));
  assert.ok(!(await visitor(reopened)('/api/scenario')).body.goals.some(g => g.title === 'Persistent visitor goal'));
});
test('global USD reservations, sandbox TTL/cap and per-IP creation cap are enforced', t => {
  const dir = directory(t);
  let time = Date.parse('2026-11-07T00:00:00Z');
  const c = config(dir, { FATHOM_PUBLIC_DEMO_USD_PER_DAY: '0.1', FATHOM_PUBLIC_DEMO_SANDBOXES: '1',
    FATHOM_PUBLIC_DEMO_CREATIONS_PER_IP_PER_DAY: '1', FATHOM_PUBLIC_DEMO_TTL_SECONDS: '60' });
  const ctl = createDemoControl(c, { now: () => time });
  assert.equal(ctl.reserveRound('a', 1, 0.1), true);
  assert.equal(ctl.reserveRound('b', 1, 0.001), false);
  const first = ctl.sandbox(null, 'ip');
  assert.match(first.id, /^[a-f0-9]{64}$/);
  assert.equal(ctl.sandbox(first.id, 'ip').id, first.id);
  assert.throws(() => ctl.sandbox(null, 'ip2'), /busy/i);
  time += 61000;
  ctl.cleanup();
  assert.throws(() => ctl.sandbox(null, 'ip'), /creation limit/i);
  assert.notEqual(ctl.sandbox(null, 'ip2').id, first.id);
  ctl.close();
});
