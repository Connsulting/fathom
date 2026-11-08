// MT-05 AC1 and AC4: every paid model round (purposes chat, job, extract, confirm and title, tool
// continuations and retries) reserves against the household allocation (bounded by the admin cap)
// and the instance cap in the shared platform ledger before it is dispatched; concurrency across
// a server context and a CLI-style context, crashes and transport failures cannot overspend,
// double settle or release an unknown reservation. The operator command scripts/model-budget.mjs
// sets instance funding and household allocations idempotently with audit rows and never touches
// pause flags. Platform migration 005 seeds existing households from a hand-set instance cap.
//
// Every live round runs against test/helpers/model-emulator.mjs through the programmatic
// testTransport engine option (startServer(config, { engineOptions })); no paid call is made.
// Households are built through the real server, operator route and auth store
// (liveTwoHouseholds). The CLI-style context is a second platform and store connection
// (sideHousehold). Time moves only through the fundingNow injection.
//
// Assumptions (the contract is silent):
// 1. model_rounds is an ordinary rowid table, so rows order by (reserved_at, rowid).
// 2. A household mirror row (spend_ledger.round_id) exists after the call returns or, at the
//    latest, after engine.status() (which syncs final platform rounds).
// 3. setInstanceCap, setAllocation and committedUsd may be sync or async; the tests await them.
// 4. A refused reservation writes no model_rounds row of kind 'round'.
// 5. Migration 005 consists of new tables plus the allocation seed; replay only that migration,
//    retaining the records for unrelated later platform migrations.
// 6. An HTTP error response from the model is a known zero-cost round (settled at 0), as
//    messagesRound treats it today.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { src, runCommand, sessionClient } from './helpers/server.mjs';
import { startModelEmulator, gate } from './helpers/model-emulator.mjs';
import { liveTwoHouseholds, enrollSession, startRuntime, withSqlite } from './helpers/tenancy-runtime.mjs';

const T = { timeout: 180_000 };
const pause = ms => new Promise(r => setTimeout(r, ms));
const QUESTION = Object.freeze([{ role: 'user', content: 'Synthetic budget question' }]);
// extract() wraps the row schema in its response schema; the reservation estimate counts that schema's bytes too.
const responseSchemaOf = schema => ({ type: 'object', properties: { rows: { type: 'array', items: schema } }, required: ['rows'], additionalProperties: false });
const ROW_SCHEMA = Object.freeze({ type: 'object', properties: { label: { type: 'string' } }, required: ['label'], additionalProperties: false });
const PROBE = name => ({
  name, description: 'Synthetic probe tool.', kind: 'read', operations: [{ name: 'read', scope: 'read' }],
  inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: () => ({ ok: true }),
});

function near(actual, expected, label) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-9, `${label}: ${actual} is not ${expected}`);
}

const refused = (name, code) => err => {
  assert.equal(err?.name, name, err?.stack);
  if (code !== undefined) assert.equal(err.code, code, `${name} code`);
  return true;
};

async function mods() {
  return {
    budget: await src('src/platform/model-budget.mjs'),
    engine: await src('src/engine/index.mjs'),
    pricing: await src('src/engine/pricing.mjs'),
    outbound: await src('src/platform/outbound.mjs'),
  };
}

const bound = (pricing, { purpose, maxTokens, system = '', systemDynamic = '', messages, tools = [] }) =>
  pricing.estimateUnknownCost({ model: pricing.modelFor(purpose), maxTokens, system: systemDynamic ? `${system}\n${systemDynamic}` : system,
    messages, tools }).costUsd;

const roundsOf = async (platform, id) => (await platform.prepare("SELECT * FROM model_rounds WHERE household_id = ? AND kind = 'round' ORDER BY reserved_at, rowid").all(id)).map(r => ({ ...r }));
const carriesOf = async (platform, id) => (await platform.prepare("SELECT * FROM model_rounds WHERE household_id = ? AND kind = 'carry'").all(id)).map(r => ({ ...r }));
const mirrorsOf = async db => (await db.prepare('SELECT * FROM spend_ledger WHERE round_id IS NOT NULL ORDER BY rowid').all()).map(r => ({ ...r }));
const outboundRows = async platform => (await platform.prepare('SELECT * FROM household_outbound ORDER BY household_id').all()).map(r => ({ ...r }));
const month = () => new Date().toISOString().slice(0, 7);

// One emulator and a live two-household instance per case; the emulator closes first so a hung
// round's socket is destroyed before the stores close.
async function withLive(options, fn) {
  const { emulatorOptions = {}, ...rest } = options;
  const emulator = await startModelEmulator(emulatorOptions);
  let two;
  try {
    two = await liveTwoHouseholds({ emulator, ...rest });
    return await fn({ two, emulator, A: two.A.id, B: two.B.id });
  } finally {
    await emulator.close();
    await two?.close();
  }
}

// Asserts one settled round per emulator request since `from`, priced from the emulator's usage,
// each mirrored once into the household spend_ledger.
async function assertSettledRounds({ two, emulator, id, from = 0, purposes }) {
  const { pricing } = await mods();
  const ctx = (await two.ctx(id));
  await ctx.engine.status();
  const rows = (await roundsOf(two.platform, id)).slice(from);
  const reqs = emulator.requests.slice(from);
  assert.equal(rows.length, reqs.length, 'one model_rounds row per dispatched request');
  if (purposes) assert.deepEqual(rows.map(r => r.purpose), purposes);
  const mirrors = await mirrorsOf(ctx.db);
  rows.forEach((row, i) => {
    const req = reqs[i];
    assert.equal(row.state, 'settled', `round ${i} settled`);
    assert.equal(row.hold_code, null);
    assert.equal(row.model, req.model);
    const cost = pricing.usageCostUsd(req.model, req.response.usage);
    near(row.cost_usd, cost, `round ${i} cost`);
    assert.ok(row.reserved_usd >= cost, 'the reservation covered the cost');
    assert.equal(row.input_tokens, req.response.usage.input_tokens);
    assert.equal(row.output_tokens, req.response.usage.output_tokens);
    assert.match(row.month, /^\d{4}-\d{2}$/);
    const mine = mirrors.filter(m => m.round_id === row.id);
    assert.equal(mine.length, 1, `round ${i} mirrored once`);
    near(mine[0].cost_usd, cost, `round ${i} mirror cost`);
  });
  return rows;
}

// ---------------------------------------------------------------------------------- purposes

