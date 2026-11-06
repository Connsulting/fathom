import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngine, createMemoryLedger, EngineOffError, BudgetExceededError, RoundLimitError } from '../index.mjs';
import { createRegistryServer } from '../tools.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { federalIncomeTax } from '../../calc/index.mjs';

const request = { purpose: 'chat', system: 'Use stored figures.', messages: [{ role: 'user', content: 'What is the balance?' }], maxTokens: 128 };
const now = () => new Date('2026-06-15T12:00:00Z');
const read = { name: 'balance', description: 'Read a synthetic balance.', scope: 'read',
  inputSchema: { type: 'object', properties: { account: { type: 'string', enum: ['demo'] } }, required: ['account'], additionalProperties: false },
  handler: async (args, ctx) => ({ value: 125, account: args.account, clock: ctx.now }) };

test('off and cap checks precede response consumption and have live neighboring cases', async () => {
  const ledger = createMemoryLedger();
  await assert.rejects(createEngine({ mode: 'off', ledger, now }).call(request), EngineOffError);
  ledger.record({ ts: now().toISOString(), purpose: 'chat', costUsd: 200, model: 'fake', tokens: {} });
  const blocked = createEngine({ mode: 'fake', ledger, now, responses: [{ text: 'Hello', costUsd: 0.01 }] });
  await assert.rejects(blocked.call(request), BudgetExceededError);
  const allowed = createEngine({ mode: 'fake', ledger, capUsd: 201, now, responses: [{ text: 'Hello', costUsd: 0.01 }] });
  assert.equal((await allowed.call(request)).text, 'Hello');
  assert.equal(ledger.entries.length, 2);
  assert.equal(ledger.monthSpendUsd('202606'), 200.01);
});

test('ledger month is UTC, previous months do not consume current cap', async () => {
  const ledger = createMemoryLedger([{ ts: '2026-05-31T23:59:00Z', purpose: 'job', costUsd: 300, model: 'fake', tokens: {} }]);
  const engine = createEngine({ mode: 'fake', ledger, now, responses: [{ text: 'Ready', costUsd: 0.03 }] });
  await engine.call({ ...request, purpose: 'job' });
  assert.equal(ledger.monthSpendUsd('202606'), 0.03);
  assert.equal(ledger.entries[1].purpose, 'job');
});

test('a tool round is accounted before a continuation cap refusal, with its tool results retained', async () => {
  const ledger = createMemoryLedger();
  let calls = 0;
  const engine = createEngine({ mode: 'fake', ledger, capUsd: 0.01, now, responses: [
    { toolCalls: [{ name: 'balance', args: { account: 'demo' } }], costUsd: 0.02 },
    { text: 'Your balance is $125.', costUsd: 0.02 },
  ] });
  await assert.rejects(engine.call({ ...request, tools: [{ ...read, handler: async () => { calls++; return { value: 125 }; } }] }),
    error => error instanceof BudgetExceededError && error.toolResults[0].result.value === 125);
  assert.equal(calls, 1);
  assert.equal(ledger.entries.length, 1);
});

test('multi-round fake executes the registry, records each round, and returns a grounding verdict', async () => {
  const ledger = createMemoryLedger();
  const engine = createEngine({ mode: 'fake', ledger, now, responses: [
    { toolCalls: [{ name: 'balance', args: { account: 'demo' } }], costUsd: 0.01 },
    { text: 'Your balance is $125. Save $999.', costUsd: 0.02 },
  ] });
  const result = await engine.call({ ...request, tools: [read] });
  assert.equal(result.costUsd, 0.03);
  assert.equal(result.grounding.ok, false);
  assert.equal(result.grounding.violations.length, 1);
  assert.equal(ledger.entries.length, 2);
  assert.equal(result.toolResults[0].result.value, 125);
});

test('registry exposes exact JSON Schema, validates before execution, and removes writes from jobs', async () => {
  let writes = 0;
  const write = { ...read, name: 'set_status', scope: 'write:recs', handler: async () => { writes++; return 'ok'; } };
  const server = createRegistryServer([read, write], { purpose: 'job', ctx: { db: {}, now: 'demo' } });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([client.connect(a), server.instance.connect(b)]);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(t => t.name), ['balance']);
    assert.deepEqual(listed.tools[0].inputSchema, read.inputSchema);
    assert.equal((await client.callTool({ name: 'balance', arguments: { account: 'demo' } })).isError, undefined);
    assert.equal((await client.callTool({ name: 'balance', arguments: { account: 'bad' } })).isError, true);
    assert.equal((await client.callTool({ name: 'set_status', arguments: { account: 'demo' } })).isError, true);
    assert.equal(writes, 0);
  } finally { await client.close(); await server.instance.close(); }
});

