// MT-09: household selection and role-aware management through the real session APIs.
//
// One real in-process instance (startServer, fake engine, dev mail outbox as the local mail sink).
// Every person enrolls and signs in through the actual WebAuthn routes with a software
// authenticator (test/helpers/webauthn.mjs); no session is minted for a person after the
// first admin's bootstrap invitation, which stands in for the operator's user-invite command.
// The operator grant and multi_household_enabled are seeded only in this disposable platform DB
// (docs/multi-tenancy.md, Sign-up: tests seed the setting in their own platform DB).
//
// Context assertions (docs/multi-tenancy.md, Active household and switching): household-scoped
// requests carry X-Fathom-Household and X-Fathom-Context-Version (GET/HEAD may use the query
// parameters household and contextVersion). A stale or missing assertion is 409
// household_context_stale before the handler runs; a duplicate, partial, malformed or
// conflicting one is 400 household_context_invalid. Switching accepts only an active membership
// in an active household and rotates the session's context version.
//
// Risk probe (ticket MT-09): switch in one tab while another tab's delayed write and Ask stream
// are in flight; the write is refused as stale and the stream ends with a 409 error event and
// no final event.
//
// All names, addresses and amounts are synthetic.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { src, tempDir } from './helpers/server.mjs';
import { startRuntime, writeInstanceKeys } from './helpers/tenancy-runtime.mjs';
import { browser, register, signIn } from './helpers/tenancy.mjs';
import { createAuthenticator } from './helpers/webauthn.mjs';

const T = { timeout: 120_000 };
const ALPHA = 'ALPHACANARY';
const BRAVO = 'BRAVOCANARY';
const BRAVO_NAME = 'Synthetic Bravo Household';
const STALE = 'household_context_stale';
const INVALID = 'household_context_invalid';
const MEMBERSHIP_REQUIRED = { error: 'household membership required' };

let f;

// --------------------------------------------------------------------------- helpers

// The dev outbox is the local mail sink: every message is one JSON file.
function outbox() {
  const dir = join(f.dataDir, 'outbox');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(n => n.endsWith('.json')).sort().map(n => ({ name: n, ...JSON.parse(readFileSync(join(dir, n), 'utf8')) }));
}

// The enrollment token of the newest message to `email` that is not in `before`.
function mailedToken(before, email) {
  const seen = new Set(before.map(m => m.name));
  const fresh = outbox().filter(m => !seen.has(m.name) && [].concat(m.to).includes(email));
  assert.ok(fresh.length >= 1, `a message reached ${email}`);
  const match = /\/enroll#([A-Za-z0-9_-]{43})/.exec(fresh.at(-1).text);
  assert.ok(match, 'the message carries an enrollment link');
  return match[1];
}

// Assertion headers for an identity (the context a browser was last issued).
const ctxHeaders = identity => ({
  'x-fathom-household': identity.householdId,
  'x-fathom-context-version': String(identity.contextVersion),
});

// A person: their browser (cookie jar), authenticator and current identity.
async function enrollByLink(token, device = createAuthenticator()) {
  const client = browser(f.baseUrl);
  const r = await register(f.baseUrl, client, device, { token });
  assert.equal(r.verify?.status, 200, r.verify?.text ?? r.options.text);
  return { client, device, credentialId: device.credentials()[0].id, identity: r.verify.json.identity };
}

async function session(person) {
  const r = await person.client.get('/api/auth/session');
  assert.equal(r.status, 200, r.text);
  person.identity = r.json.identity;
  return person.identity;
}

const get = (person, path, headers = ctxHeaders(person.identity)) => person.client.raw({ path, headers });
const post = (person, path, body = {}, headers = ctxHeaders(person.identity)) => person.client.post(path, body, headers);

async function ok(promise, label) {
  const r = await promise;
  assert.equal(r.status, 200, `${label}: ${r.status} ${r.text?.slice(0, 300)}`);
  return r.json;
}

