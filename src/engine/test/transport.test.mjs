import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeSdkMessages, normalizeSdkRound, messagesRound } from '../live.mjs';
import { DEFAULT_MODEL, usageCostUsd } from '../pricing.mjs';
import { createEngine, createMemoryLedger, ModelAccountingError, ModelCallError } from '../index.mjs';

test('recorded SDK terminal error result remains authoritative when the iterator then throws', async () => {
  // Observed with Agent SDK 0.3.318 in the opt-in tool smoke: result, then exception.
  async function* stream() {
    yield { type: 'system', subtype: 'init', tools: ['mcp__fathom__balance'] };
    yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'synthetic', name: 'balance', input: {} }], usage: { input_tokens: 10, output_tokens: 5 } } };
    yield { type: 'result', subtype: 'error_max_turns', total_cost_usd: 0.006463,
      usage: { input_tokens: 10, output_tokens: 5 } };
    throw new Error('Claude Code returned an error result: Reached maximum number of turns (1)');
  }
  const observed = await consumeSdkMessages(stream());
  assert.equal(observed.result.total_cost_usd, 0.006463);
  assert.equal(observed.result.subtype, 'error_max_turns');
  assert.deepEqual(observed.tools, ['mcp__fathom__balance']);
  async function* crash() { yield { type: 'assistant', message: { content: [], usage: { input_tokens: 10, output_tokens: 5 } } }; throw new Error('subprocess ended'); }
  const partial = await consumeSdkMessages(crash());
  assert.equal(partial.result, undefined);
  assert.equal(partial.usage.output_tokens, 5);
});

test('known partial cost records before the fake engine refuses further spending', async () => {
  const ledger = createMemoryLedger();
  const engine = createEngine({ mode: 'fake', ledger, responses: [
    { text: 'partial', costUsd: 0.01, accountingUnknown: true }, { text: 'must not run', costUsd: 0.01 },
  ] });
  const request = { purpose: 'job', messages: [{ role: 'user', content: 'demo' }] };
  await assert.rejects(engine.call(request), ModelAccountingError);
  await assert.rejects(engine.call(request), ModelAccountingError);
  assert.equal(ledger.entries.length, 1);
  assert.ok(ledger.entries[0].costUsd >= 0.01);
  assert.equal(ledger.entries[0].tokens.knownCostUsd, 0.01);
  assert.equal(ledger.entries[0].tokens.estimated, true);
});

test('success-subtype SDK API errors reject after recording their known cost', async () => {
  for (const flags of [{ is_error: true, api_error_status: null }, { is_error: false, api_error_status: 401 }]) {
    async function* stream() {
      yield { type: 'result', subtype: 'success', ...flags, total_cost_usd: 0,
        result: 'API authentication failed', usage: { input_tokens: 0, output_tokens: 0 } };
    }
    const observed = await consumeSdkMessages(stream());
    const response = normalizeSdkRound(observed, { model: DEFAULT_MODEL, registry: { results: [] }, maxTokens: 128, maxBudgetUsd: 1 });
    const ledger = createMemoryLedger();
    const engine = createEngine({ mode: 'fake', ledger, responses: [response, { text: 'A valid neighboring response', costUsd: 0.01 }] });
    const request = { purpose: 'chat', messages: [{ role: 'user', content: 'Hello' }] };
    await assert.rejects(engine.call(request), ModelCallError);
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].costUsd, 0);
    assert.equal((await engine.call(request)).text, 'A valid neighboring response');
  }
});

test('the observed is_error flag on a paid max-turn tool boundary still permits continuation', async () => {
  const observed = { result: { subtype: 'error_max_turns', is_error: true, api_error_status: null, total_cost_usd: 0.01 }, content: [] };
  const response = normalizeSdkRound(observed, { model: DEFAULT_MODEL, registry: { results: [{ name: 'lookup', result: { value: 42 } }] }, maxTokens: 128, maxBudgetUsd: 1 });
  const engine = createEngine({ mode: 'fake', responses: [{ ...response, toolCalls: [{ name: 'lookup' }] }, { text: '$42', costUsd: 0.001 }] });
  const result = await engine.call({ purpose: 'chat', messages: [{ role: 'user', content: 'Look up the balance' }],
    tools: [{ name: 'lookup', description: 'Read stored data', scope: 'read', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: async () => ({ value: 42 }) }] });
  assert.equal(result.text, '$42');
  assert.equal(result.grounding.ok, true);
});

test('Messages SDK extraction sends the document, stable cache breakpoint and JSON Schema without ambient auth', async () => {
  // SDK 1.5.0 apiKeyAuth emits Bearer authentication; this replaces the older x-api-key SDK shape.
  const originalFetch = globalThis.fetch;
  const captured = [];
  const usage = { input_tokens: 14, output_tokens: 4, cache_read_input_tokens: 100,
    cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 10 } };
  globalThis.fetch = async (url, init) => {
    captured.push({ url: String(url), headers: new Headers(url instanceof Request ? url.headers : init.headers), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'synthetic', type: 'message', role: 'assistant', model: DEFAULT_MODEL,
      content: [{ type: 'text', text: '{"rows":[{"amount":42}]}' }], stop_reason: 'end_turn', stop_sequence: null, usage }),
    { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const schema = { type: 'object', properties: { rows: { type: 'array', items: { type: 'number' } } }, required: ['rows'], additionalProperties: false };
    const messages = [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi1zeW50aGV0aWM=' } }] }];
    const response = await messagesRound({ credential: { type: 'api-key', value: 'synthetic-placeholder' }, system: 'Stable context', messages, maxTokens: 128, model: DEFAULT_MODEL, schema });
    assert.equal(captured[0].headers.get('authorization'), 'Bearer synthetic-placeholder');
    assert.equal(captured[0].headers.get('x-api-key'), null);
    assert.deepEqual(captured[0].body.messages, messages);
    assert.deepEqual(captured[0].body.output_config.format.schema, schema);
    assert.deepEqual(captured[0].body.system[0].cache_control, { type: 'ephemeral' });
    assert.equal(captured[0].body.max_tokens, 128);
    assert.equal(response.costUsd, 0.000286);
  } finally { globalThis.fetch = originalFetch; }
});

test('pricing distinguishes uncached input, both cache write TTLs, cache reads and output', () => {
  assert.equal(usageCostUsd(DEFAULT_MODEL, { input_tokens: 1000000, output_tokens: 1000000,
    cache_creation_input_tokens: 2000000, cache_read_input_tokens: 1000000,
    cache_creation: { ephemeral_5m_input_tokens: 1000000, ephemeral_1h_input_tokens: 1000000 } }), 37.2);
  assert.throws(() => usageCostUsd('unknown', {}), /pricing/);
});