describe('every paid round reserves against both caps', T, () => {
  test('chat, job, extract, confirm and title each reserve, settle and mirror one round', T, async () => withLive({}, async ({ two, emulator, A }) => {
    const { pricing } = await mods();
    const engine = (await two.ctx(A)).engine;
    const calls = [
      ['chat', () => engine.call({ purpose: 'chat', messages: QUESTION, maxTokens: 64 })],
      ['job', () => engine.call({ purpose: 'job', messages: QUESTION, maxTokens: 64 })],
      ['extract', () => engine.extract({ document: { type: 'text', text: 'Synthetic document body' }, schema: ROW_SCHEMA, maxTokens: 64 })],
      ['confirm', () => engine.call({ purpose: 'confirm', messages: QUESTION, maxTokens: 64 })],
      ['title', () => engine.call({ purpose: 'title', messages: QUESTION, maxTokens: 64 })],
    ];
    for (const [purpose, run] of calls) {
      const from = emulator.requests.length;
      await run();
      assert.equal(emulator.requests.length, from + 1, `${purpose}: one request`);
      assert.equal(emulator.requests[from].model, pricing.modelFor(purpose), `${purpose} model`);
      const [row] = await assertSettledRounds({ two, emulator, id: A, from, purposes: [purpose] });
      assert.equal(row.month, month());
    }
    const status = await engine.status();
    const { budget } = await mods();
    near(status.spentUsd, await budget.committedUsd(two.platform, { householdId: A, month: month() }), 'status spentUsd is the platform committed total');
  }));

  test('an Ask over HTTP reserves its chat and title rounds through the router', T, async () => withLive({}, async ({ two, emulator, A }) => {
    const r = await two.A.client.postJson('/api/threads', { text: 'Synthetic budget question about the reserve' });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(!r.json.message.notice, 'answered, not a notice');
    assert.match(JSON.stringify(r.json.message), /Synthetic answer with no figures/);
    const rows = await assertSettledRounds({ two, emulator, id: A });
    assert.ok(rows.some(row => row.purpose === 'chat'), 'a chat round');
    assert.ok(rows.some(row => row.purpose === 'title'), 'a title round');
  }));

  test('a tool continuation and a retry each reserve their own round', T, async () => withLive({}, async ({ two, emulator, A }) => {
    let probed = 0;
    const probe = { ...PROBE('synthetic_probe'), handler: () => { probed += 1; return { ok: true }; } };
    emulator.script([{ toolUse: { id: 'toolu_synthetic_probe', input: {} } }, { text: 'Synthetic final answer.' }]);
    const engine = (await two.ctx(A)).engine;
    const res = await engine.call({ purpose: 'chat', messages: QUESTION, tools: [probe], maxTokens: 64 });
    assert.equal(res.text, 'Synthetic final answer.');
    assert.equal(probed, 1, 'the tool ran once');
    assert.equal(emulator.requests.length, 2, 'two rounds dispatched');
    assert.match(JSON.stringify(emulator.requests[1].body.messages), /toolu_synthetic_probe/, 'the continuation carries the tool result');
    const rows = await assertSettledRounds({ two, emulator, id: A, purposes: ['chat', 'chat'] });
    assert.ok(rows[1].reserved_usd >= rows[0].reserved_usd, 'the continuation bound covers the longer transcript');

    await engine.call({ purpose: 'chat', maxTokens: 64,
      messages: [...QUESTION, { role: 'assistant', content: res.text }, { role: 'user', content: 'Synthetic corrective turn.' }] });
    assert.equal(emulator.requests.length, 3);
    await assertSettledRounds({ two, emulator, id: A, purposes: ['chat', 'chat', 'chat'] });
  }));

  test('the request max_tokens is the call maxTokens and the reservation is the unknown-cost bound', T, async () => withLive({}, async ({ two, emulator, A }) => {
    const { pricing } = await mods();
    const engine = (await two.ctx(A)).engine;
    const chat = { purpose: 'chat', system: 'Synthetic static system.', systemDynamic: 'Synthetic dynamic context.', messages: QUESTION,
      tools: [PROBE('synthetic_probe')], maxTokens: 77 };
    await engine.call(chat);
    const confirm = { purpose: 'confirm', system: 'Synthetic confirm system.', messages: QUESTION, maxTokens: 50 };
    await engine.call(confirm);
    const rows = await roundsOf(two.platform, A);
    assert.equal(rows.length, 2);
    assert.equal(emulator.requests[0].body.max_tokens, 77);
    assert.match(JSON.stringify(emulator.requests[0].body.system), /Synthetic dynamic context/);
    near(rows[0].reserved_usd, bound(pricing, chat), 'chat reservation');
    assert.equal(emulator.requests[1].body.max_tokens, 50);
    near(rows[1].reserved_usd, bound(pricing, confirm), 'confirm reservation');
  }));
});

// ---------------------------------------------------------------------------------- SDK-path bound

// The production chat and job path (live mode, no testTransport, roundRunner sdkRound) can make
// more than one paid provider response in one round (SDK refusal and fallback retries), and the
// SDK's maxBudgetUsd stops only once cumulative cost exceeds it. So an SDK-runner round passes
// maxBudgetUsd = E (the unknown-cost estimate) and reserves SDK_RESPONSE_BOUND * E; each response
// is at most E, so the round's total is at most 2E. The round runner is injected (createEngine's
// roundRunner option), so no SDK subprocess runs and nothing leaves the process.
describe('an SDK-runner round reserves SDK_RESPONSE_BOUND times its per-response budget', T, () => {
  const SYSTEM = 'Synthetic static system.';
  const DYNAMIC = 'Synthetic dynamic context.';
  const REQUEST = Object.freeze({ system: SYSTEM, systemDynamic: DYNAMIC, messages: QUESTION, maxTokens: 64 });

  // A recording reservations adapter and an injected round runner reporting `costOf(maxBudgetUsd)`.
  async function sdkEngine({ costOf = () => 0.001, settleThrows = false } = {}) {
    const { engine: E } = await mods();
    const log = { reserve: [], settle: [], hold: [], runner: [] };
    const reservations = {
      async reserve(args) { log.reserve.push(args); return { roundId: 'r-1', boundUsd: args.boundUsd }; },
      async settle(roundId, result) {
        log.settle.push([roundId, result]);
        if (settleThrows) throw new Error('synthetic platform write failure');
      },
      async hold(roundId, code) { log.hold.push([roundId, code]); },
    };
    const roundRunner = async args => {
      log.runner.push({ maxBudgetUsd: args.maxBudgetUsd, model: args.model, maxTokens: args.maxTokens });
      return { text: 'ok', content: [{ type: 'text', text: 'ok' }], tokens: { input_tokens: 10, output_tokens: 5 },
        costUsd: costOf(args.maxBudgetUsd), model: args.model, status: 'success', is_error: false, toolResults: [], details: {} };
    };
    const engine = E.createEngine({ mode: 'live', credential: 'synthetic-credential-not-valid', reservations, roundRunner });
    return { E, engine, log };
  }

  const estimate = (pricing, purpose, tools = []) => pricing.estimateUnknownCost({ model: pricing.modelFor(purpose), maxTokens: REQUEST.maxTokens,
    system: `${SYSTEM}\n${DYNAMIC}`, messages: QUESTION, tools }).costUsd;

  test('SDK_RESPONSE_BOUND is exported as 2', async () => {
    const { engine: E } = await mods();
    assert.equal(E.SDK_RESPONSE_BOUND, 2);
  });

  for (const purpose of ['chat', 'job']) {
    test(`${purpose}: reserves SDK_RESPONSE_BOUND * E and hands the runner maxBudgetUsd = E`, async () => {
      const { pricing } = await mods();
      const tools = [PROBE('synthetic_probe')];
      const { engine, log } = await sdkEngine();
      const e = estimate(pricing, purpose, tools);
      const res = await engine.call({ purpose, ...REQUEST, tools });
      assert.equal(res.text, 'ok');
      assert.equal(log.reserve.length, 1, 'one reservation');
      assert.equal(log.reserve[0].purpose, purpose);
      assert.equal(log.reserve[0].model, pricing.modelFor(purpose));
      near(log.reserve[0].boundUsd, 2 * e, `${purpose} reservation is SDK_RESPONSE_BOUND (2) * E`);
      assert.equal(log.runner.length, 1);
      near(log.runner[0].maxBudgetUsd, e, `${purpose} per-response budget`);
      assert.equal(log.settle.length, 1);
      assert.equal(log.hold.length, 0);
    });
  }

  test('a round reporting two responses\' worth (between E and 2E) settles within its reservation and resolves', async () => {
    const { pricing } = await mods();
    const e = estimate(pricing, 'chat');
    const cost = Number((1.5 * e).toFixed(12));
    const { engine, log } = await sdkEngine({ costOf: () => cost });
    const res = await engine.call({ purpose: 'chat', ...REQUEST });
    assert.equal(res.text, 'ok');
    near(res.costUsd, cost, 'the round cost is reported');
    assert.equal(log.settle.length, 1, 'settled once');
    assert.equal(log.settle[0][0], 'r-1');
    near(log.settle[0][1].costUsd, cost, 'settled at the reported cost');
    assert.equal(log.hold.length, 0, 'no hold');
    // Liveness: the engine is not latched; the next round is admitted.
    await engine.call({ purpose: 'chat', ...REQUEST });
    assert.equal(log.runner.length, 2);
  });

  test('liveness: a normal small-cost chat round resolves and settles', async () => {
    const { engine, log } = await sdkEngine({ costOf: () => 0.0004 });
    const res = await engine.call({ purpose: 'chat', ...REQUEST });
    assert.equal(res.text, 'ok');
    near(log.settle[0][1].costUsd, 0.0004, 'settled cost');
    assert.equal(log.hold.length, 0);
  });

  test('a failed platform settle write latches the engine: the next call dispatches nothing', async () => {
    const { engine, log } = await sdkEngine({ settleThrows: true });
    await assert.rejects(engine.call({ purpose: 'chat', ...REQUEST }), refused('ModelAccountingError'));
    await assert.rejects(engine.call({ purpose: 'chat', ...REQUEST }), refused('ModelAccountingError'));
    assert.equal(log.runner.length, 1, 'the latched engine dispatched nothing more');
    assert.equal(log.reserve.length, 1, 'and reserved nothing more');
  });
});

