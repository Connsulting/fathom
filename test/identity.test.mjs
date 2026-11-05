// Owner identity: on a real store every page and /api route needs a Tailscale-User-Login listed in
// FATHOM_OWNER_LOGINS (or FATHOM_OWNER_LOGINS_FILE). /healthz stays open, /mcp uses bearer keys
// only, demo stores are open, and a missing or broken login list fails closed. All through the real
// server over HTTP.

import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { routes } from '../src/api/router.mjs';
import { SERVER_TIMEOUT, TEST_OWNER, spawnServer, request, postJson, tempDir } from './helpers/server.mjs';
import { createKey, mcpPost, bearer, rpcResult, UNAUTHORIZED } from '../src/mcp/test/helpers.mjs';

const T = { timeout: SERVER_TIMEOUT };
const LOGIN = 'tailscale-user-login';
const NAME = 'tailscale-user-name';
const NO_LOGIN = { [LOGIN]: undefined };
const INTRUDER = 'intruder-7f3a@example.test';
const REAL = { FATHOM_DEMO: '0', FATHOM_ENGINE: 'off' };
const PAGES = ['/', '/index.html', '/core/core.js', '/shared/tokens.mjs', '/plan', '/nope.js'];

const as = login => ({ [LOGIN]: login });

// Every route from the route table as a request: :param segments become x, POSTs carry an empty
// JSON object. Routes added later are covered automatically.
function routeRequests(headers = {}) {
  return routes.map(({ method, path }) => {
    const concrete = path.replace(/:[^/]+/g, 'x');
    const req = method === 'POST'
      ? { method, path: concrete, headers: { 'content-type': 'application/json', ...headers }, body: '{}' }
      : { method, path: concrete, headers: { ...headers } };
    return { label: `${method} ${path}`, path: concrete, req };
  });
}

function assertApi401(r, label) {
  assert.equal(r.status, 401, `${label}: expected 401, got ${r.status}: ${r.text.slice(0, 200)}`);
  assert.equal(r.text, '{"error":"unauthorized"}', `${label}: body`);
}

function assertPage401(r, label) {
  assert.equal(r.status, 401, `${label}: expected 401, got ${r.status}: ${r.text.slice(0, 200)}`);
  assert.match(r.headers['content-type'] || '', /^text\/html/, `${label}: content type`);
  assert.match(r.headers['cache-control'] || '', /no-store/, `${label}: cache control`);
  assert.ok(r.text.includes('Not authorized'), `${label}: Not authorized page`);
}

const problemLines = s => s.output().split('\n').filter(l => /FATHOM_OWNER_LOGINS/.test(l));

// Every page and every /api route answers 401 even with a header that would otherwise match.
async function assertAllClosed(s, headers) {
  for (const p of PAGES) assertPage401(await request(s.baseUrl, { path: p, headers }), `page ${p}`);
  for (const { label, path, req } of routeRequests(headers)) {
    const r = await request(s.baseUrl, req);
    if (path === '/healthz') assert.equal(r.status, 200, label);
    else assertApi401(r, label);
  }
}

