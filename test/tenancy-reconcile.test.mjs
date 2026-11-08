// MT-05 AC3: the OS-operator command `node scripts/reconcile-spend.mjs --household <id> --round <id>
// --cost-usd <amount> --receipt-ref <id>` validates its receipt reference and cost, refuses a
// foreign round, a round still in flight and an over-bound settlement (which keeps the hold as
// reservation_bound_exceeded with the debt recorded), and clears a known-cost hold idempotently
// without enabling outbound work. The normal bootstrap cannot redirect a real credential through
// the test harness: no config or environment key sets a model transport, the SDK env never
// carries ANTHROPIC_BASE_URL, createEngine accepts only a loopback testTransport, and a server
// started with no second argument never reaches an emulator.
//
// Held rounds are produced by real live rounds against test/helpers/model-emulator.mjs (a
// destroyed socket for an unknown cost, a hung response for a round in flight, an old fundingNow
// for an expired reservation). Every receipt and value is synthetic.
//
// Assumptions (the contract is silent):
// 1. Validation refusals may or may not write an audit row; any audit row holds fixed codes only.
// 2. The reconcile command touches only platform.sqlite; the household mirror of a reconciled
//    round appears at that household's next engine status() or reserve.
// 3. A settled reconciled round keeps receipt_ref in model_rounds (the receipt reference, never its
//    contents); audit_events never holds it.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { src, runCommand, tempDir } from './helpers/server.mjs';
import { startModelEmulator } from './helpers/model-emulator.mjs';
import { liveTwoHouseholds, SYNTHETIC_CREDENTIAL } from './helpers/tenancy-runtime.mjs';

const T = { timeout: 180_000 };
const QUESTION = Object.freeze([{ role: 'user', content: 'Synthetic reconcile question' }]);
const CALL = Object.freeze({ purpose: 'confirm', messages: QUESTION, maxTokens: 64 });
const RECEIPT = 'rcpt-synthetic-0001';

function near(actual, expected, label) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9, `${label}: ${actual} is not ${expected}`);
}

const refused = (name, code) => err => {
  assert.equal(err?.name, name, err?.stack);
  if (code !== undefined) assert.equal(err.code, code, `${name} code`);
  return true;
};

const roundsOf = async (platform, id) => (await platform.prepare("SELECT * FROM model_rounds WHERE household_id = ? AND kind = 'round' ORDER BY reserved_at, rowid").all(id)).map(r => ({ ...r }));
const roundById = async (platform, id) => ({ ...await platform.prepare('SELECT * FROM model_rounds WHERE id = ?').get(id) });
const outboundRows = async platform => (await platform.prepare('SELECT * FROM household_outbound ORDER BY household_id').all()).map(r => ({ ...r }));
const audits = async platform => (await platform.prepare("SELECT * FROM audit_events WHERE action = 'model.reconcile' ORDER BY id").all()).map(r => ({ ...r }));
const month = () => new Date().toISOString().slice(0, 7);

async function withLive(options, fn) {
  const emulator = await startModelEmulator();
  let two;
  try {
    two = await liveTwoHouseholds({ emulator, ...options });
    return await fn({ two, emulator, A: two.A.id, B: two.B.id });
  } finally {
    await emulator.close();
    await two?.close();
  }
}

// Runs the command against the instance; household_outbound must be byte-identical afterwards.
async function reconcile(two, { household, round, cost, receipt }) {
  const flags = await outboundRows(two.platform);
  const r = await runCommand(process.execPath, ['scripts/reconcile-spend.mjs', '--household', household, '--round', round,
    '--cost-usd', cost, '--receipt-ref', receipt], { env: { FATHOM_DATA: two.dataDir } });
  assert.deepEqual(await outboundRows(two.platform), flags, 'reconcile-spend never changes outbound flags');
  return r;
}
const ok = (r, code) => { assert.equal(r.code, 0, r.stdout + r.stderr); assert.equal(r.stdout, `reconcile-spend: ${code}\n`); assert.equal(r.stderr, ''); };
const no = (r, code) => { assert.equal(r.code, 1, r.stdout + r.stderr); assert.equal(r.stderr, `reconcile-spend: ${code}\n`); assert.equal(r.stdout, ''); };

async function noReceiptInAudit(platform, ...texts) {
  for (const row of await platform.prepare('SELECT * FROM audit_events').all()) {
    const s = JSON.stringify(row);
    for (const t of texts) assert.ok(!s.includes(t), 'audit rows never carry receipt text');
  }
}

