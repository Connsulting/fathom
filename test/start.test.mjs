// AC1: `npm ci && npm start` serves the Horizon UI and the JSON API from one process on FATHOM_PORT,
// backed by SQLite in FATHOM_DATA (platform.sqlite and households/<id>/fathom.sqlite), seeding the
// demo when the data dir has no instance.

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import net from 'node:net';
import {
  ROOT, DB_FILE, PLATFORM_FILE, SERVER_TIMEOUT, withServer, tempDir, freePort, childEnv, src, withAuthenticatedServer, withPlatform, servedStore,
} from './helpers/server.mjs';
import { spawn } from 'node:child_process';

const T = { timeout: SERVER_TIMEOUT };

function latestMigrationId(dir = join(ROOT, 'src/store/migrations')) {
  const ids = readdirSync(dir).map(f => /^(\d{3})-.+\.sql$/.exec(f)).filter(Boolean).map(m => Number(m[1]));
  return Math.max(...ids);
}

test('npm start on an empty data dir with FATHOM_DEMO unset serves the demo UI and API', T, async () => {
  const dataDir = await tempDir();
  await withServer({ dataDir, npm: true, env: { FATHOM_DEMO: undefined } }, async s => {
    const page = await s.request({ path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.match(page.text, /<div id="app"/);
    assert.match(page.text, /horizon\/design\.js/);

    const sc = await s.getScenario();
    assert.equal(sc.meta.product, 'Fathom');
    assert.ok(Array.isArray(sc.recs) && sc.recs.length > 0, 'demo recs are served');
    assert.equal(sc.live.mode, 'demo');

    const h = await s.request({ path: '/healthz' });
    assert.equal(h.status, 200);
    assert.equal(h.json.ok, true);
    assert.equal(h.json.schema, latestMigrationId());
    // MT-03: healthz names the shipped store and platform schemas only, no household, count or path.
    assert.deepEqual(Object.keys(h.json).sort(), ['ok', 'platformSchema', 'schema']);
    assert.equal(h.json.platformSchema, latestMigrationId(join(ROOT, 'src/platform/migrations')));

    assert.ok(existsSync(join(dataDir, PLATFORM_FILE)), 'a synthetic platform.sqlite is created in FATHOM_DATA');
    const served = await withPlatform(join(dataDir, PLATFORM_FILE), async (platform, store) => await store.servedHousehold());
    assert.equal(served.mode, 'demo');
    assert.equal(served.status, 'active');
    assert.ok(existsSync(join(dataDir, 'households', served.id, DB_FILE)), 'fathom.sqlite is created in the household root');
    assert.ok(!existsSync(join(dataDir, DB_FILE)), 'no store at the data root');
    assert.match(s.output(), /fathom listening on http:\/\//);
  });
});

test('FATHOM_DEMO=0 on an empty data dir serves a valid empty scenario', T, async () => {
  await withAuthenticatedServer({ env: { FATHOM_DEMO: '0' } }, async s => {
    const sc = await s.getScenario();
    // The startup tick may run the nightly plan job; any rec is the planner's, never a seeded one.
    const { openDb } = await src('src/store/db.mjs');
    const db = await openDb((await servedStore(s.dataDir)).file);
    let planned;
    let identity;
    try {
      planned = (await db.prepare('SELECT rec_id FROM planner_recs').all()).map(r => r.rec_id);
      identity = await db.prepare('SELECT household_id FROM store_identity').get();
    } finally { await db.close(); }
    const served = await withPlatform(s.platformFile, async (platform, store) => await store.servedHousehold());
    assert.equal(served.mode, 'real');
    assert.equal(identity.household_id, served.id, 'the new store names the served household');
    assert.equal(s.session.householdId, served.id);
    assert.deepEqual(sc.recs.filter(r => !planned.includes(r.id)).map(r => r.id), []);
    assert.equal(sc.live.mode, 'real');
    const page = await s.request({ path: '/' });
    assert.equal(page.status, 200);
    assert.match(page.text, /<div id="app"/);
  });
});

test('a taken FATHOM_PORT makes the process exit nonzero with a clear message', T, async () => {
  const port = await freePort();
  const blocker = net.createServer();
  await new Promise(r => blocker.listen(port, '127.0.0.1', r));
  try {
    const dataDir = await tempDir();
    const child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: ROOT,
      env: childEnv({ FATHOM_DATA: dataDir, FATHOM_PORT: port }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { out += d; });
    const code = await new Promise((res, rej) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); rej(new Error('server did not exit on a taken port')); }, 15000);
      child.on('exit', c => { clearTimeout(timer); res(c); });
    });
    assert.notEqual(code, 0);
    assert.match(out, new RegExp(String(port)), 'message names the port');
  } finally {
    blocker.close();
  }
});

test('README documents the one command', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.ok(readme.includes('npm ci && npm start'));
});

test('loadConfig defaults and env mapping', async () => {
  const { loadConfig } = await src('src/config.mjs');
  const d = loadConfig({});
  assert.equal(d.dataDir, resolve('data'));
  assert.equal(d.port, 8080);
  assert.equal(d.host, '127.0.0.1');
  assert.equal(d.demo, 'auto');
  assert.equal(d.clock, null);
  assert.equal(d.emailTransport, 'dev');
  assert.equal(d.platformKeyFile, null);
  assert.equal(d.mcpSecretFile, null);
  assert.equal(d.backupKeyFile, null);

  const c = loadConfig({
    FATHOM_DATA: '/tmp/fathom-x', FATHOM_PORT: '9123', FATHOM_HOST: '0.0.0.0', FATHOM_DEMO: '1',
    FATHOM_CLOCK: '2027-01-05', FATHOM_EMAIL_TRANSPORT: 'resend',
    FATHOM_CLAUDE_CREDENTIAL_FILE: '/run/secrets/c', FATHOM_PLATFORM_KEY_FILE: '/run/secrets/p',
    FATHOM_MCP_SECRET_FILE: '/run/secrets/m', FATHOM_BACKUP_KEY_FILE: '/run/secrets/b', FATHOM_DATA_KEY_FILE: '/run/secrets/k',
  });
  assert.equal(c.dataDir, '/tmp/fathom-x');
  assert.equal(c.port, 9123);
  assert.equal(c.host, '0.0.0.0');
  assert.equal(c.demo, true);
  assert.equal(c.engine, 'fake');
  assert.equal(c.clock, '2027-01-05');
  assert.equal(c.emailTransport, 'resend');
  assert.equal(c.claudeCredentialFile, '/run/secrets/c');
  assert.equal(c.platformKeyFile, '/run/secrets/p');
  assert.equal(c.mcpSecretFile, '/run/secrets/m');
  assert.equal(c.backupKeyFile, '/run/secrets/b');
  // MT-03: FATHOM_DATA_KEY_FILE is read only by the offline tenancy migration, never the runtime.
  assert.ok(!Object.values(c).includes('/run/secrets/k'), 'the legacy data key path is not in the runtime config');
  assert.ok(!('dataKeyFile' in c));

  const off = loadConfig({ FATHOM_DEMO: '0' });
  assert.equal(off.demo, false);
  assert.equal(off.engine, 'off');
  assert.equal(loadConfig({ FATHOM_DEMO: '0', FATHOM_ENGINE: 'live' }).engine, 'live');
});