describe('real mode: the identity gate', () => {
  let s;
  before(async () => { s = await spawnServer({ env: REAL }); }, T);
  after(async () => { if (s) await s.stop(); });

  test('no header: /api/scenario is 401 with exactly {"error":"unauthorized"}', async () => {
    assertApi401(await request(s.baseUrl, { path: '/api/scenario', headers: NO_LOGIN }), 'GET /api/scenario');
  });

  test('liveness: the listed login reads the scenario', async () => {
    const r = await request(s.baseUrl, { path: '/api/scenario', headers: as(TEST_OWNER) });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.equal(r.json.live.mode, 'real');
  });

  test('no header: pages, scripts, the SPA fallback and unknown files are the 401 Not authorized page', async () => {
    for (const p of PAGES) assertPage401(await request(s.baseUrl, { path: p, headers: NO_LOGIN }), `GET ${p}`);
  });

  test('no header: HEAD on a page is 401 with no body', async () => {
    const r = await request(s.baseUrl, { method: 'HEAD', path: '/', headers: NO_LOGIN });
    assert.equal(r.status, 401);
    assert.equal(r.text, '');
  });

  test('liveness: the listed login gets the app shell and its scripts', async () => {
    for (const p of ['/', '/index.html', '/core/core.js', '/shared/tokens.mjs', '/plan']) {
      const r = await request(s.baseUrl, { path: p, headers: as(TEST_OWNER) });
      assert.equal(r.status, 200, `GET ${p}: ${r.status}`);
      assert.ok(!r.text.includes('Not authorized'), `GET ${p} is not the refusal page`);
    }
  });

  test('a wrong login is 401 and the response never echoes it', async () => {
    const api = await request(s.baseUrl, { path: '/api/scenario', headers: { ...as(INTRUDER), [NAME]: INTRUDER } });
    assertApi401(api, 'GET /api/scenario as intruder');
    assert.ok(!api.text.includes(INTRUDER), 'API body does not echo the login');
    assert.ok(!JSON.stringify(api.headers).includes(INTRUDER), 'API headers do not echo the login');
    const page = await request(s.baseUrl, { path: '/', headers: { ...as(INTRUDER), [NAME]: INTRUDER } });
    assertPage401(page, 'GET / as intruder');
    assert.ok(!page.text.includes(INTRUDER), 'page body does not echo the login');
    assert.ok(!JSON.stringify(page.headers).includes(INTRUDER), 'page headers do not echo the login');
    assert.ok(!s.output().includes(INTRUDER), 'the server log does not carry the login');
  });

  test('an empty or blank header is refused', async () => {
    assertApi401(await request(s.baseUrl, { path: '/api/scenario', headers: as('') }), 'empty login');
    assertApi401(await request(s.baseUrl, { path: '/api/scenario', headers: as('   ') }), 'blank login');
  });

  test('a duplicated header (joined with a comma by Node) never matches', async () => {
    assertApi401(await request(s.baseUrl, { path: '/api/scenario', headers: as([TEST_OWNER, TEST_OWNER]) }), 'duplicate login headers');
    assertApi401(await request(s.baseUrl, { path: '/api/scenario', headers: as(`${TEST_OWNER},${INTRUDER}`) }), 'comma list login');
  });

  test('the login matches with different case and surrounding spaces', async () => {
    for (const login of [' Owner@Example.TEST ', 'OWNER@EXAMPLE.TEST', `\t${TEST_OWNER}  `]) {
      const api = await request(s.baseUrl, { path: '/api/scenario', headers: as(login) });
      assert.equal(api.status, 200, `API as ${JSON.stringify(login)}: ${api.status}`);
      const page = await request(s.baseUrl, { path: '/', headers: as(login) });
      assert.equal(page.status, 200, `page as ${JSON.stringify(login)}: ${page.status}`);
    }
  });

  test('every route in the route table is 401 without the header; /healthz is 200', async () => {
    const reqs = routeRequests(NO_LOGIN);
    assert.ok(reqs.length > 10, 'the route table is enumerated');
    assert.ok(reqs.some(x => x.path === '/healthz'), '/healthz is in the table');
    for (const { label, path, req } of reqs) {
      const r = await request(s.baseUrl, req);
      if (path === '/healthz') {
        assert.equal(r.status, 200, `${label}: ${r.status}`);
        assert.equal(r.json && r.json.ok, true);
      } else {
        assert.ok(path.startsWith('/api'), `${label} is an /api route`);
        assertApi401(r, label);
      }
    }
  });

  test('unknown /api paths, encoded paths and wrong methods are 401 without the header', async () => {
    const cases = [
      ['GET', '/api/nope'], ['GET', '/api'], ['GET', '/api/'], ['GET', '/api/%73cenario'], ['GET', '/api/scenario?x=1'],
      ['DELETE', '/api/scenario'], ['PUT', '/api/engine'], ['GET', '/api/engine'],
    ];
    for (const [method, path] of cases) assertApi401(await request(s.baseUrl, { method, path, headers: NO_LOGIN }), `${method} ${path}`);
    const post = await request(s.baseUrl, { method: 'POST', path: '/plan', headers: NO_LOGIN });
    assertPage401(post, 'POST to a page');
  });

  test('liveness: with the header the same unknown path and wrong method reach routing (404, 405)', async () => {
    assert.equal((await request(s.baseUrl, { path: '/api/nope', headers: as(TEST_OWNER) })).status, 404);
    assert.equal((await request(s.baseUrl, { method: 'DELETE', path: '/api/scenario', headers: as(TEST_OWNER) })).status, 405);
  });

  test('the gate runs before the Host allowlist; the allowlist still applies to a listed login', async () => {
    const evil = `rebind.example:${s.port}`;
    assertApi401(await request(s.baseUrl, { path: '/api/scenario', headers: { ...NO_LOGIN, host: evil } }), 'foreign Host, no login');
    const r = await request(s.baseUrl, { path: '/api/scenario', headers: { ...as(TEST_OWNER), host: evil } });
    assert.equal(r.status, 403, r.text.slice(0, 200));
  });

  test('/healthz is open without the header', async () => {
    const r = await request(s.baseUrl, { path: '/healthz', headers: NO_LOGIN });
    assert.equal(r.status, 200);
    assert.equal(r.json && r.json.ok, true);
  });

  test('a mutation without the header is refused and changes nothing', async () => {
    const before = await request(s.baseUrl, { path: '/api/scenario' });
    assert.equal(before.status, 200);
    const engineBefore = before.json.live.engine;
    assertApi401(await postJson(s.baseUrl, '/api/engine', { on: !engineBefore }, NO_LOGIN), 'POST /api/engine');
    assert.equal((await request(s.baseUrl, { path: '/api/scenario' })).json.live.engine, engineBefore);
  });

  test('/mcp works with a bearer key and no identity header; the identity header alone is 401', async () => {
    const { key } = await createKey(s.baseUrl, 'Identity test agent');
    const listed = rpcResult(await mcpPost(s.baseUrl, { auth: bearer(key), method: 'tools/list', headers: NO_LOGIN }));
    assert.ok(Array.isArray(listed.tools) && listed.tools.length > 0, 'tools/list answers');
    const refused = await mcpPost(s.baseUrl, { method: 'tools/list', headers: as(TEST_OWNER) });
    assert.equal(refused.status, 401);
    assert.equal(refused.text, UNAUTHORIZED);
  });

  test('GET /api/identity returns the login and Tailscale-User-Name', async () => {
    const r = await request(s.baseUrl, { path: '/api/identity', headers: { ...as(TEST_OWNER), [NAME]: 'Test Owner' } });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.deepEqual(r.json, { identity: { login: TEST_OWNER, name: 'Test Owner' } });
  });

  test('GET /api/identity without a name uses the login as the name; the login is the trimmed header', async () => {
    const plain = await request(s.baseUrl, { path: '/api/identity', headers: as(TEST_OWNER) });
    assert.deepEqual(plain.json, { identity: { login: TEST_OWNER, name: TEST_OWNER } });
    const spaced = await request(s.baseUrl, { path: '/api/identity', headers: { ...as('  Owner@Example.test '), [NAME]: '  Test Owner ' } });
    assert.equal(spaced.status, 200);
    assert.deepEqual(spaced.json, { identity: { login: 'Owner@Example.test', name: 'Test Owner' } });
  });

  test('a listed login on a real store logs no owner-login problem', () => {
    assert.deepEqual(problemLines(s), []);
  });
});