// A held cost_unknown round of `id`: its live round's socket is destroyed.
async function heldRound(two, emulator, id) {
  emulator.script([{ destroy: true }]);
  await assert.rejects((await two.ctx(id)).engine.call(CALL));
  const row = (await roundsOf(two.platform, id)).at(-1);
  assert.equal(row.state, 'held');
  assert.equal(row.hold_code, 'cost_unknown');
  return row;
}

describe('node scripts/reconcile-spend.mjs', T, () => {
  test('refuses bad receipt references, bad costs, unknown and foreign rounds, and changes nothing', T, async () => withLive({}, async ({ two, emulator, A, B }) => {
    const held = await heldRound(two, emulator, A);
    await (await two.ctx(B)).engine.call(CALL);
    const [settledB] = await roundsOf(two.platform, B);
    assert.equal(settledB.state, 'settled');
    const good = { household: A, round: held.id, cost: '0.01', receipt: RECEIPT };
    const bad = ['', '   ', 'r'.repeat(200), '../x'];
    for (const receipt of bad) no(await reconcile(two, { ...good, receipt }), 'bad_receipt_ref');
    for (const cost of ['-1', 'NaN', 'abc']) no(await reconcile(two, { ...good, cost }), 'bad_cost');
    no(await reconcile(two, { ...good, round: 'mr-synthetic-unknown' }), 'no_such_round');
    no(await reconcile(two, { ...good, round: settledB.id }), 'foreign_round');
    no(await reconcile(two, { ...good, household: B }), 'foreign_round');
    assert.deepEqual(await roundById(two.platform, held.id), held, 'the held round is unchanged');
    assert.deepEqual(await roundById(two.platform, settledB.id), settledB, 'the other household\'s round is unchanged');
    assert.ok((await audits(two.platform)).every(a => a.outcome !== 'ok'), 'no refusal is audited as ok');
    await noReceiptInAudit(two.platform, RECEIPT, '../x', 'r'.repeat(200));
  }));

  test('settles a known-cost hold once, idempotently, without enabling outbound work; the household can call again', T, async () => withLive({}, async ({ two, emulator, A }) => {
    const { budget, outbound } = { budget: await src('src/platform/model-budget.mjs'), outbound: await src('src/platform/outbound.mjs') };
    const held = await heldRound(two, emulator, A);
    assert.ok(held.reserved_usd > 0.01, 'precondition: the cost fits the reservation');
    outbound.setOutbound(two.platform, A, { engine: false });
    const flags = await outboundRows(two.platform);

    ok(await reconcile(two, { household: A, round: held.id, cost: '0.01', receipt: RECEIPT }), 'settled');
    const settled = await roundById(two.platform, held.id);
    assert.equal(settled.state, 'settled');
    near(settled.cost_usd, 0.01, 'settled cost');
    assert.equal(settled.receipt_ref, RECEIPT);
    near(await budget.committedUsd(two.platform, { householdId: A, month: month() }), 0.01, 'the unused reservation is released');
    let rows = await audits(two.platform);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].household_id, A);
    assert.equal(rows[0].outcome, 'ok');
    assert.deepEqual(await outboundRows(two.platform), flags, 'flags unchanged');
    assert.equal(outbound.readOutbound(two.platform, A).engine, false, 'reconciling never resumes a paused engine');

    ok(await reconcile(two, { household: A, round: held.id, cost: '0.01', receipt: RECEIPT }), 'unchanged');
    assert.deepEqual(await roundById(two.platform, held.id), settled);
    rows = await audits(two.platform);
    assert.equal(rows.filter(a => a.outcome === 'ok').length, 1, 'an unchanged repeat adds no settlement');
    no(await reconcile(two, { household: A, round: held.id, cost: '0.02', receipt: RECEIPT }), 'already_settled');
    assert.deepEqual(await roundById(two.platform, held.id), settled, 'a different cost never resettles');
    await noReceiptInAudit(two.platform, RECEIPT);

    // Liveness: with the hold cleared and the engine resumed by the admin, a fresh context calls again.
    outbound.setOutbound(two.platform, A, { engine: true });
    const side = await two.side(A);
    const before = emulator.requests.length;
    await side.engine.call(CALL);
    assert.equal(emulator.requests.length, before + 1, 'the household is admitted again');
    await side.engine.status();
    const mirrors = await side.household.db.prepare('SELECT * FROM spend_ledger WHERE round_id = ?').all(held.id);
    assert.equal(mirrors.length, 1, 'the reconciled round is mirrored once');
    near(mirrors[0].cost_usd, 0.01, 'mirrored cost');
  }));

  test('an over-bound cost keeps the hold as reservation_bound_exceeded with the debt recorded; others keep calling', T, async () => withLive({}, async ({ two, emulator, A, B }) => {
    const budget = await src('src/platform/model-budget.mjs');
    const pricing = await src('src/engine/pricing.mjs');
    const held = await heldRound(two, emulator, A);
    assert.ok(held.reserved_usd < 5, 'precondition: 5 exceeds the reservation');
    no(await reconcile(two, { household: A, round: held.id, cost: '5', receipt: RECEIPT }), 'reservation_bound_exceeded');
    const kept = await roundById(two.platform, held.id);
    assert.equal(kept.state, 'held');
    assert.equal(kept.hold_code, 'reservation_bound_exceeded');
    near(kept.cost_usd, 5, 'the debt is recorded');
    near(await budget.committedUsd(two.platform, { householdId: A, month: month() }), 5, 'the debt counts in full');
    assert.ok((await audits(two.platform)).some(a => a.household_id === A && a.outcome === 'reservation_bound_exceeded'));

    // The ordinary command cannot disguise it as a within-bound settlement.
    no(await reconcile(two, { household: A, round: held.id, cost: '0.01', receipt: RECEIPT }), 'reservation_bound_exceeded');
    assert.deepEqual(await roundById(two.platform, held.id), kept);
    const side = await two.side(A);
    const sent = emulator.requests.length;
    await assert.rejects(side.engine.call(CALL), refused('ModelAccountingError', 'accounting_hold'));
    assert.equal(emulator.requests.length, sent, 'the held household dispatches nothing');

    // Other households keep using unreserved credit.
    await (await two.ctx(B)).engine.call(CALL);
    assert.equal(emulator.requests.length, sent + 1);

    // A round whose provider usage exceeded its bound is refused the same way.
    const usage = { input_tokens: 2_000_000, output_tokens: 10 };
    emulator.script([{ usage }]);
    await assert.rejects((await two.ctx(B)).engine.call(CALL));
    const over = (await roundsOf(two.platform, B)).at(-1);
    assert.equal(over.state, 'held');
    assert.equal(over.hold_code, 'reservation_bound_exceeded');
    near(over.cost_usd, pricing.usageCostUsd(emulator.requests.at(-1).model, usage), 'provider cost recorded');
    no(await reconcile(two, { household: B, round: over.id, cost: '0.01', receipt: 'rcpt-synthetic-0002' }), 'reservation_bound_exceeded');
    assert.deepEqual(await roundById(two.platform, over.id), over);
    await noReceiptInAudit(two.platform, RECEIPT, 'rcpt-synthetic-0002');
  }));

  test('the serving runtime refuses while the hold lasts and answers again once the round is reconciled', T, async () => withLive({}, async ({ two, emulator, A }) => {
    const serving = (await two.server.app.runtimes.get(A)).engine;
    const flags = await outboundRows(two.platform);
    const held = await heldRound(two, emulator, A);
    assert.equal((await two.server.app.runtimes.get(A)).engine, serving, 'the same serving engine');
    const sent = emulator.requests.length;
    await assert.rejects(serving.call(CALL), refused('ModelAccountingError'));
    assert.equal(await serving.isOn(), false, 'off while the platform hold lasts');
    assert.equal(emulator.requests.length, sent, 'nothing dispatched while held');

    ok(await reconcile(two, { household: A, round: held.id, cost: '0.01', receipt: RECEIPT }), 'settled');
    assert.equal((await two.server.app.runtimes.get(A)).engine, serving, 'still the same serving engine');
    assert.equal(await serving.isOn(), true, 'on again once the hold is settled');
    const res = await serving.call(CALL);
    assert.equal(res.text, 'Synthetic answer with no figures.');
    assert.equal(emulator.requests.length, sent + 1, 'the serving engine dispatched the round');
    assert.equal((await roundsOf(two.platform, A)).at(-1).state, 'settled');
    assert.equal(await serving.isOn(), true);
    assert.deepEqual(await outboundRows(two.platform), flags, 'household_outbound unchanged');
  }));

  test('the serving runtime stays refused after an over-bound reconcile', T, async () => withLive({}, async ({ two, emulator, A }) => {
    const serving = (await two.server.app.runtimes.get(A)).engine;
    const held = await heldRound(two, emulator, A);
    no(await reconcile(two, { household: A, round: held.id, cost: '5', receipt: RECEIPT }), 'reservation_bound_exceeded');
    const sent = emulator.requests.length;
    await assert.rejects(serving.call(CALL), refused('ModelAccountingError'));
    assert.equal(await serving.isOn(), false);
    assert.equal(emulator.requests.length, sent, 'nothing dispatched');
  }));

  test('a round still in flight is refused; an expired reservation is reconciled', T, async () => withLive({}, async ({ two, emulator, B }) => {
    const budget = await src('src/platform/model-budget.mjs');
    emulator.script([{ hang: true }, { hang: true }]);
    const inFlight = (await two.ctx(B)).engine.call(CALL).then(r => r, e => e);
    await emulator.waitForRequests(1);
    const [live] = await roundsOf(two.platform, B);
    assert.equal(live.state, 'reserved');
    no(await reconcile(two, { household: B, round: live.id, cost: '0.01', receipt: RECEIPT }), 'round_in_flight');
    assert.deepEqual(await roundById(two.platform, live.id), live, 'the in-flight round is untouched');

    // A round reserved more than RESERVATION_TTL_MS ago (a crashed process) is reconcilable.
    const old = await two.side(B, { ...two.engineOptions, fundingNow: () => Date.now() - budget.RESERVATION_TTL_MS - 60_000 });
    const crashed = old.engine.call(CALL).then(r => r, e => e);
    await emulator.waitForRequests(2);
    const stale = (await roundsOf(two.platform, B)).find(r => r.id !== live.id);
    assert.equal(stale.state, 'reserved');
    assert.ok(stale.expires_at < Date.now(), 'precondition: the reservation has expired');
    ok(await reconcile(two, { household: B, round: stale.id, cost: '0.01', receipt: RECEIPT }), 'settled');
    const settled = await roundById(two.platform, stale.id);
    assert.equal(settled.state, 'settled');
    near(settled.cost_usd, 0.01, 'reconciled cost');
    assert.equal((await roundById(two.platform, live.id)).state, 'reserved', 'the other round is still in flight');

    await emulator.close();
    await inFlight;
    await crashed;
    const after = await roundById(two.platform, stale.id);
    assert.equal(after.state, 'settled', 'the late failure of the crashed round never reopens it');
    near(after.cost_usd, 0.01, 'cost unchanged');
  }));
});