test('parallel tools all finish in the paid round and chat handlers receive only the frozen context', async () => {
  const contexts = [];
  const tools = ['alpha', 'beta'].map(name => ({ ...read, name, handler: async (_args, ctx) => { contexts.push(ctx); return { value: 2 }; } }));
  const db = {};
  const engine = createEngine({ mode: 'fake', now, toolContext: { db }, responses: [
    { toolCalls: tools.map(t => ({ name: t.name, args: { account: 'demo' } })), costUsd: 0.01 }, { text: 'Done', costUsd: 0.01 },
  ] });
  assert.equal((await engine.call({ ...request, tools })).toolResults.length, 2);
  assert.ok(contexts.every(ctx => ctx.db === db && ctx.now === now().toISOString()));
  assert.deepEqual(Object.keys(contexts[0]).sort(), ['db', 'now']);
});

test('chat can invoke a recommendation-status write, while invalid scopes fail before a paid round', async () => {
  let writes = 0;
  const write = { ...read, scope: 'write:recs', handler: async () => { writes++; return { status: 'ok' }; } };
  const engine = createEngine({ mode: 'fake', responses: [
    { toolCalls: [{ name: 'balance', args: { account: 'demo' } }], costUsd: 0.01 }, { text: 'Accepted', costUsd: 0.01 },
  ] });
  await engine.call({ ...request, tools: [write] });
  assert.equal(writes, 1);
  const ledger = createMemoryLedger();
  const invalid = createEngine({ mode: 'fake', ledger, responses: [{ text: 'unused' }] });
  await assert.rejects(invalid.call({ ...request, tools: [{ ...read, scope: 'write:money' }] }), /registry/);
  assert.equal(ledger.entries.length, 0);
});