// ---------------------------------------------------------------------------------- caps

describe('admission refuses a round whose bound exceeds either remaining budget', T, () => {
  const CALL = { purpose: 'chat', messages: QUESTION, maxTokens: 64 };

  test('an allocation below the admin cap refuses before dispatch; a larger one admits', T, async () => withLive({}, async ({ two, emulator, A }) => {
    const { budget, engine: E, pricing } = await mods();
    assert.ok(bound(pricing, CALL) > 0.01);
    await budget.setAllocation(two.platform, A, 0.01);
    const engine = (await two.ctx(A)).engine;
    await assert.rejects(engine.call(CALL), err => err instanceof E.BudgetExceededError);
    assert.equal(emulator.requests.length, 0, 'nothing dispatched');
    assert.equal((await roundsOf(two.platform, A)).length, 0, 'no round recorded');

    await budget.setAllocation(two.platform, A, 1);
    await engine.call(CALL);
    assert.equal(emulator.requests.length, 1);
    await assertSettledRounds({ two, emulator, id: A });
    const status = await engine.status();
    assert.equal(status.capUsd, 1, 'the effective cap is min(admin cap, allocation)');
  }));

  test('an admin cap below the allocation refuses before dispatch; raising it admits', T, async () => withLive({}, async ({ two, emulator, A }) => {
    const { engine: E } = await mods();
    assert.equal((await two.A.client.postJson('/api/engine/cap', { usd: 0.01 })).status, 200);
    const engine = (await two.ctx(A)).engine;
    await assert.rejects(engine.call(CALL), err => err instanceof E.BudgetExceededError);
    assert.equal(emulator.requests.length, 0);
    assert.equal((await engine.status()).capUsd, 0.01);

    assert.equal((await two.A.client.postJson('/api/engine/cap', { usd: 200 })).status, 200);
    await engine.call(CALL);
    assert.equal(emulator.requests.length, 1);
    assert.equal((await engine.status()).capUsd, 50, 'the admin cap is bounded by the allocation');
  }));

  test('two households share the instance cap: an in-flight reservation leaves too little for the other', T, async () => withLive({}, async ({ two, emulator, A, B }) => {
    const { budget, engine: E, pricing } = await mods();
    const b = bound(pricing, CALL);
    const cap = 0.05;
    assert.ok(b <= cap && 2 * b > cap, 'precondition: one bound fits the cap, two do not');
    for (const id of [A, B]) await budget.setAllocation(two.platform, id, cap);
    await budget.setInstanceCap(two.platform, cap);
    const g = gate();
    emulator.script([{ wait: g.promise }]);
    const first = (await two.ctx(A)).engine.call(CALL).then(r => r, e => e);
    await emulator.waitForRequests(1);
    await assert.rejects((await two.ctx(B)).engine.call(CALL), err => err instanceof E.BudgetExceededError);
    assert.equal(emulator.requests.length, 1, 'the refused household dispatched nothing');
    assert.ok(await budget.committedUsd(two.platform, { month: month() }) <= cap + 1e-9);
    g.open();
    const done = await first;
    assert.ok(!(done instanceof Error), String(done?.stack));
    // Liveness: once A settles below its bound, B fits.
    await two.ctx(B).engine.call(CALL);
    assert.equal(emulator.requests.length, 2);
    const [rowB] = await roundsOf(two.platform, B);
    assert.equal(rowB.state, 'settled');
    const total = await budget.committedUsd(two.platform, { month: month() });
    assert.ok(total <= cap + 1e-9, `instance committed ${total} within ${cap}`);
  }));
});

// ---------------------------------------------------------------------------------- concurrency

test('concurrent server and CLI-style calls never commit more than the allocation; refused calls send nothing', T, async () => withLive({}, async ({ two, emulator, A }) => {
  const { budget, engine: E, pricing } = await mods();
  const messages = [{ role: 'user', content: 'Synthetic concurrent question' }];
  const model = pricing.modelFor('chat');
  const est = pricing.estimateUnknownCost({ model, maxTokens: 64, system: '', messages, tools: [] });
  // Each settled round costs about half its bound, so the allocation binds after a few rounds.
  const usage = { input_tokens: est.inputTokens, output_tokens: 64 };
  const cost = pricing.usageCostUsd(model, usage);
  const allocation = Math.floor(est.costUsd * 4 * 100) / 100;
  assert.ok(allocation >= est.costUsd && cost <= est.costUsd && 16 * cost > allocation, 'precondition');
  await budget.setAllocation(two.platform, A, allocation);
  const side = await two.side(A);
  const server = (await two.ctx(A)).engine;
  const N = 16;
  const g = gate();
  emulator.script(Array.from({ length: N }, () => ({ wait: g.promise, usage })));
  let early = 0;
  const results = Array.from({ length: N }, (_, i) => (i % 2 ? side.engine : server).call({ purpose: 'chat', messages, maxTokens: 64 })
    .then(r => ({ ok: true, r }), e => { early += 1; return { ok: false, e }; }));

  // Wait until every call is either at the emulator or refused, or nothing changes for a while
  // (calls queued behind an in-flight round).
  let last = -1;
  let since = Date.now();
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    const n = emulator.requests.length + early;
    if (n === N) break;
    if (n !== last) { last = n; since = Date.now(); } else if (Date.now() - since > 750) break;
    await pause(20);
  }
  assert.ok(emulator.requests.length >= 1, 'at least one round was admitted');
  const inFlight = await budget.committedUsd(two.platform, { householdId: A, month: month() });
  assert.ok(inFlight <= allocation + 1e-9, `in-flight committed ${inFlight} within ${allocation}`);
  assert.ok(emulator.requests.length * est.costUsd <= allocation + 1e-9, 'only reservations that fit were dispatched');

  g.open();
  const all = await Promise.all(results);
  const ok = all.filter(x => x.ok).length;
  const failed = all.filter(x => !x.ok);
  for (const f of failed) assert.ok(f.e instanceof E.BudgetExceededError || f.e?.name === 'BudgetExceededError', f.e?.stack);
  assert.ok(failed.length >= 1, 'the allocation bound some calls');
  assert.equal(ok, emulator.requests.length, 'every admitted call was dispatched once and every refused call sent nothing');
  const rows = await roundsOf(two.platform, A);
  assert.equal(rows.length, ok);
  for (const row of rows) { assert.equal(row.state, 'settled'); near(row.cost_usd, cost, 'settled cost'); }
  const committed = await budget.committedUsd(two.platform, { householdId: A, month: month() });
  assert.ok(committed <= allocation + 1e-9, `committed ${committed} within ${allocation}`);
  near(committed, ok * cost, 'committed is the settled total');

  await server.status();
  await side.engine.status();
  const mirrors = await mirrorsOf((await two.ctx(A)).db);
  assert.equal(mirrors.length, rows.length, 'each round mirrored once across both connections');
  assert.equal(new Set(mirrors.map(m => m.round_id)).size, rows.length);
}));