describe('real mode: a login list with spaces and mixed case', () => {
  let s;
  before(async () => {
    s = await spawnServer({ env: { ...REAL, FATHOM_OWNER_LOGINS: ' Second@Example.Test ,\n OWNER@example.TEST , ' } });
  }, T);
  after(async () => { if (s) await s.stop(); });

  test('every listed login matches; others do not', async () => {
    for (const login of [TEST_OWNER, 'second@example.test', 'SECOND@EXAMPLE.TEST']) {
      const r = await request(s.baseUrl, { path: '/api/scenario', headers: as(login) });
      assert.equal(r.status, 200, `${login}: ${r.status}`);
    }
    assertApi401(await request(s.baseUrl, { path: '/api/scenario', headers: as(INTRUDER) }), 'unlisted login');
    assertApi401(await request(s.baseUrl, { path: '/api/scenario', headers: NO_LOGIN }), 'no login');
  });
});

describe('real mode: FATHOM_OWNER_LOGINS unset fails closed', () => {
  let s;
  before(async () => { s = await spawnServer({ env: { ...REAL, FATHOM_OWNER_LOGINS: undefined } }); }, T);
  after(async () => { if (s) await s.stop(); });

  test('startup logs exactly one fathom: line naming FATHOM_OWNER_LOGINS', () => {
    const lines = problemLines(s);
    assert.equal(lines.length, 1, `one problem line, got:\n${s.output()}`);
    assert.ok(lines[0].startsWith('fathom: '), lines[0]);
    assert.match(lines[0], /not set/);
    assert.match(lines[0], /401/);
  });

  test('every page and /api route is 401 even with a header; /healthz is 200', async () => {
    await assertAllClosed(s, as(TEST_OWNER));
  });
});

describe('real mode: a blank login list fails closed', () => {
  let s;
  before(async () => { s = await spawnServer({ env: { ...REAL, FATHOM_OWNER_LOGINS: ' , \n ' } }); }, T);
  after(async () => { if (s) await s.stop(); });

  test('one problem line and every route closed', async () => {
    assert.equal(problemLines(s).length, 1, s.output());
    await assertAllClosed(s, as(TEST_OWNER));
  });
});