test('typed extraction accepts valid rows and records cost even when validation rejects rows', async () => {
  const schema = { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'], additionalProperties: false };
  const ledger = createMemoryLedger();
  const engine = createEngine({ mode: 'fake', ledger, now, responses: [
    { text: '{"rows":[{"amount":75}]}', costUsd: 0.01 }, { text: '{"rows":[{"amount":"invented"}]}', costUsd: 0.02 },
  ] });
  assert.deepEqual(await engine.extract({ document: { type: 'text', text: 'Synthetic amount 75' }, schema }), [{ amount: 75 }]);
  await assert.rejects(engine.extract({ document: { type: 'pdf', data: Buffer.from('%PDF-synthetic') }, schema }), /schema/);
  assert.equal(ledger.entries.length, 2);
  assert.equal(ledger.entries[1].purpose, 'extract');
  await assert.rejects(createEngine({ mode: 'off' }).extract({ document: { type: 'text', text: 'demo' }, schema }), EngineOffError);
});

test('ledger failures stop work, malformed responses retain known costs, and loops are bounded', async () => {
  const ledger = createMemoryLedger();
  const engine = createEngine({ mode: 'fake', ledger, responses: [{ text: '{broken', costUsd: 0.01 }] });
  await assert.rejects(engine.extract({ document: { type: 'text', text: 'demo' }, schema: { type: 'object' } }), /JSON/);
  assert.equal(ledger.entries.length, 1);
  const bad = createEngine({ mode: 'fake', ledger: { monthSpendUsd: () => { throw new Error('store unavailable'); }, record: () => {} } });
  await assert.rejects(bad.call(request), /store unavailable/);
  const loop = createEngine({ mode: 'fake', responses: Array.from({ length: 8 }, () => ({ toolCalls: [{ name: 'balance', args: { account: 'demo' } }], costUsd: 0.001 })) });
  await assert.rejects(loop.call({ ...request, tools: [read] }), RoundLimitError);
});

test('concurrent calls sharing a ledger check spend after the prior round records', async () => {
  const ledger = createMemoryLedger();
  const engine = createEngine({ mode: 'fake', ledger, capUsd: 0.01, responses: [{ text: 'ok', costUsd: 0.02 }, { text: 'bad', costUsd: 0.02 }] });
  const results = await Promise.allSettled([engine.call(request), engine.call(request)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(ledger.entries.length, 1);
});

test('public gateway drives a real deterministic calculator through registry, ledger and grounding', async () => {
  const ledger = createMemoryLedger();
  const engine = createEngine({ mode: 'fake', ledger, responses: [
    { toolCalls: [{ name: 'tax', args: { taxableIncome: 50400, filingStatus: 'single' } }], costUsd: 0.01 },
    { text: 'The federal income tax is $5,800.', costUsd: 0.01 },
  ] });
  const tool = { name: 'tax', description: 'Calculate ordinary federal tax on synthetic taxable income.', scope: 'read',
    inputSchema: { type: 'object', properties: { taxableIncome: { type: 'number', minimum: 0 }, filingStatus: { const: 'single' } },
      required: ['taxableIncome', 'filingStatus'], additionalProperties: false }, handler: args => federalIncomeTax(args) };
  const result = await engine.call({ ...request, tools: [tool] });
  assert.equal(result.toolResults[0].result.value, 5800);
  assert.ok(result.toolResults[0].result.lawRefs.length);
  assert.equal(result.grounding.ok, true);
  assert.equal(ledger.entries.length, 2);
});

test('invalid tool arguments are recorded and the next model round can correct them', async () => {
  const ledger = createMemoryLedger();
  let handlerCalls = 0;
  const engine = createEngine({ mode: 'fake', ledger, responses: [
    { toolCalls: [{ name: 'balance', args: { account: 'invalid' } }], is_error: true, costUsd: 0.01 },
    { toolCalls: [{ name: 'balance', args: { account: 'demo' } }], is_error: true, costUsd: 0.01 },
    { text: 'The balance is $125.', costUsd: 0.01 },
  ] });
  const result = await engine.call({ ...request, tools: [{ ...read, handler: async () => { handlerCalls++; return { value: 125 }; } }] });
  assert.equal(handlerCalls, 1);
  assert.equal(result.toolResults[0].isError, true);
  assert.match(result.toolResults[0].result.error, /arguments/);
  assert.equal(result.toolResults[1].result.value, 125);
  assert.equal(result.grounding.ok, true);
  assert.equal(ledger.entries.length, 3);
});

test('unknown billed cost reserves spend that survives engine recreation', async () => {
  const ledger = createMemoryLedger();
  const engine = createEngine({ mode: 'fake', ledger, capUsd: 0.001, responses: [{ costUsd: null, accountingUnknown: true }] });
  await assert.rejects(engine.call({ ...request, maxTokens: 1000 }), /cost is incomplete/);
  assert.ok(ledger.entries[0].costUsd >= 1000 * 20 / 1000000);
  assert.equal(ledger.entries[0].tokens.estimated, true);
  const restarted = createEngine({ mode: 'fake', ledger, capUsd: 0.001, responses: [{ text: 'must not run' }] });
  await assert.rejects(restarted.call(request), BudgetExceededError);
});

test('each model round receives the remaining monthly budget', async () => {
  const ledger = createMemoryLedger([{ ts: now().toISOString(), costUsd: 1, purpose: 'chat', model: 'fake', tokens: {} }]);
  const engine = createEngine({ mode: 'fake', ledger, capUsd: 2, now, responses: [
    { toolCalls: [{ name: 'balance', args: { account: 'demo' } }], costUsd: 0.25 },
    { text: 'The balance is $125.', costUsd: 0.1 },
  ] });
  const result = await engine.call({ ...request, tools: [read] });
  assert.equal(result.rounds[0].maxBudgetUsd, 1);
  assert.equal(result.rounds[1].maxBudgetUsd, 0.75);
});

test('an SDK budget stop is recorded before the gateway reports the cap error', async () => {
  const ledger = createMemoryLedger();
  const engine = createEngine({ mode: 'fake', ledger, capUsd: 0.001, responses: [
    { status: 'error_max_budget_usd', is_error: true, costUsd: 0.01, toolCalls: [{ name: 'balance', args: { account: 'demo' } }] },
  ] });
  await assert.rejects(engine.call({ ...request, tools: [read] }), error => error instanceof BudgetExceededError && error.toolResults[0].result.value === 125);
  assert.equal(ledger.entries[0].costUsd, 0.01);
});