// ---------------------------------------------------------------------------------- crash and accounting holds

describe('crashes and unknown costs keep their reservation', T, () => {
  const CALL = { purpose: 'chat', messages: QUESTION, maxTokens: 64 };

  test('a crashed round expires to held/interrupted at the next CLI reserve, keeps its reservation and blocks the household', T, async () => withLive({}, async ({ two, emulator, A, B }) => {
    const { budget, pricing } = await mods();
    assert.equal(budget.RESERVATION_TTL_MS, 10 * 60 * 1000);
    emulator.script([{ hang: true }]);
    const pending = (await two.ctx(A)).engine.call(CALL).then(r => r, e => e);
    await emulator.waitForRequests(1);
    const [reserved] = await roundsOf(two.platform, A);
    assert.equal(reserved.state, 'reserved');
    near(reserved.reserved_usd, bound(pricing, CALL), 'reserved bound');

    // Liveness: a reservation still in flight does not block a CLI round.
    const live = await two.side(A);
    await live.engine.call(CALL);
    assert.equal(emulator.requests.length, 2);

    // Past the TTL the next CLI reserve marks it interrupted and refuses.
    const later = await two.side(A, { ...two.engineOptions, fundingNow: () => Date.now() + budget.RESERVATION_TTL_MS + 60_000 });
    await assert.rejects(later.engine.call(CALL), refused('ModelAccountingError', 'accounting_hold'));
    assert.equal(emulator.requests.length, 2, 'the refused round dispatched nothing');
    const held = (await roundsOf(two.platform, A)).find(r => r.id === reserved.id);
    assert.equal(held.state, 'held');
    assert.equal(held.hold_code, 'interrupted');
    assert.equal(held.reserved_usd, reserved.reserved_usd, 'the reservation is kept');
    assert.equal(held.cost_usd, null);

    // Hours later it is still held and never released.
    const muchLater = await two.side(A, { ...two.engineOptions, fundingNow: () => Date.now() + 6 * 3600_000 });
    const committedBefore = await budget.committedUsd(two.platform, { householdId: A, month: month() });
    await assert.rejects(muchLater.engine.call(CALL), refused('ModelAccountingError', 'accounting_hold'));
    const still = (await roundsOf(two.platform, A)).find(r => r.id === reserved.id);
    assert.equal(still.state, 'held');
    assert.equal(still.reserved_usd, reserved.reserved_usd);
    near(await budget.committedUsd(two.platform, { householdId: A, month: month() }), committedBefore, 'committed unchanged');

    // The other household keeps its unreserved credit.
    const from = emulator.requests.length;
    await two.ctx(B).engine.call(CALL);
    assert.equal(emulator.requests.length, from + 1);

    await emulator.close();
    await pending;
    const after = (await roundsOf(two.platform, A)).find(r => r.id === reserved.id);
    assert.equal(after.state, 'held', 'the late transport failure never settles or releases it');
    assert.equal(after.reserved_usd, reserved.reserved_usd);
  }));

  test('risk probe: a settled round whose mirror was lost is restored once by the next CLI round, with no double count', T, async () => withLive({}, async ({ two, emulator, A }) => {
    const { budget, pricing } = await mods();
    const ctx = (await two.ctx(A));
    await ctx.engine.call(CALL);
    await ctx.engine.status();
    const [first] = await roundsOf(two.platform, A);
    assert.equal(first.state, 'settled');
    // Simulate a crash after the provider response and the platform settle, before the mirror.
    await ctx.db.prepare('DELETE FROM spend_ledger WHERE round_id = ?').run(first.id);
    const before = await budget.committedUsd(two.platform, { householdId: A, month: month() });
    near(before, first.cost_usd, 'the platform still holds the settled cost');

    const side = await two.side(A);
    await side.engine.call(CALL);
    await side.engine.status();
    await ctx.engine.status();
    const rows = await roundsOf(two.platform, A);
    assert.equal(rows.length, 2);
    const mirrors = await mirrorsOf(ctx.db);
    assert.equal(mirrors.filter(m => m.round_id === first.id).length, 1, 'the lost mirror is restored exactly once');
    assert.equal(mirrors.filter(m => m.round_id === rows[1].id).length, 1);
    assert.equal(mirrors.length, 2);
    const after = await budget.committedUsd(two.platform, { householdId: A, month: month() });
    near(after, before + pricing.usageCostUsd(emulator.requests[1].model, emulator.requests[1].response.usage), 'no double count');
    near((await side.engine.status()).spentUsd, after, 'status reads the platform total');

    // Settling a settled round again with the same cost is a no-op.
    const ledger = budget.createModelLedger(two.platform, { householdId: A, generation: ctx.generation });
    await ledger.settle(first.id, { costUsd: first.cost_usd, inputTokens: first.input_tokens, outputTokens: first.output_tokens });
    near(await budget.committedUsd(two.platform, { householdId: A, month: month() }), after, 'a second settle changes nothing');
    assert.deepEqual((await roundsOf(two.platform, A))[0], rows[0]);
  }));

  test('a transport error holds the round as cost_unknown with its full reservation; the household refuses, others continue', T, async () => withLive({}, async ({ two, emulator, A, B }) => {
    const { budget, pricing } = await mods();
    const confirm = { purpose: 'confirm', messages: QUESTION, maxTokens: 64 };
    emulator.script([{ destroy: true }]);
    await assert.rejects((await two.ctx(A)).engine.call(confirm));
    const [row] = await roundsOf(two.platform, A);
    assert.equal(row.state, 'held');
    assert.equal(row.hold_code, 'cost_unknown');
    near(row.reserved_usd, bound(pricing, confirm), 'full reservation kept');
    near(await budget.committedUsd(two.platform, { householdId: A, month: month() }), row.reserved_usd, 'the hold counts in full');

    await assert.rejects((await two.ctx(A)).engine.call(confirm), err => err?.name === 'ModelAccountingError');
    const side = await two.side(A);
    await assert.rejects(side.engine.call(confirm), refused('ModelAccountingError', 'accounting_hold'));
    assert.equal(emulator.requests.length, 1, 'no further round dispatched for the held household');
    assert.equal((await roundsOf(two.platform, A)).length, 1);

    // B: an HTTP error is a known zero-cost round and leaves B able to call.
    emulator.script([{ status: 500 }]);
    await assert.rejects((await two.ctx(B)).engine.call(confirm), err => err?.name === 'ModelCallError');
    const [failed] = await roundsOf(two.platform, B);
    assert.equal(failed.state, 'settled');
    assert.equal(failed.cost_usd, 0);
    const res = await two.ctx(B).engine.call(confirm);
    assert.equal(res.text, 'Synthetic answer with no figures.');
    assert.equal((await roundsOf(two.platform, B)).length, 2);
  }));

  test('usage above the reserved bound holds reservation_bound_exceeded with the debt recorded', T, async () => withLive({}, async ({ two, emulator, A, B }) => {
    const { budget, pricing } = await mods();
    const usage = { input_tokens: 2_000_000, output_tokens: 10 };
    emulator.script([{ usage }]);
    await assert.rejects((await two.ctx(A)).engine.call(CALL));
    const [row] = await roundsOf(two.platform, A);
    const cost = pricing.usageCostUsd(emulator.requests[0].model, usage);
    assert.ok(cost > row.reserved_usd, 'precondition: the usage exceeds the bound');
    assert.equal(row.state, 'held');
    assert.equal(row.hold_code, 'reservation_bound_exceeded');
    near(row.cost_usd, cost, 'the actual cost is recorded');
    near(await budget.committedUsd(two.platform, { householdId: A, month: month() }), cost, 'the debt counts, never erased');
    const side = await two.side(A);
    await assert.rejects(side.engine.call(CALL), refused('ModelAccountingError', 'accounting_hold'));
    assert.equal(emulator.requests.length, 1);
    await two.ctx(B).engine.call(CALL);
    assert.equal(emulator.requests.length, 2, 'the other household still calls');
  }));
});