const goalTitles = id => f.app.runtimes.get(id).db.prepare('SELECT def FROM goals ORDER BY id').all().map(r => JSON.parse(r.def).title);
const threadTexts = id => f.app.runtimes.get(id).db.prepare("SELECT text FROM messages WHERE role = 'me'").all().map(r => r.text);
const tableCounts = id => {
  const db = f.app.runtimes.get(id).db;
  return Object.fromEntries(['goals', 'conversations', 'messages', 'settings', 'facts', 'files'].map(t => [t, db.prepare(`SELECT count(*) AS n FROM ${t}`).get().n]));
};

// A POST whose headers go out now and whose body is held until release() (a delayed write).
function delayedPost(person, path, body, headers) {
  const url = new URL(f.baseUrl);
  const payload = Buffer.from(JSON.stringify(body));
  const cookie = [...person.client.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  let release;
  const done = new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method: 'POST', path, headers: {
      'content-type': 'application/json', 'content-length': String(payload.length), origin: f.baseUrl, cookie, ...headers,
    } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    req.flushHeaders();
    release = () => req.end(payload);
  });
  return { done, release: () => release() };
}

// An Ask stream: resolves `started` at the first event, `done` with every event once it ends.
function askStream(person, body, headers) {
  const url = new URL(f.baseUrl);
  const payload = Buffer.from(JSON.stringify(body));
  const cookie = [...person.client.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  let onStart;
  const started = new Promise(resolve => { onStart = resolve; });
  const done = new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method: 'POST', path: '/api/threads', headers: {
      'content-type': 'application/json', accept: 'text/event-stream', 'content-length': String(payload.length),
      origin: f.baseUrl, cookie, ...headers,
    } }, res => {
      let buf = '';
      const events = [];
      const drain = () => {
        let at;
        while ((at = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, at);
          buf = buf.slice(at + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (name) { events.push({ name, data: data ? JSON.parse(data) : null }); onStart(events); }
        }
      };
      res.on('data', c => { buf += c.toString('utf8'); drain(); });
      const end = () => { drain(); onStart(events); resolve({ status: res.statusCode, headers: res.headers, events }); };
      res.on('end', end);
      res.on('close', end);
      res.on('error', end);
    });
    req.on('error', reject);
    req.end(payload);
  });
  return { started, done };
}

// --------------------------------------------------------------------------- fixture

before(async () => {
  const root = await tempDir('fathom-mt09-');
  const dataDir = join(root, 'data');
  const keys = writeInstanceKeys(join(root, 'keys'));
  // A slow fake stream keeps an Ask answer in flight long enough to switch during it.
  const server = await startRuntime({ dataDir, keys, engine: 'fake', extra: { FATHOM_FAKE_STREAM_MS: '200' } });
  const { createAuthStore } = await src('src/auth/store.mjs');
  const platform = server.app.platform;
  const store = createAuthStore(platform);
  const A = platform.prepare('SELECT id FROM households WHERE serves_store = 1').get().id;
  f = { root, dataDir, keys, server, app: server.app, baseUrl: server.baseUrl, platform, store, A };
  // Bootstrap: the operator's user-invite command issues the first admin's invitation.
  const boot = store.invite(A, 'alpha-admin@example.test', { role: 'admin' });
  f.alpha = await enrollByLink(boot.token);
  store.grantOperator(f.alpha.identity.id);
  store.setPlatformSetting('multi_household_enabled', true);
  await session(f.alpha);
});

// A refused stream's handler still finishes and stores its turn in the household it started in
// (src/api/handlers.mjs stores the question with its answer); wait for those turns before closing.
const STREAMED = ['Synthetic delayed stream question', 'Synthetic stream at sign out', 'Synthetic stream before removal', 'Synthetic stream at removal'];
async function answersSettled() {
  const stored = () => [f.A, f.B].filter(Boolean).flatMap(id => threadTexts(id));
  for (let i = 0; i < 150 && !STREAMED.every(q => stored().includes(q)); i++) await new Promise(r => setTimeout(r, 100));
}