describe('real mode: FATHOM_OWNER_LOGINS_FILE', () => {
  let dir;
  before(async () => { dir = await tempDir('fathom-logins-'); });
  after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  async function withFileServer(env, fn) {
    const s = await spawnServer({ env: { ...REAL, FATHOM_OWNER_LOGINS: undefined, ...env } });
    try { return await fn(s); } finally { await s.stop(); }
  }

  test('a file with one login per line admits each listed login', T, async () => {
    const file = join(dir, 'lines.txt');
    writeFileSync(file, `first@example.test\n${TEST_OWNER}\n`);
    await withFileServer({ FATHOM_OWNER_LOGINS_FILE: file }, async s => {
      for (const login of [TEST_OWNER, 'first@example.test', ' First@Example.Test ']) {
        const r = await request(s.baseUrl, { path: '/api/scenario', headers: as(login) });
        assert.equal(r.status, 200, `${login}: ${r.status}`);
      }
      assert.equal((await request(s.baseUrl, { path: '/', headers: as('first@example.test') })).status, 200);
      assertApi401(await request(s.baseUrl, { path: '/api/scenario', headers: as(INTRUDER) }), 'unlisted login');
      assertApi401(await request(s.baseUrl, { path: '/api/scenario', headers: NO_LOGIN }), 'no login');
      assert.deepEqual(problemLines(s), []);
    });
  });

  test('a comma separated file admits each listed login', T, async () => {
    const file = join(dir, 'commas.txt');
    writeFileSync(file, `first@example.test, ${TEST_OWNER}`);
    await withFileServer({ FATHOM_OWNER_LOGINS_FILE: file }, async s => {
      for (const login of [TEST_OWNER, 'first@example.test']) {
        const r = await request(s.baseUrl, { path: '/api/scenario', headers: as(login) });
        assert.equal(r.status, 200, `${login}: ${r.status}`);
      }
      assertApi401(await request(s.baseUrl, { path: '/api/scenario', headers: as(INTRUDER) }), 'unlisted login');
    });
  });

  test('an unreadable file fails closed and the log carries neither the error nor the path', T, async () => {
    const missing = join(dir, 'missing-logins.txt');
    await withFileServer({ FATHOM_OWNER_LOGINS_FILE: missing }, async s => {
      const lines = problemLines(s);
      assert.equal(lines.length, 1, s.output());
      assert.ok(lines[0].startsWith('fathom: '), lines[0]);
      assert.match(lines[0], /could not be read/);
      assert.ok(!s.output().includes('ENOENT'), 'no error message in the log');
      assert.ok(!s.output().includes('missing-logins'), 'no file path in the log');
      await assertAllClosed(s, as(TEST_OWNER));
    });
  });

  test('both FATHOM_OWNER_LOGINS and FATHOM_OWNER_LOGINS_FILE set fails closed', T, async () => {
    const file = join(dir, 'both.txt');
    writeFileSync(file, `${TEST_OWNER}\n`);
    await withFileServer({ FATHOM_OWNER_LOGINS: TEST_OWNER, FATHOM_OWNER_LOGINS_FILE: file }, async s => {
      const lines = problemLines(s);
      assert.equal(lines.length, 1, s.output());
      assert.match(lines[0], /both set/);
      await assertAllClosed(s, as(TEST_OWNER));
    });
  });
});

describe('demo stores are open', () => {
  test('FATHOM_DEMO=1 serves the API and the app without the header; identity is null', T, async () => {
    const s = await spawnServer({ env: { FATHOM_DEMO: '1', FATHOM_ENGINE: 'fake' } });
    try {
      const api = await request(s.baseUrl, { path: '/api/scenario', headers: NO_LOGIN });
      assert.equal(api.status, 200);
      assert.equal(api.json.live.mode, 'demo');
      const page = await request(s.baseUrl, { path: '/', headers: NO_LOGIN });
      assert.equal(page.status, 200);
      assert.match(page.text, /<div id="app"/);
      const id = await request(s.baseUrl, { path: '/api/identity', headers: NO_LOGIN });
      assert.equal(id.status, 200);
      assert.deepEqual(id.json, { identity: null });
      const withHeader = await request(s.baseUrl, { path: '/api/identity', headers: { ...as(TEST_OWNER), [NAME]: 'Test Owner' } });
      assert.deepEqual(withHeader.json, { identity: null }, 'demo ignores the header');
    } finally {
      await s.stop();
    }
  });

  test('FATHOM_DEMO unset on a new dir with no login list: demo store, open, no problem line', T, async () => {
    const s = await spawnServer({ env: { FATHOM_DEMO: undefined, FATHOM_ENGINE: 'fake', FATHOM_OWNER_LOGINS: undefined } });
    try {
      const api = await request(s.baseUrl, { path: '/api/scenario', headers: NO_LOGIN });
      assert.equal(api.status, 200);
      assert.equal(api.json.live.mode, 'demo');
      assert.equal((await request(s.baseUrl, { path: '/', headers: NO_LOGIN })).status, 200);
      assert.deepEqual((await request(s.baseUrl, { path: '/api/identity', headers: NO_LOGIN })).json, { identity: null });
      assert.deepEqual(problemLines(s), [], 'a demo store logs no owner-login problem');
    } finally {
      await s.stop();
    }
  });
});