// ---------------------------------------------------------------------------------- funding month and carry

describe('funding months and legacy spend', T, () => {
  const CALL = { purpose: 'chat', messages: QUESTION, maxTokens: 64 };

  test('the funding month comes from fundingNow, not FATHOM_CLOCK', T, async () => withLive({ fundingNow: () => Date.parse('2027-03-15T12:00:00.000Z') }, async ({ two, A }) => {
    await two.ctx(A).engine.call(CALL);
    const [row] = await roundsOf(two.platform, A);
    assert.equal(row.month, '2027-03');
  }));

  test('without fundingNow the month is the actual UTC month even when FATHOM_CLOCK names another', T, async () => {
    const emulator = await startModelEmulator();
    let two;
    try {
      two = await liveTwoHouseholds({ emulator, engineOptions: { testTransport: { baseURL: emulator.baseURL } }, extra: { FATHOM_CLOCK: '2025-01-15' } });
      const at = month();
      await two.ctx(two.A.id).engine.call(CALL);
      const [row] = await roundsOf(two.platform, two.A.id);
      assert.ok([at, month()].includes(row.month), `${row.month} is the actual month`);
      assert.notEqual(row.month, '2025-01');
    } finally {
      await emulator.close();
      await two?.close();
    }
  });

  const legacy = async (db, usd) => {
    const ts = new Date().toISOString();
    await db.prepare('INSERT INTO spend_ledger (ts, yyyymm, purpose, cost_usd, model, tokens) VALUES (?, ?, ?, ?, ?, ?)')
      .run(ts, ts.slice(0, 7), 'chat', usd, 'claude-opus-5-5', '{}');
  };

  test('pre-MT-05 spend in the funding month counts against the household allocation, carried once', T, async () => withLive({ allocationUsd: 1 }, async ({ two, emulator, A }) => {
    const { budget, engine: E } = await mods();
    await legacy((await two.ctx(A)).db, 0.99);
    await assert.rejects((await two.ctx(A)).engine.call(CALL), err => err instanceof E.BudgetExceededError);
    assert.equal(emulator.requests.length, 0);

    await budget.setAllocation(two.platform, A, 2);
    await two.ctx(A).engine.call(CALL);
    await two.ctx(A).engine.call(CALL);
    assert.equal(emulator.requests.length, 2);
    const carries = await carriesOf(two.platform, A);
    assert.equal(carries.length, 1, 'one carry row for the month');
    assert.equal(carries[0].state, 'settled');
    assert.equal(carries[0].month, month());
    near(carries[0].cost_usd, 0.99, 'carried legacy spend');
    const rounds = await roundsOf(two.platform, A);
    near(await budget.committedUsd(two.platform, { householdId: A, month: month() }), 0.99 + rounds[0].cost_usd + rounds[1].cost_usd, 'committed');
  }));

  test('carried legacy spend counts against the instance cap shared with the other household', T, async () => withLive({ allocationUsd: 1 }, async ({ two, emulator, A, B }) => {
    const { budget, engine: E, pricing } = await mods();
    const b = bound(pricing, CALL);
    const usage = { input_tokens: 4000, output_tokens: 64 };
    const cost = pricing.usageCostUsd(pricing.modelFor('chat'), usage);
    const L = 1.9;
    const cap = Math.ceil((L + b) * 100) / 100;
    assert.ok(cap < L + cost + b, 'precondition: after A settles, B no longer fits the instance cap');
    await budget.setInstanceCap(two.platform, cap);
    for (const id of [A, B]) await budget.setAllocation(two.platform, id, cap);
    await legacy((await two.ctx(A)).db, L);
    emulator.script([{ usage }]);
    await two.ctx(A).engine.call(CALL);
    await assert.rejects((await two.ctx(B)).engine.call(CALL), err => err instanceof E.BudgetExceededError);
    assert.equal(emulator.requests.length, 1, 'B dispatched nothing');
    await budget.setInstanceCap(two.platform, 3);
    await two.ctx(B).engine.call(CALL);
    assert.equal(emulator.requests.length, 2, 'with more instance credit B is admitted');
  }));

  // An upgraded instance: the household has pre-MT-05 spend in its store and no carry row yet
  // (the fixture's server may already have built A's runtime, so its carry row is removed to
  // reproduce the state before the first post-upgrade construction).
  const upgradedLegacy = async (two, id, usd) => {
    await two.platform.prepare("DELETE FROM model_rounds WHERE household_id = ? AND kind = 'carry'").run(id);
    await legacy((await two.ctx(id)).db, usd);
  };

  test('building a household runtime records its carry, so another household is refused before it ever reserves', T,
    async () => withLive({ instanceCapUsd: 10, allocationUsd: 10 }, async ({ two, emulator, A, B }) => {
      const { budget, engine: E, pricing } = await mods();
      const big = { purpose: 'chat', messages: QUESTION, maxTokens: 60_000 };
      assert.ok(bound(pricing, big) > 1 && bound(pricing, big) < 10, 'precondition: the big bound exceeds the remaining 1');
      assert.ok(bound(pricing, CALL) < 1, 'precondition: the small bound fits the remaining 1');
      await upgradedLegacy(two, A, 9);
      // A's runtime is constructed (the way a CLI or a restarted server builds it); A never calls.
      await two.side(A);
      const carries = (await carriesOf(two.platform, A)).filter(c => c.month === month());
      assert.equal(carries.length, 1, 'construction recorded one carry row for the funding month');
      near(carries[0].cost_usd, 9, 'the carry is the legacy spend');
      assert.equal((await roundsOf(two.platform, A)).length, 0, 'A reserved nothing');
      near(await budget.committedUsd(two.platform, { month: month() }), 9, 'the instance sees A\'s legacy spend');

      await assert.rejects((await two.ctx(B)).engine.call(big), err => err instanceof E.BudgetExceededError);
      assert.equal(emulator.requests.length, 0, 'B dispatched nothing');
      assert.equal((await roundsOf(two.platform, B)).length, 0, 'no round recorded for the refusal');

      // Liveness: a bound under the remaining instance credit is admitted.
      await two.ctx(B).engine.call(CALL);
      assert.equal(emulator.requests.length, 1, 'the small round is admitted');
      // Idempotent: a second construction records no second carry.
      await two.side(A);
      assert.equal((await carriesOf(two.platform, A)).filter(c => c.month === month()).length, 1);
    }));

  // A CLI is the first process to open the upgraded instance: it opens only B, yet A's pre-MT-05
  // spend must already count against the instance cap when B's context is admitted.
  test('a CLI opening one household carries every household\'s legacy spend first', T,
    async () => withLive({ instanceCapUsd: 10, allocationUsd: 10 }, async ({ two, A, B }) => {
      const { budget } = await mods();
      const { loadConfig } = await src('src/config.mjs');
      const { openCliHousehold } = await src('src/platform/cli.mjs');
      await upgradedLegacy(two, A, 9);
      const config = loadConfig(two.server.env);
      assert.equal(config.engine, 'live', 'precondition: a live instance');
      const cli = await openCliHousehold(config, ['--household', B, 'synthetic-arg']);
      try {
        assert.deepEqual(cli.argv, ['synthetic-arg']);
        const carries = (await carriesOf(two.platform, A)).filter(c => c.month === month());
        assert.equal(carries.length, 1, 'opening B recorded A\'s carry');
        near(carries[0].cost_usd, 9, 'A\'s carry is its legacy spend');
        near(await budget.committedUsd(two.platform, { month: month() }), 9, 'the instance sees A\'s legacy spend');
      } finally {
        await cli.close();
      }
    }));

  test('ensureCarry records one carry row per household and month, idempotently', T, async () => withLive({}, async ({ two, A }) => {
    const { budget } = await mods();
    await two.platform.prepare("DELETE FROM model_rounds WHERE household_id = ? AND kind = 'carry'").run(A);
    const now = Date.now();
    assert.equal(typeof budget.ensureCarry, 'function', 'ensureCarry is exported');
    await budget.ensureCarry(two.platform, { householdId: A, month: month(), legacySpendUsd: 1.25, now });
    await budget.ensureCarry(two.platform, { householdId: A, month: month(), legacySpendUsd: 1.25, now });
    const carries = (await carriesOf(two.platform, A)).filter(c => c.month === month());
    assert.equal(carries.length, 1);
    assert.equal(carries[0].state, 'settled');
    near(carries[0].cost_usd, 1.25, 'carried');
    near(await budget.committedUsd(two.platform, { householdId: A, month: month() }), 1.25, 'committed');
  }));
});