after(async () => {
  if (f) await answersSettled();
  await f?.server.close();
  if (f?.root) rmSync(f.root, { recursive: true, force: true });
});

// --------------------------------------------------------------------------- tests

describe('enrollment, invitations and operator provisioning', () => {
  test('an operator provisions a household whose first admin enrolls from the emailed link', T, async () => {
    assert.equal(f.alpha.identity.contextVersion, 1, 'a new session starts at context version 1');
    assert.deepEqual(f.alpha.identity.memberships, [{ householdId: f.A, role: 'admin', name: null }]);
    const before = outbox();
    const made = await ok(f.alpha.client.post('/api/operator/households', { displayName: BRAVO_NAME, adminEmail: 'bravo-admin@example.test' }), 'provision');
    assert.equal(made.household.status, 'provisioning');
    f.B = made.household.id;
    f.bravo = await enrollByLink(mailedToken(before, 'bravo-admin@example.test'));
    assert.equal(f.bravo.identity.householdId, f.B);
    assert.equal(f.bravo.identity.role, 'admin');
    assert.deepEqual(f.bravo.identity.memberships, [{ householdId: f.B, role: 'admin', name: BRAVO_NAME }]);
    assert.equal(f.platform.prepare('SELECT status FROM households WHERE id = ?').get(f.B).status, 'active');
    await ok(post(f.bravo, '/api/household/outbound', { engine: true }), 'B resumes its engine');
    await ok(post(f.alpha, '/api/goals', { title: `${ALPHA} cushion`, horizon: '1-3y' }), 'A goal');
    await ok(post(f.bravo, '/api/goals', { title: `${BRAVO} cushion`, horizon: '1-3y' }), 'B goal');
  });

  test('a member enrolls in one household, then accepts an invitation to another without any data copied', T, async () => {
    let before = outbox();
    await ok(post(f.alpha, '/api/admin/users/invite', { email: 'both-member@example.test', role: 'member' }), 'A invites');
    f.dual = await enrollByLink(mailedToken(before, 'both-member@example.test'));
    assert.equal(f.dual.identity.householdId, f.A);
    const bBefore = tableCounts(f.B);
    const aBefore = tableCounts(f.A);
    before = outbox();
    await ok(post(f.bravo, '/api/admin/users/invite', { email: 'both-member@example.test', role: 'member' }), 'B invites the existing user');
    const token = mailedToken(before, 'both-member@example.test');
    // Following the link alone never replaces the account's passkeys.
    const replace = await browser(f.baseUrl).post('/api/auth/register/options', { token, name: 'Another device' });
    assert.equal(replace.status, 410, replace.text);
    const accepted = await ok(f.dual.client.post('/api/auth/invitations/accept', { token }), 'accept');
    assert.deepEqual(accepted.identity.memberships, [
      { householdId: f.A, role: 'member', name: null },
      { householdId: f.B, role: 'member', name: BRAVO_NAME },
    ]);
    assert.equal(accepted.identity.householdId, f.A, 'accepting keeps the session in its household');
    assert.equal(accepted.identity.contextVersion, 1, 'accepting does not switch');
    assert.deepEqual(tableCounts(f.B), bBefore, 'nothing was copied into B');
    assert.deepEqual(tableCounts(f.A), aBefore, 'nothing changed in A');
    await session(f.dual);
    const scenario = await get(f.dual, '/api/scenario');
    assert.equal(scenario.status, 200);
    assert.ok(scenario.text.includes(ALPHA) && !scenario.text.includes(BRAVO), 'the session still reads only A');
  });

  test('a member cannot provision and a second real household stays gated without the platform setting', T, async () => {
    const refused = await f.dual.client.post('/api/operator/households', { displayName: 'Synthetic Charlie Household', adminEmail: 'charlie@example.test' });
    assert.equal(refused.status, 403);
    f.store.setPlatformSetting('multi_household_enabled', false);
    try {
      const gated = await f.alpha.client.post('/api/operator/households', { displayName: 'Synthetic Charlie Household', adminEmail: 'charlie@example.test' });
      assert.equal(gated.status, 409);
      assert.equal(gated.json.code, 'multi_household_gated');
    } finally { f.store.setPlatformSetting('multi_household_enabled', true); }
  });
});