// ---------------------------------------------------------------------------------- bootstrap cannot redirect the credential

describe('the normal bootstrap cannot redirect the credential through the test harness', T, () => {
  const HOSTILE = 'http://127.0.0.1:9';
  const TRANSPORT_KEYS = ['ANTHROPIC_BASE_URL', 'FATHOM_TEST_TRANSPORT', 'FATHOM_TEST_TRANSPORT_URL', 'FATHOM_ENGINE_BASE_URL',
    'FATHOM_MODEL_BASE_URL', 'FATHOM_ANTHROPIC_BASE_URL'];

  async function withEnv(values, fn) {
    const saved = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
    Object.assign(process.env, values);
    try { return await fn(); } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test('loadConfig ignores every transport-looking environment key', async () => {
    const { loadConfig } = await src('src/config.mjs');
    const dir = await tempDir('fathom-mt05-config-');
    const base = { FATHOM_DATA: join(dir, 'data'), FATHOM_DEMO: '0', FATHOM_ENGINE: 'live', FATHOM_PUBLIC_URL: 'http://localhost:8080',
      FATHOM_CLAUDE_CREDENTIAL_FILE: join(dir, 'claude-credential') };
    try {
      const hostile = { ...base, ...Object.fromEntries(TRANSPORT_KEYS.map(k => [k, HOSTILE])) };
      const config = loadConfig(hostile);
      assert.deepEqual(config, loadConfig(base), 'the transport keys change nothing');
      assert.ok(!JSON.stringify(config).includes('127.0.0.1:9'));
      assert.ok(!Object.keys(config).some(k => /testTransport|baseUrl/i.test(k)), 'config has no transport override');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('sdkOptions env never carries ANTHROPIC_BASE_URL, even when the process has one', async () => {
    const { sdkOptions } = await src('src/engine/live.mjs');
    const dir = await tempDir('fathom-mt05-sdk-');
    await withEnv({ ANTHROPIC_BASE_URL: HOSTILE }, async () => {
      const options = sdkOptions({ credential: { type: 'api-key', value: SYNTHETIC_CREDENTIAL }, configDir: dir, system: 'Synthetic system',
        systemDynamic: '', maxTokens: 64, maxBudgetUsd: 0.05, model: 'claude-opus-5-5', registry: null });
      assert.ok(!Object.hasOwn(options.env, 'ANTHROPIC_BASE_URL'));
      assert.ok(!Object.values(options.env).some(v => String(v).includes('127.0.0.1:9')));
      assert.equal(options.maxBudgetUsd, 0.05, 'the SDK spend bound is the reserved bound');
    }).finally(() => rmSync(dir, { recursive: true, force: true }));
  });

  test('createEngine accepts only a loopback testTransport', async () => {
    const { createEngine } = await src('src/engine/index.mjs');
    const pricing = await src('src/engine/pricing.mjs');
    const reserved = [];
    const settled = [];
    let n = 0;
    const reservations = {
      async reserve(args) { reserved.push(args); n += 1; return { roundId: `mr-synthetic-${n}`, boundUsd: args.boundUsd }; },
      async settle(roundId, result) { settled.push([roundId, result]); },
      async hold() {},
    };
    for (const baseURL of ['https://api.example.invalid', 'http://10.0.0.5:1', 'http://api.example.invalid:8080', 'https://127.0.0.1:443',
      'ftp://127.0.0.1:21', 'http://127.0.0.1', '', 123]) {
      assert.throws(() => createEngine({ mode: 'live', credential: SYNTHETIC_CREDENTIAL, reservations, testTransport: { baseURL } }), TypeError, String(baseURL));
    }
    for (const baseURL of ['http://localhost:9', 'http://[::1]:9']) {
      assert.doesNotThrow(() => createEngine({ mode: 'live', credential: SYNTHETIC_CREDENTIAL, reservations, testTransport: { baseURL } }), baseURL);
    }
    const emulator = await startModelEmulator();
    try {
      const engine = createEngine({ mode: 'live', credential: SYNTHETIC_CREDENTIAL, reservations, testTransport: { baseURL: emulator.baseURL } });
      const res = await engine.call(CALL);
      assert.equal(res.text, 'Synthetic answer with no figures.');
      assert.equal(emulator.requests.length, 1, 'the loopback emulator received the round');
      assert.equal(reserved.length, 1);
      const model = pricing.modelFor('confirm');
      near(reserved[0].boundUsd, pricing.estimateUnknownCost({ model, maxTokens: 64, system: '', messages: [...QUESTION], tools: [] }).costUsd, 'bound');
      assert.equal(settled.length, 1);
      assert.equal(settled[0][0], 'mr-synthetic-1');
      near(settled[0][1].costUsd, pricing.usageCostUsd(model, emulator.requests[0].response.usage), 'settled cost');
    } finally {
      await emulator.close();
    }
  });

  test('a live server started with no engine options never reaches an emulator named by the environment', T, async () => {
    const emulator = await startModelEmulator();
    const realFetch = globalThis.fetch;
    const external = [];
    let two;
    try {
      await withEnv({ ANTHROPIC_BASE_URL: emulator.baseURL, FATHOM_TEST_TRANSPORT: emulator.baseURL }, async () => {
        two = await liveTwoHouseholds({ emulator, engineOptions: null,
          extra: { ANTHROPIC_BASE_URL: emulator.baseURL, FATHOM_TEST_TRANSPORT: emulator.baseURL } });
        // Requests off the loopback interface are answered here with a synthetic 401, so nothing
        // leaves the host; the recorded origin is where the credential would have gone.
        globalThis.fetch = async (input, init) => {
          const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
          if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return realFetch(input, init);
          external.push(url.origin);
          return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'Synthetic refusal' } }),
            { status: 401, headers: { 'content-type': 'application/json' } });
        };
        await assert.rejects((await two.ctx(two.A.id)).engine.call(CALL));
      });
    } finally {
      globalThis.fetch = realFetch;
      await emulator.close();
      await two?.close();
    }
    assert.equal(emulator.requests.length, 0, 'the emulator received nothing');
    assert.ok(external.length >= 1, 'the round went to the production endpoint');
    for (const origin of external) assert.equal(origin, 'https://api.anthropic.com');
  });
});