describe('node scripts/model-budget.mjs counts every household\'s legacy spend', T, () => {
  test('reductions below a never-reserved household\'s legacy spend are refused', T, async () => {
    const emulator = await startModelEmulator();
    let two;
    try {
      two = await liveTwoHouseholds({ emulator, instanceCapUsd: 100, allocationUsd: 50 });
      const A = two.A.id;
      await two.platform.prepare("DELETE FROM model_rounds WHERE household_id = ? AND kind = 'carry'").run(A);
      const ts = new Date().toISOString();
      await two.ctx(A).db.prepare('INSERT INTO spend_ledger (ts, yyyymm, purpose, cost_usd, model, tokens) VALUES (?, ?, ?, ?, ?, ?)')
        .run(ts, ts.slice(0, 7), 'chat', 9, 'claude-opus-5-5', '{}');
      assert.equal((await roundsOf(two.platform, A)).length, 0, 'precondition: A never reserved');
      const run = (...args) => runCommand(process.execPath, ['scripts/model-budget.mjs', ...args], { env: { FATHOM_DATA: two.dataDir } });
      const no = (r, code) => { assert.equal(r.code, 1, r.stdout + r.stderr); assert.equal(r.stderr, `model-budget: ${code}\n`); assert.equal(r.stdout, ''); };
      no(await run('--instance-cap-usd', '5'), 'below_committed');
      no(await run('--household', A, '--allocation-usd', '5'), 'below_committed');
      const capValue = (await two.platform.prepare("SELECT value FROM platform_settings WHERE key = 'instance_model_cap_usd'").get())?.value;
      assert.equal(JSON.parse(capValue), 100, 'the cap is unchanged');
      assert.equal((await two.platform.prepare('SELECT allocation_usd FROM household_model_budgets WHERE household_id = ?').get(A)).allocation_usd, 50);
      const carries = (await carriesOf(two.platform, A)).filter(c => c.month === month());
      assert.equal(carries.length, 1, 'the command recorded A\'s carry');
      near(carries[0].cost_usd, 9, 'carry');
      // Liveness: a cap above the committed spend is set.
      const r = await run('--instance-cap-usd', '12');
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.equal(r.stdout, 'model-budget: set\n');
    } finally {
      await emulator.close();
      await two?.close();
    }
  });

  test('a suspended household\'s legacy spend counts in reductions', T, async () => {
    const emulator = await startModelEmulator();
    let two;
    try {
      two = await liveTwoHouseholds({ emulator, instanceCapUsd: 100, allocationUsd: 50 });
      const A = two.A.id;
      await two.platform.prepare("DELETE FROM model_rounds WHERE household_id = ? AND kind = 'carry'").run(A);
      const ts = new Date().toISOString();
      await two.ctx(A).db.prepare('INSERT INTO spend_ledger (ts, yyyymm, purpose, cost_usd, model, tokens) VALUES (?, ?, ?, ?, ?, ?)')
        .run(ts, ts.slice(0, 7), 'chat', 9, 'claude-opus-5-5', '{}');
      await two.platform.prepare("UPDATE households SET status = 'suspended' WHERE id = ?").run(A);
      const run = (...args) => runCommand(process.execPath, ['scripts/model-budget.mjs', ...args], { env: { FATHOM_DATA: two.dataDir } });
      const r1 = await run('--instance-cap-usd', '5');
      assert.equal(r1.code, 1, r1.stdout + r1.stderr);
      assert.equal(r1.stderr, 'model-budget: below_committed\n');
      const carries = (await carriesOf(two.platform, A)).filter(c => c.month === month());
      assert.equal(carries.length, 1, 'the suspended household\'s carry was recorded');
      near(carries[0].cost_usd, 9, 'carry');
      // Liveness: a cap above the committed spend is set.
      const r2 = await run('--instance-cap-usd', '12');
      assert.equal(r2.code, 0, r2.stdout + r2.stderr);
      assert.equal(r2.stdout, 'model-budget: set\n');
    } finally {
      await emulator.close();
      await two?.close();
    }
  });
});

// ---------------------------------------------------------------------------------- operator budget command