describe('context assertions', () => {
  test('every household-scoped request needs the exact current assertion before the handler runs', T, async () => {
    const id = await session(f.alpha);
    const goals = goalTitles(f.A).length;
    // Liveness: the exact assertion reads and writes.
    const read = await get(f.alpha, '/api/scenario');
    assert.equal(read.status, 200);
    assert.equal(read.headers['x-fathom-household'], f.A, 'the response names its captured household');
    assert.equal(read.headers['x-fathom-context-version'], '1');
    const query = await f.alpha.client.raw({ path: `/api/scenario?household=${encodeURIComponent(f.A)}&contextVersion=1`, headers: {} });
    assert.equal(query.status, 200, 'GET may assert through the query');
    // Missing, wrong household, wrong version: 409 stale, nothing written.
    for (const [label, headers] of [
      ['missing', { 'x-fathom-household': undefined, 'x-fathom-context-version': undefined }],
      ['foreign household', { 'x-fathom-household': f.B, 'x-fathom-context-version': '1' }],
      ['another version', { 'x-fathom-household': f.A, 'x-fathom-context-version': '3' }],
      ['newer version', { 'x-fathom-household': f.A, 'x-fathom-context-version': '2' }],
    ]) {
      const w = await post(f.alpha, '/api/goals', { title: `${ALPHA} ${label}`, horizon: '1-3y' }, headers);
      assert.equal(w.status, 409, `${label} write: ${w.text}`);
      assert.equal(w.json.code, STALE);
      const r = await get(f.alpha, '/api/scenario', headers);
      assert.equal(r.status, 409, `${label} read`);
      const head = await f.alpha.client.raw({ method: 'HEAD', path: '/api/scenario', headers });
      assert.equal(head.status, 409, `${label} HEAD`);
    }
    assert.equal(goalTitles(f.A).length, goals, 'no refused write landed');
    // Malformed, partial, duplicate and conflicting assertions: 400.
    for (const [label, path, headers] of [
      ['partial', '/api/scenario', { 'x-fathom-household': f.A }],
      ['malformed version', '/api/scenario', { 'x-fathom-household': f.A, 'x-fathom-context-version': 'one' }],
      ['malformed household', '/api/scenario', { 'x-fathom-household': '../hh', 'x-fathom-context-version': '1' }],
      ['duplicate query', `/api/scenario?household=${f.A}&household=${f.A}&contextVersion=1`, {}],
      ['conflicting header and query', `/api/scenario?household=${f.B}&contextVersion=1`, ctxHeaders(id)],
    ]) {
      const r = await f.alpha.client.raw({ path, headers });
      assert.equal(r.status, 400, `${label}: ${r.text}`);
      assert.equal(r.json.code, INVALID, label);
    }
    const dup = await rawDuplicateHeader(f.alpha, f.A);
    assert.equal(dup.status, 400, 'a repeated assertion header');
    const postQuery = await f.alpha.client.post(`/api/goals?household=${f.A}&contextVersion=1`, { title: `${ALPHA} query`, horizon: '1-3y' }, {});
    assert.equal(postQuery.status, 400, 'a POST asserts only through headers');
    // Anonymous stays 401 and a nonmember stays 403 ahead of any assertion check.
    assert.equal((await browser(f.baseUrl).raw({ path: '/api/scenario', headers: ctxHeaders(id) })).status, 401);
    // Auth and operator routes take no assertion.
    assert.equal((await f.alpha.client.get('/api/auth/session')).status, 200);
  });

  test('an admin route with a stale assertion changes nothing', T, async () => {
    const before = f.platform.prepare('SELECT count(*) AS n FROM household_invitations').get().n;
    const r = await post(f.alpha, '/api/admin/users/invite', { email: 'stale-invite@example.test', role: 'member' },
      { 'x-fathom-household': f.A, 'x-fathom-context-version': '7' });
    assert.equal(r.status, 409);
    assert.equal(r.json.code, STALE);
    assert.equal(f.platform.prepare('SELECT count(*) AS n FROM household_invitations').get().n, before);
  });
});

