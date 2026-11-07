// MT-03 AC3: an admin can inspect and resume the migrated household through
// /api/household/outbound; a member cannot change flags; unavailable credentials or funding never
// become an implicit bypass.
//
// The household is the real migration's output (test/helpers/tenancy-runtime.mjs
// buildMigrationFixture, then migrateTenancy), so it starts with the all-paused outbound row the
// migration writes. Admin and member sessions are created after migration through the auth store.
// The cases run in order against one in-process server, restarted with another env where a case
// needs one (sessions live in the platform DB and survive a restart).
//
// Assumptions (the plan is silent):
// 1. While jobs are resumed the scheduler may run on its own; jobs are paused again before the
//    cases that count outbox files or spend rows, so no background run races those counts.
// 2. With the engine refused, an Ask still completes as a notice reply (message.notice true), the
//    way an engine-off or over-cap answer does today; the budget refusal's notice mentions the budget.
// 3. A refused live round surfaces as ModelCallError with code 'funding_unavailable' from the
//    household runtime engine's call(), with no spend_ledger row.
// 4. createEngine's `allowed` option is a function returning a boolean, checked before every round.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { src, tempDir, createSessionFixture, sessionClient } from './helpers/server.mjs';
import { aggregatorCsv } from './helpers/ingest.mjs';
import {
  PAUSED, ADMIN_REQUIRED, OUTBOUND_KINDS, buildMigrationFixture, runMigration, startRuntime, withSqlite, uploadFiles, writePrivate,
  twoHouseholds,
} from './helpers/tenancy-runtime.mjs';

const T = { timeout: 300_000 };
const ALL_PAUSED = Object.freeze(Object.fromEntries(OUTBOUND_KINDS.map(k => [k, PAUSED])));
const RESUMED = Object.freeze({ enabled: true, effective: true, reason: null });
const pause = ms => new Promise(r => setTimeout(r, ms));

let scratch;
let fx;
let server;
let admin;
let member;
let hh;

async function restart({ engine = 'fake', extra = {} } = {}) {
  await server?.close();
  server = await startRuntime({ dataDir: fx.dataDir, keys: fx.keys, engine, extra: { FATHOM_EMAIL_TO: fx.admin.email, ...extra } });
  admin.client = sessionClient(server.baseUrl, admin.session);
  member.client = sessionClient(server.baseUrl, member.session);
}

const storeFile = () => join(fx.dataDir, 'households', hh, 'fathom.sqlite');
const count = (sql, ...args) => withSqlite(storeFile(), db => db.prepare(sql).get(...args).n);
const spendRows = () => count('SELECT count(*) AS n FROM spend_ledger');
const outboxDir = () => join(fx.dataDir, 'households', hh, 'outbox');
const outboxFiles = () => (existsSync(outboxDir()) ? readdirSync(outboxDir()).filter(n => !n.startsWith('.')).sort() : []);
const flagsRow = () => ({ ...server.app.platform.prepare('SELECT jobs, email, simplefin, engine FROM household_outbound WHERE household_id = ?').get(hh) });

async function outbound(client) {
  const r = await client.request({ path: '/api/household/outbound' });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  return r.json.outbound;
}

async function setFlags(body) {
  const r = await admin.client.postJson('/api/household/outbound', body);
  assert.equal(r.status, 200, r.text.slice(0, 300));
  return r.json.outbound;
}

async function ask(text) {
  const r = await admin.client.postJson('/api/threads', { text });
  assert.equal(r.status, 200, r.text.slice(0, 300));
  return r.json.message;
}

before(async () => {
  scratch = await tempDir('fathom-mt03-outbound-');
  fx = await buildMigrationFixture(join(scratch, 'fx'));
  const migrated = await runMigration(fx);
  assert.equal(migrated.status, 'complete');
  hh = fx.householdId;
  server = await startRuntime({ dataDir: fx.dataDir, keys: fx.keys, extra: { FATHOM_EMAIL_TO: fx.admin.email } });
  admin = { session: await createSessionFixture(server.app.platform, { email: fx.admin.email }) };
  member = { session: await createSessionFixture(server.app.platform, { email: fx.member.email, role: 'member' }) };
  assert.equal(admin.session.role, 'admin');
  assert.equal(member.session.role, 'member');
  admin.client = sessionClient(server.baseUrl, admin.session);
  member.client = sessionClient(server.baseUrl, member.session);
});