describe('node scripts/model-budget.mjs', T, () => {
  let emulator;
  let two;
  let A;
  let B;
  const CALL = { purpose: 'chat', messages: QUESTION, maxTokens: 64 };

  before(async () => {
    emulator = await startModelEmulator();
    two = await liveTwoHouseholds({ emulator, instanceCapUsd: null });
    A = two.A.id;
    B = two.B.id;
  });
  after(async () => {
    await emulator?.close();
    await two?.close();
  });

  async function run(...args) {
    const flags = await outboundRows(two.platform);
    const r = await runCommand(process.execPath, ['scripts/model-budget.mjs', ...args], { env: { FATHOM_DATA: two.dataDir } });
    assert.deepEqual(await outboundRows(two.platform), flags, `model-budget ${args.join(' ')} left household_outbound unchanged`);
    return r;
  }
  const ok = (r, line) => { assert.equal(r.code, 0, r.stdout + r.stderr); assert.equal(r.stdout, `${line}\n`); assert.equal(r.stderr, ''); };
  const no = (r, code) => { assert.equal(r.code, 1, r.stdout + r.stderr); assert.equal(r.stderr, `model-budget: ${code}\n`); assert.equal(r.stdout, ''); };
  const capValue = async () => (await two.platform.prepare("SELECT value FROM platform_settings WHERE key = 'instance_model_cap_usd'").get())?.value;
  const allocationRow = async id => (await two.platform.prepare('SELECT allocation_usd FROM household_model_budgets WHERE household_id = ?').get(id))?.allocation_usd;
  const audits = async action => (await two.platform.prepare('SELECT * FROM audit_events WHERE action = ? ORDER BY id').all(action)).map(r => ({ ...r }));

  test('a fresh platform is unfunded and every household starts at zero', async () => {
    const { budget } = await mods();
    assert.equal(await capValue(), undefined);
    assert.equal(await budget.allocationUsd(two.platform, A), 0);
    assert.equal(await budget.allocationUsd(two.platform, B), 0);
    await assert.rejects((await two.ctx(A)).engine.call(CALL), refused('ModelCallError', 'funding_unavailable'));
    assert.equal(emulator.requests.length, 0);
  });

  test('--instance-cap-usd sets the cap once with an audit row; repeats are unchanged', async () => {
    ok(await run('--instance-cap-usd', '100'), 'model-budget: set');
    assert.equal(JSON.parse(await capValue()), 100);
    const rows = await audits('model.instance_cap');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].outcome, 'ok');
    ok(await run('--instance-cap-usd', '100'), 'model-budget: unchanged');
    ok(await run('--instance-cap-usd', '100.00'), 'model-budget: unchanged');
    assert.equal((await audits('model.instance_cap')).length, 1, 'no audit row for an unchanged value');
    ok(await run('--instance-cap-usd', '10000'), 'model-budget: set');
    ok(await run('--instance-cap-usd', '100'), 'model-budget: set');
    assert.equal((await audits('model.instance_cap')).length, 3);
  });

  test('--household --allocation-usd rounds to cents, audits once and funds live calls', async () => {
    ok(await run('--household', A, '--allocation-usd', '12.3456'), 'model-budget: set');
    assert.equal(await allocationRow(A), 12.35);
    const rows = await audits('model.allocation');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].household_id, A);
    assert.equal(rows[0].outcome, 'ok');
    ok(await run('--household', A, '--allocation-usd', '12.35'), 'model-budget: unchanged');
    assert.equal((await audits('model.allocation')).length, 1);
    await two.ctx(A).engine.call(CALL);
    assert.equal(emulator.requests.length, 1, 'the funded household is admitted');
    assert.equal((await two.ctx(A).engine.status()).capUsd, 12.35);
  });

  test('an allocation above the instance cap is refused and changes nothing', async () => {
    no(await run('--household', B, '--allocation-usd', '100.01'), 'allocation_above_cap');
    assert.equal(await allocationRow(B) ?? 0, 0);
    ok(await run('--household', B, '--allocation-usd', '100'), 'model-budget: set');
    assert.equal(await allocationRow(B), 100);
  });

  test('invalid amounts print bad_usd and an unknown household no_such_household', async () => {
    const before = { cap: await capValue(), a: await allocationRow(A), audits: (await two.platform.prepare('SELECT count(*) AS n FROM audit_events').get()).n };
    for (const v of ['-1', '10000.01', 'abc', '1e3']) {
      no(await run('--instance-cap-usd', v), 'bad_usd');
      no(await run('--household', A, '--allocation-usd', v), 'bad_usd');
    }
    no(await run('--household', 'hh-synthetic-unknown', '--allocation-usd', '1'), 'no_such_household');
    assert.deepEqual({ cap: await capValue(), a: await allocationRow(A), audits: (await two.platform.prepare('SELECT count(*) AS n FROM audit_events').get()).n }, before);
  });

  test('reductions below settled spend plus outstanding reservations are refused', async () => {
    const { pricing } = await mods();
    const [settled] = await roundsOf(two.platform, A);
    assert.equal(settled.state, 'settled');
    no(await run('--household', A, '--allocation-usd', '0'), 'below_committed');
    emulator.script([{ hang: true }]);
    const pending = (await two.ctx(A)).engine.call(CALL).then(r => r, e => e);
    await emulator.waitForRequests(2);
    const reservation = bound(pricing, CALL);
    const between = Math.ceil((settled.cost_usd + 0.001) * 100) / 100;
    assert.ok(between > settled.cost_usd && between < settled.cost_usd + reservation, 'precondition');
    no(await run('--household', A, '--allocation-usd', String(between)), 'below_committed');
    no(await run('--instance-cap-usd', String(between)), 'below_committed');
    assert.equal(await allocationRow(A), 12.35);
    assert.equal(JSON.parse(await capValue()), 100);
    ok(await run('--household', A, '--allocation-usd', '1'), 'model-budget: set');
    ok(await run('--instance-cap-usd', '150'), 'model-budget: set');
    await emulator.close();
    await pending;
  });

  test('a hand-set instance_model_cap_usd of 200 is accepted and preserved', async () => {
    const { createAuthStore } = await src('src/auth/store.mjs');
    await createAuthStore(two.platform).setPlatformSetting('instance_model_cap_usd', 200);
    assert.equal(await capValue(), '200');
    const n = (await audits('model.instance_cap')).length;
    ok(await run('--instance-cap-usd', '200'), 'model-budget: unchanged');
    ok(await run('--instance-cap-usd', '200.00'), 'model-budget: unchanged');
    assert.equal(await capValue(), '200');
    assert.equal(JSON.parse(await capValue()), 200);
    assert.equal((await audits('model.instance_cap')).length, n, 'no audit row');
  });
});

// ---------------------------------------------------------------------------------- platform migration 005