async function rawDuplicateHeader(person, household) {
  const url = new URL(f.baseUrl);
  const cookie = [...person.client.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method: 'GET', path: '/api/scenario', headers: [
      'cookie', cookie, 'x-fathom-household', household, 'x-fathom-household', household, 'x-fathom-context-version', '1',
    ] }, res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode })); });
    req.on('error', reject);
    req.end();
  });
}

describe('switching', () => {
  test('switching rotates the context and reads only the selected household', T, async () => {
    const old = await session(f.dual);
    const r = await ok(f.dual.client.post('/api/auth/household', { householdId: f.B }), 'switch');
    assert.deepEqual(r.household, { id: f.B, name: BRAVO_NAME, role: 'member' });
    assert.equal(r.identity.householdId, f.B);
    assert.equal(r.identity.contextVersion, old.contextVersion + 1);
    const stale = await get(f.dual, '/api/scenario', ctxHeaders(old));
    assert.equal(stale.status, 409, 'the old tab is stale');
    f.dual.identity = r.identity;
    const now = await get(f.dual, '/api/scenario');
    assert.equal(now.status, 200);
    assert.ok(now.text.includes(BRAVO) && !now.text.includes(ALPHA), 'the session reads only B');
    assert.equal(now.headers['x-fathom-household'], f.B);
    // Switching back rotates again.
    const back = await ok(f.dual.client.post('/api/auth/household', { householdId: f.A }), 'switch back');
    assert.equal(back.identity.contextVersion, old.contextVersion + 2);
    f.dual.identity = back.identity;
  });

  test('only an active membership in an active household can be selected, with one generic refusal', T, async () => {
    const id = await session(f.dual);
    const made = await ok(f.alpha.client.post('/api/operator/households', { displayName: 'Synthetic Charlie Household', adminEmail: 'charlie-admin@example.test' }), 'provision C');
    f.C = made.household.id;
    for (const [label, householdId] of [['foreign', f.C], ['unknown', 'hh-00000000-0000-4000-8000-000000000000']]) {
      const r = await f.dual.client.post('/api/auth/household', { householdId });
      assert.equal(r.status, 403, label);
      assert.deepEqual(r.json, MEMBERSHIP_REQUIRED, `${label} refusal is generic`);
    }
    assert.equal((await f.dual.client.post('/api/auth/household', { householdId: 42 })).status, 400);
    assert.equal((await f.dual.client.post('/api/auth/household', {})).status, 400);
    assert.equal((await browser(f.baseUrl).post('/api/auth/household', { householdId: f.A })).status, 401);
    // A suspended household cannot be selected.
    f.platform.prepare("UPDATE households SET status = 'suspended' WHERE id = ?").run(f.B);
    try {
      const r = await f.dual.client.post('/api/auth/household', { householdId: f.B });
      assert.equal(r.status, 403);
      assert.deepEqual(r.json, MEMBERSHIP_REQUIRED);
    } finally { f.platform.prepare("UPDATE households SET status = 'active' WHERE id = ?").run(f.B); }
    assert.deepEqual(await session(f.dual), id, 'refused switches changed nothing');
  });

  test('risk probe: a switch in one tab refuses the other tab\'s delayed write and drops its stream', T, async () => {
    const old = await session(f.dual);
    assert.equal(old.householdId, f.A);
    // Liveness: the same delayed write lands when nothing switches.
    const fine = delayedPost(f.dual, '/api/goals', { title: `${ALPHA} delayed ok`, horizon: '1-3y' }, ctxHeaders(old));
    await new Promise(r => setTimeout(r, 100));
    fine.release();
    assert.equal((await fine.done).status, 200);
    assert.ok(goalTitles(f.A).includes(`${ALPHA} delayed ok`));

    const aGoals = goalTitles(f.A);
    const bGoals = goalTitles(f.B);
    const bTexts = threadTexts(f.B);
    const write = delayedPost(f.dual, '/api/goals', { title: `${ALPHA} delayed stale`, horizon: '1-3y' }, ctxHeaders(old));
    const stream = askStream(f.dual, { text: 'Synthetic delayed stream question' }, ctxHeaders(old));
    const first = await stream.started;
    assert.ok(first.length >= 1 && first[0].name !== 'error', `the stream started: ${JSON.stringify(first)}`);
    // Tab 2 switches.
    const switched = await ok(browser(f.baseUrl, Object.fromEntries(f.dual.client.jar)).post('/api/auth/household', { householdId: f.B }), 'switch in tab 2');
    assert.equal(switched.identity.householdId, f.B);
    write.release();
    const refused = await write.done;
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.json.code, STALE);
    const ended = await stream.done;
    const names = ended.events.map(e => e.name);
    assert.ok(!names.includes('final'), `the stream had no final event: ${names.join(',')}`);
    const error = ended.events.find(e => e.name === 'error');
    assert.ok(error, `the stream ended with an error event: ${names.join(',')}`);
    assert.equal(error.data.status, 409);
    assert.deepEqual(goalTitles(f.A), aGoals, 'the refused write did not land in A');
    assert.deepEqual(goalTitles(f.B), bGoals, 'nor in B');
    assert.deepEqual(threadTexts(f.B), bTexts, 'the old stream wrote nothing into B');
    f.dual.identity = switched.identity;
  });

  test('signing out ends the session\'s streams and a new sign-in starts at the single household again', T, async () => {
    const id = await session(f.dual);
    const stream = askStream(f.dual, { text: 'Synthetic stream at sign out' }, ctxHeaders(id));
    await stream.started;
    await ok(f.dual.client.post('/api/auth/signout', {}), 'sign out');
    const ended = await stream.done;
    assert.ok(!ended.events.some(e => e.name === 'final'), 'the stream had no final event');
    // A fresh sign-in with two memberships has no household until one is chosen.
    const again = await signIn(f.baseUrl, f.dual.device, f.dual.credentialId);
    assert.equal(again.verify.status, 200, again.verify.text);
    f.dual.client = again.client;
    const fresh = await session(f.dual);
    assert.equal(fresh.householdId, null, 'multi-membership users choose after login');
    assert.equal(fresh.memberships.length, 2);
    const blocked = await f.dual.client.raw({ path: '/api/scenario', headers: {} });
    assert.equal(blocked.status, 403);
    const chosen = await ok(f.dual.client.post('/api/auth/household', { householdId: f.B }), 'choose');
    f.dual.identity = chosen.identity;
    assert.equal((await get(f.dual, '/api/scenario')).status, 200);
  });
});