after(async () => {
  await server?.close();
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('the migrated household starts paused and resumes only explicitly', T, () => {
  test('member and admin both see every kind paused', async () => {
    assert.deepEqual(await outbound(member.client), ALL_PAUSED);
    assert.deepEqual(await outbound(admin.client), ALL_PAUSED);
    assert.deepEqual(flagsRow(), { jobs: 0, email: 0, simplefin: 0, engine: 0 });
  });

  test('a member cannot change flags', async () => {
    const r = await member.client.postJson('/api/household/outbound', { jobs: true });
    assert.equal(r.status, 403);
    assert.deepEqual(r.json, ADMIN_REQUIRED);
    assert.deepEqual(await outbound(admin.client), ALL_PAUSED);
    assert.deepEqual(flagsRow(), { jobs: 0, email: 0, simplefin: 0, engine: 0 });
  });

  test('bad bodies are 400 and change nothing', async () => {
    for (const body of [{ jobs: true, bogus: true }, { jobs: 'yes' }, { jobs: 1 }, '[true]', '[{"jobs":true}]', { engine: null }]) {
      const r = await admin.client.postJson('/api/household/outbound', body);
      assert.equal(r.status, 400, `${JSON.stringify(body)} -> ${r.status}`);
      assert.equal(typeof r.json?.error, 'string');
    }
    assert.deepEqual(flagsRow(), { jobs: 0, email: 0, simplefin: 0, engine: 0 });
  });

  test('while paused: manual jobs 409, uploads import with no job run, email records paused, SimpleFIN 409, Ask spends nothing', async () => {
    const run = await admin.client.postJson('/api/jobs/freshness/run', {});
    assert.equal(run.status, 409);
    assert.deepEqual(run.json, { error: 'outbound jobs are paused' });

    const runs = count('SELECT count(*) AS n FROM job_runs');
    const up = await uploadFiles(server.baseUrl, admin.session, [{ name: 'synthetic-paused.csv', bytes: Buffer.from(aggregatorCsv([
      { date: '2026-10-20', amount: '33.10', description: 'Synthetic paused row', account: 'Synthetic paused checking', number: '5550004444' },
    ])) }]);
    assert.equal(up.status, 200, up.text.slice(0, 300));
    assert.equal(up.json.files[0].status, 'imported');
    await pause(750);
    assert.equal(count('SELECT count(*) AS n FROM job_runs'), runs, 'no job run was created');

    const outboxBefore = outboxFiles();
    const sendsBefore = count('SELECT count(*) AS n FROM email_sends');
    const sent = await admin.client.postJson('/api/email/test', {});
    assert.equal(sent.status, 200, sent.text.slice(0, 300));
    assert.equal(sent.json.send.status, 'failed');
    assert.equal(sent.json.send.errorCode, 'paused');
    assert.equal(count('SELECT count(*) AS n FROM email_sends'), sendsBefore + 1, 'the refused send is recorded');
    assert.deepEqual(outboxFiles(), outboxBefore, 'nothing written to the household outbox');

    const token = Buffer.from('https://sfin.example.invalid/simplefin/claim/synthetic', 'utf8').toString('base64');
    const connect = await admin.client.postJson('/api/simplefin/connect', { token });
    assert.equal(connect.status, 409, connect.text.slice(0, 200));

    const spend = spendRows();
    const message = await ask('Synthetic paused question');
    assert.equal(message.notice, true, 'engine paused behaves as engine off');
    assert.equal(spendRows(), spend, 'no spend_ledger row');
  });

  test('an admin resumes one kind; omitted kinds keep their state, and the change is audited', async () => {
    const body = await setFlags({ jobs: true });
    assert.deepEqual(body.jobs, RESUMED);
    for (const k of ['email', 'simplefin', 'engine']) assert.deepEqual(body[k], PAUSED, k);
    assert.deepEqual(await outbound(member.client), body, 'members see the same state');
    assert.deepEqual(flagsRow(), { jobs: 1, email: 0, simplefin: 0, engine: 0 });
    const audited = server.app.platform.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'household.outbound' AND household_id = ? AND outcome = 'ok'").get(hh).n;
    assert.ok(audited >= 1);
  });

  test('resumed jobs run; paused again they refuse', async () => {
    const run = await admin.client.postJson('/api/jobs/freshness/run', {});
    assert.equal(run.status, 200, run.text.slice(0, 300));
    assert.equal(run.json.run.status, 'ok');
    const body = await setFlags({ jobs: false });
    assert.deepEqual(body.jobs, PAUSED);
    assert.equal((await admin.client.postJson('/api/jobs/freshness/run', {})).status, 409);
  });

  test('resumed email delivers to an enrolled member only; an unverified recipient never sends', async () => {
    const body = await setFlags({ email: true });
    assert.deepEqual(body.email, RESUMED);
    const before = outboxFiles();
    const sent = await admin.client.postJson('/api/email/test', {});
    assert.equal(sent.status, 200);
    assert.equal(sent.json.send.status, 'sent', JSON.stringify(sent.json.send));
    assert.equal(outboxFiles().length, before.length + 1, 'one message in households/<id>/outbox');

    await restart({ extra: { FATHOM_EMAIL_TO: 'outsider@example.test' } });
    assert.deepEqual((await outbound(admin.client)).email, { enabled: true, effective: false, reason: 'recipient_unverified' });
    const unverifiedBefore = outboxFiles();
    const refused = await admin.client.postJson('/api/email/test', {});
    assert.equal(refused.status, 200);
    assert.equal(refused.json.send.status, 'failed');
    assert.equal(refused.json.send.errorCode, 'recipient_unverified');
    assert.deepEqual(outboxFiles(), unverifiedBefore);
  });

  test('live engine with a missing credential: credential_unavailable, and Ask refuses', async () => {
    await restart({ engine: 'live', extra: { FATHOM_CLAUDE_CREDENTIAL_FILE: join(scratch, 'absent', 'credential') } });
    const { createAuthStore } = await src('src/auth/store.mjs');
    createAuthStore(server.app.platform).setPlatformSetting('instance_model_cap_usd', 50);
    const body = await setFlags({ engine: true });
    assert.deepEqual(body.engine, { enabled: true, effective: false, reason: 'credential_unavailable' });
    const spend = spendRows();
    assert.equal((await ask('Synthetic credential question')).notice, true);
    assert.equal(spendRows(), spend);
  });

  test('live engine with a credential and a household cap but no instance funding: funding_unavailable, refused before dispatch', async () => {
    const credential = writePrivate(join(scratch, 'credential', 'synthetic-credential'), 'synthetic-credential-not-valid\n');
    await restart({ engine: 'live', extra: { FATHOM_CLAUDE_CREDENTIAL_FILE: credential } });
    server.app.platform.prepare("DELETE FROM platform_settings WHERE key = 'instance_model_cap_usd'").run();
    assert.equal((await admin.client.postJson('/api/engine/cap', { usd: 25 })).status, 200);
    assert.deepEqual((await outbound(admin.client)).engine, { enabled: true, effective: false, reason: 'funding_unavailable' });
    const spend = spendRows();
    assert.equal((await ask('Synthetic funding question')).notice, true);
    const engine = server.app.runtimes.get(hh).engine;
    assert.equal(engine.isOn(), false, 'live mode without funding is off');
    await assert.rejects(engine.call({ purpose: 'chat', messages: [{ role: 'user', content: 'Synthetic' }] }), err => {
      assert.equal(err.name, 'ModelCallError');
      assert.equal(err.code, 'funding_unavailable');
      return true;
    });
    assert.equal(spendRows(), spend, 'no round was dispatched or recorded');
  });

  test('fake engine with a zero household cap: funding_exhausted, and Ask refuses with the budget notice', async () => {
    await restart({ engine: 'fake' });
    assert.equal((await admin.client.postJson('/api/engine/cap', { usd: 0 })).status, 200);
    assert.deepEqual((await outbound(admin.client)).engine, { enabled: true, effective: false, reason: 'funding_exhausted' });
    const spend = spendRows();
    const message = await ask('Synthetic budget question');
    assert.equal(message.notice, true);
    assert.match(JSON.stringify(message), /budget/i);
    assert.equal(spendRows(), spend);
    assert.equal((await admin.client.postJson('/api/engine/cap', { usd: 200 })).status, 200);
    assert.deepEqual((await outbound(admin.client)).engine, RESUMED, 'with budget the resumed engine is effective');
  });

  test('SimpleFIN enabled but not connected is not effective', async () => {
    assert.equal((await admin.client.postJson('/api/simplefin/disconnect', {})).status, 200);
    const body = await setFlags({ simplefin: true });
    assert.deepEqual(body.simplefin, { enabled: true, effective: false, reason: 'not_connected' });
  });

  test('suspension wins over every enabled flag, and the flags survive it', async () => {
    const all = await setFlags({ jobs: true, email: true, simplefin: true, engine: true });
    for (const k of OUTBOUND_KINDS) assert.equal(all[k].enabled, true, k);
    const platform = server.app.platform;
    platform.prepare("UPDATE households SET status = 'suspended' WHERE id = ?").run(hh);
    try {
      assert.equal((await admin.client.request({ path: '/api/scenario' })).status, 403);
      assert.equal((await admin.client.request({ path: '/api/household/outbound' })).status, 403);
      assert.equal((await admin.client.postJson('/api/household/outbound', { jobs: false })).status, 403);
      assert.equal((await admin.client.postJson('/api/threads', { text: 'Synthetic suspended question' })).status, 403);
      const guard = (await src('src/platform/outbound.mjs')).outboundGuard(platform, hh);
      for (const k of OUTBOUND_KINDS) assert.equal(guard.enabled(k), false, `${k} is never enabled while suspended`);
    } finally {
      platform.prepare("UPDATE households SET status = 'active' WHERE id = ?").run(hh);
    }
    const back = await outbound(admin.client);
    for (const k of OUTBOUND_KINDS) assert.equal(back[k].enabled, true, `${k} kept its value`);
    assert.deepEqual(flagsRow(), { jobs: 1, email: 1, simplefin: 1, engine: 1 });
  });
});

test('pausing between engine rounds stops the next round', T, async () => {
  const { createEngine, createMemoryLedger, EngineOffError } = await src('src/engine/index.mjs');
  let allowed = true;
  const ledger = createMemoryLedger();
  const probe = {
    name: 'synthetic_probe', description: 'Synthetic probe tool.', kind: 'read', operations: [{ name: 'read', scope: 'read' }],
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => { allowed = false; return { ok: true }; },
  };
  const engine = createEngine({ mode: 'fake', ledger, capUsd: 10, allowed: () => allowed });
  const events = [];
  await assert.rejects(engine.call({
    purpose: 'chat', messages: [{ role: 'user', content: 'Synthetic' }], tools: [probe],
    fake: [{ toolCalls: [{ name: 'synthetic_probe', args: {} }] }, { text: 'Synthetic second round.' }],
    onEvent: e => events.push(e),
  }), err => err instanceof EngineOffError);
  assert.equal(allowed, false, 'the first round ran its tool');
  assert.equal(ledger.entries.length, 1, 'only the first round was executed and recorded');
  assert.ok(!events.some(e => e.type === 'text' && /second round/.test(e.text)), 'the second round streamed nothing');

  // Liveness: the same script runs both rounds while allowed stays true.
  const open = createEngine({ mode: 'fake', ledger: createMemoryLedger(), capUsd: 10, allowed: () => true });
  const done = await open.call({
    purpose: 'chat', messages: [{ role: 'user', content: 'Synthetic' }], tools: [{ ...probe, handler: () => ({ ok: true }) }],
    fake: [{ toolCalls: [{ name: 'synthetic_probe', args: {} }] }, { text: 'Synthetic second round.' }],
  });
  assert.equal(done.text, 'Synthetic second round.');
});

test('changing one household\'s flags leaves another household\'s row untouched', T, async () => {
  const two = await twoHouseholds();
  try {
    const rowOf = id => ({ ...two.platform.prepare('SELECT * FROM household_outbound WHERE household_id = ?').get(id) });
    const before = rowOf(two.B.id);
    const r = await two.A.client.postJson('/api/household/outbound', { email: false });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.equal(r.json.outbound.email.enabled, false);
    assert.equal(rowOf(two.A.id).email, 0);
    assert.deepEqual(rowOf(two.B.id), before, 'B unchanged');
    const b = await two.B.client.request({ path: '/api/household/outbound' });
    assert.equal(b.status, 200);
    assert.deepEqual(b.json.outbound, ALL_PAUSED, 'a provisioned household starts paused');
  } finally {
    await two.close();
  }
});
