import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { startServer, openStore } from '../src/server.mjs';
import { getSetting } from '../src/store/db.mjs';
import { createDemoControl, DEMO_LIMIT_MESSAGE, demoRouteBehavior } from '../src/public-demo/control.mjs';
import { routes } from '../src/api/router.mjs';

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
  await v('/api/demo/reset', {});
  const limited = await v('/api/threads', { text: 'What next?' });
  assert.equal(limited.status, 200);
  assert.match(limited.body.message.text, new RegExp(DEMO_LIMIT_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
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