describe('role-aware management', () => {
  test('a member cannot manage people, the engine or outbound work; an admin can, only in its own household', T, async () => {
    const member = await session(f.dual);
    assert.equal(member.householdId, f.B);
    assert.equal(member.role, 'member');
    for (const [path, body] of [
      ['/api/admin/users/invite', { email: 'member-invite@example.test', role: 'member' }],
      [`/api/admin/users/${f.bravo.identity.id}/role`, { role: 'member' }],
      [`/api/admin/users/${f.bravo.identity.id}/remove`, {}],
      ['/api/engine', { on: false }],
      ['/api/engine/cap', { usd: 1 }],
      ['/api/household/outbound', { jobs: true }],
    ]) {
      const r = await post(f.dual, path, body);
      assert.equal(r.status, 403, `${path}: ${r.text}`);
    }
    assert.equal((await get(f.dual, '/api/admin/users')).status, 403);
    // Liveness: the member still reads and writes the household's financial state.
    await ok(post(f.dual, '/api/goals', { title: `${BRAVO} member goal`, horizon: '1-3y' }), 'member writes a goal');
    // B's admin manages B's people and engine.
    await session(f.bravo);
    const people = await ok(get(f.bravo, '/api/admin/users'), 'B people');
    assert.deepEqual(people.users.map(u => u.email).sort(), ['both-member@example.test', 'bravo-admin@example.test']);
    await ok(post(f.bravo, '/api/engine/cap', { usd: 12 }), 'B admin sets the cap');
    await ok(post(f.bravo, '/api/engine', { on: true }), 'B admin turns the engine on');
    const promoted = await ok(post(f.bravo, `/api/admin/users/${member.id}/role`, { role: 'admin' }), 'promote');
    assert.equal(promoted.user.role, 'admin');
    assert.equal((await session(f.dual)).role, 'admin', 'the role applies to the current household');
    assert.equal(f.store.membership(member.id, f.A).role, 'member', 'the role in A is unchanged');
    await ok(post(f.bravo, `/api/admin/users/${member.id}/role`, { role: 'member' }), 'demote');
    // B's admin cannot reach A's people.
    const foreign = await post(f.bravo, `/api/admin/users/${f.alpha.identity.id}/role`, { role: 'member' });
    assert.equal(foreign.status, 404);
    assert.equal(f.store.membership(f.alpha.identity.id, f.A).role, 'admin');
  });

  test('removal from one household leaves the other membership usable', T, async () => {
    const member = await session(f.dual);
    // Liveness: an Ask stream nobody revokes ends with its final event.
    const whole = await askStream(f.dual, { text: 'Synthetic stream before removal' }, ctxHeaders(member)).done;
    assert.ok(whole.events.some(e => e.name === 'final'), `an unrevoked stream finishes: ${whole.events.map(e => e.name).join(',')}`);
    // A stream in flight at removal ends without B's later data: the admin's new goal never reaches it.
    const stream = askStream(f.dual, { text: 'Synthetic stream at removal' }, ctxHeaders(member));
    await stream.started;
    await ok(post(f.bravo, `/api/admin/users/${member.id}/remove`, {}), 'B removes the member');
    await ok(post(f.bravo, '/api/goals', { title: `${BRAVO} after removal`, horizon: '1-3y' }), 'B admin writes after the removal');
    const cut = await stream.done;
    const cutNames = cut.events.map(e => e.name);
    assert.ok(!cutNames.includes('final'), `the removed member's stream had no final event: ${cutNames.join(',')}`);
    assert.equal(cut.events.find(e => e.name === 'error')?.data.status, 401, `the stream ended signed out: ${cutNames.join(',')}`);
    assert.ok(!JSON.stringify(cut.events).includes(`${BRAVO} after removal`), 'the removed member never saw the new goal');
    assert.equal((await get(f.dual, '/api/scenario')).status, 401, 'removal signs the member out');
    const again = await signIn(f.baseUrl, f.dual.device, f.dual.credentialId);
    assert.equal(again.verify.status, 200);
    f.dual.client = again.client;
    const id = await session(f.dual);
    assert.equal(id.householdId, f.A, 'the remaining membership is entered directly');
    assert.deepEqual(id.memberships, [{ householdId: f.A, role: 'member', name: null }]);
    assert.equal((await f.dual.client.post('/api/auth/household', { householdId: f.B })).status, 403);
    const scenario = await get(f.dual, '/api/scenario');
    assert.equal(scenario.status, 200);
    assert.ok(!scenario.text.includes(BRAVO));
  });
});