test('migration 005 seeds existing households from the hand-set instance cap; a later household starts at zero', T, async () => {
  const { budget, engine: E, outbound } = await mods();
  const emulator = await startModelEmulator();
  let two;
  let server;
  try {
    two = await liveTwoHouseholds({ emulator, instanceCapUsd: null });
    const A = two.A.id;
    const B = two.B.id;
    await two.server.close();
    // Replay migration 005 carrying the hand-set setting production has.
    await withSqlite(join(two.dataDir, 'platform.sqlite'), async db => {
      await db.applySchema('DROP TABLE IF EXISTS model_rounds');
      await db.applySchema('DROP TABLE IF EXISTS household_model_budgets');
      await db.prepare('DELETE FROM schema_migrations WHERE id = 5').run();
      await db.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES ('instance_model_cap_usd', '200', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(Date.now());
    });
    server = await startRuntime({ dataDir: two.dataDir, keys: two.keys, engine: 'live', engineOptions: two.engineOptions,
      extra: { FATHOM_CLAUDE_CREDENTIAL_FILE: two.credentialFile, FATHOM_EMAIL_TO: 'both-member@example.test' } });
    const platform = server.app.platform;
    assert.equal(await budget.allocationUsd(platform, A), 200);
    assert.equal(await budget.allocationUsd(platform, B), 200);

    const admin = sessionClient(server.baseUrl, two.A.admin);
    const r = await admin.postJson('/api/threads', { text: 'Synthetic question after the migration' });
    assert.equal(r.status, 200, r.text.slice(0, 300));
    assert.ok(!r.json.message.notice, 'a live Ask keeps working with no manual step');
    assert.ok(emulator.requests.length >= 1);
    assert.ok((await roundsOf(platform, A)).every(row => row.state === 'settled'));

    const made = await admin.postJson('/api/operator/households', { displayName: 'Synthetic Charlie Household', adminEmail: 'charlie-admin@example.test' });
    assert.equal(made.status, 200, made.text.slice(0, 300));
    const C = made.json.household.id;
    await enrollSession(platform, C, 'charlie-admin@example.test', 'admin');
    outbound.setOutbound(platform, C, { engine: true });
    assert.equal(await budget.allocationUsd(platform, C), 0);
    assert.equal((await platform.prepare('SELECT count(*) AS n FROM household_model_budgets WHERE household_id = ?').get(C)).n, 0);
    const ctx = (await server.app.runtimes.get(C));
    const sent = emulator.requests.length;
    await assert.rejects(ctx.engine.call({ purpose: 'chat', messages: QUESTION, maxTokens: 64 }), err => err instanceof E.BudgetExceededError);
    assert.equal(emulator.requests.length, sent, 'nothing dispatched for the unfunded household');
    await budget.setAllocation(platform, C, 1);
    await ctx.engine.call({ purpose: 'chat', messages: QUESTION, maxTokens: 64 });
    assert.equal(emulator.requests.length, sent + 1, 'an allocated household is admitted');
  } finally {
    await server?.close();
    await emulator.close();
    await two?.close();
  }
});


// ---------------------------------------------------------------------------------- PDF bound

// An image-only PDF is billed per page (each page as an image plus its text), so a compact
// multipage PDF can cost more input tokens than its base64 bytes. createEngine.extract requires the
// page count of a PDF document and adds pages * PDF_PAGE_INPUT_TOKENS to the round's reservation
// bound. A recording reservations adapter and the loopback emulator; nothing leaves the process.
describe('an image-only PDF extract reserves a per-page input bound', T, () => {
  const SYSTEM = 'Synthetic extract system.';
  const PDF = Buffer.from('%PDF-synthetic image-only bytes');
  const INSTRUCTION = { type: 'text', text: 'Return the rows matching the supplied schema.' };
  const messagesOf = source => [{ role: 'user', content: [{ type: 'document', source }, INSTRUCTION] }];

  async function withExtractEngine(fn) {
    const { engine: E, pricing } = await mods();
    const emulator = await startModelEmulator();
    const log = { reserve: [], settle: [], hold: [] };
    let n = 0;
    const reservations = {
      async reserve(args) { log.reserve.push(args); return { roundId: `r-${++n}`, boundUsd: args.boundUsd }; },
      async settle(roundId, result) { log.settle.push([roundId, result]); },
      async hold(roundId, code) { log.hold.push([roundId, code]); },
    };
    try {
      const engine = E.createEngine({ mode: 'live', credential: 'synthetic-credential-not-valid', reservations,
        testTransport: { baseURL: emulator.baseURL } });
      return await fn({ engine, emulator, log, pricing });
    } finally {
      await emulator.close();
    }
  }

  test('PDF_PAGE_INPUT_TOKENS is exported as 5000 and estimateUnknownCost adds extraInputTokens', async () => {
    const { pricing } = await mods();
    assert.equal(pricing.PDF_PAGE_INPUT_TOKENS, 5000);
    const args = { model: pricing.DEFAULT_MODEL, maxTokens: 64, system: SYSTEM, messages: QUESTION, tools: [] };
    const base = pricing.estimateUnknownCost(args);
    const more = pricing.estimateUnknownCost({ ...args, extraInputTokens: 10_000 });
    assert.equal(more.inputTokens, base.inputTokens + 10_000);
    assert.ok(more.costUsd > base.costUsd);
    for (const bad of [-1, 1.5, Number.NaN, '5']) {
      assert.throws(() => pricing.estimateUnknownCost({ ...args, extraInputTokens: bad }), TypeError, String(bad));
    }
  });

  test('a PDF document with pages N reserves the byte estimate plus N * PDF_PAGE_INPUT_TOKENS', async () => withExtractEngine(async ({ engine, emulator, log, pricing }) => {
    const pages = 7;
    const rows = await engine.extract({ document: { type: 'pdf', data: PDF, pages }, schema: ROW_SCHEMA, system: SYSTEM, maxTokens: 256 });
    assert.ok(Array.isArray(rows));
    assert.equal(emulator.requests.length, 1, 'one round dispatched');
    assert.equal(log.reserve.length, 1, 'one reservation');
    const args = { model: pricing.modelFor('extract'), maxTokens: 256, system: SYSTEM, tools: [], schema: responseSchemaOf(ROW_SCHEMA),
      messages: messagesOf({ type: 'base64', media_type: 'application/pdf', data: PDF.toString('base64') }) };
    const expected = pricing.estimateUnknownCost({ ...args, extraInputTokens: pages * pricing.PDF_PAGE_INPUT_TOKENS }).costUsd;
    near(log.reserve[0].boundUsd, expected, 'the PDF reservation bound');
    assert.ok(log.reserve[0].boundUsd > pricing.estimateUnknownCost(args).costUsd, 'above the byte-only estimate');
    assert.equal(log.settle.length, 1);
    assert.equal(log.hold.length, 0);
  }));

  test('a PDF document without an established page count throws TypeError and dispatches nothing', async () => withExtractEngine(async ({ engine, emulator, log }) => {
    for (const pages of [undefined, 0, 101, 2.5, '3', null]) {
      const document = { type: 'pdf', data: PDF, ...(pages === undefined ? {} : { pages }) };
      await assert.rejects(engine.extract({ document, schema: ROW_SCHEMA, system: SYSTEM }), TypeError, `pages ${pages}`);
    }
    assert.equal(emulator.requests.length, 0, 'nothing dispatched');
    assert.equal(log.reserve.length, 0, 'nothing reserved');
  }));

  test('liveness: a text document extract reserves the byte estimate and succeeds', async () => withExtractEngine(async ({ engine, emulator, log, pricing }) => {
    const text = 'Synthetic document body';
    const rows = await engine.extract({ document: { type: 'text', text }, schema: ROW_SCHEMA, system: SYSTEM, maxTokens: 256 });
    assert.ok(Array.isArray(rows));
    assert.equal(emulator.requests.length, 1);
    const expected = pricing.estimateUnknownCost({ model: pricing.modelFor('extract'), maxTokens: 256, system: SYSTEM, tools: [],
      schema: responseSchemaOf(ROW_SCHEMA), messages: messagesOf({ type: 'text', media_type: 'text/plain', data: text }) }).costUsd;
    near(log.reserve[0].boundUsd, expected, 'the text reservation bound');
    assert.equal(log.settle.length, 1);
  }));
});
