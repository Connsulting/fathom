import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeSdkMessages, normalizeSdkRound, messagesRound, wireSchema, WIRE_UNSUPPORTED_KEYWORDS } from '../live.mjs';
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

// Deploy finding: structured outputs reject `minimum`/`maximum` with a 400, which the extract path
// treated as an unknown-cost transport error that disabled the engine until restart.
const findKeywords = (schema, found = new Set()) => {
  if (Array.isArray(schema)) { schema.forEach(s => findKeywords(s, found)); return found; }
  if (!schema || typeof schema !== 'object') return found;
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'properties' || key === '$defs') { Object.values(value).forEach(s => findKeywords(s, found)); continue; }
    if (WIRE_UNSUPPORTED_KEYWORDS.includes(key)) found.add(key);
    findKeywords(value, found);
  }
  return found;
};

test('wireSchema drops unsupported constraints at every depth and keeps properties named like them', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['minimum', 'rows'], properties: {
    minimum: { type: 'number', minimum: 0, maximum: 1 },
    rows: { type: 'array', minItems: 1, items: { anyOf: [{ type: 'string', maxLength: 3, pattern: '^[0-9]+$' }, { type: 'integer', multipleOf: 2 }] } },
  } };
  const wire = wireSchema(schema);
  assert.deepEqual([...findKeywords(wire)], []);
  assert.deepEqual(Object.keys(wire.properties), ['minimum', 'rows']);
  assert.deepEqual(wire.required, ['minimum', 'rows']);
  assert.equal(wire.properties.rows.items.anyOf[0].pattern, '^[0-9]+$');
  assert.equal(schema.properties.minimum.maximum, 1, 'the caller schema is not mutated');
});

test('every ingest extraction schema is free of unsupported keywords on the wire', async () => {
  const { CLASSIFY_SCHEMA, SCHEMAS } = await import('../../ingest/extract.mjs');
  const all = [CLASSIFY_SCHEMA, ...Object.values(SCHEMAS)];
  assert.ok(all.length > 5);
  assert.ok(all.some(s => findKeywords(s).size > 0), 'the source schemas do carry constraints');
  for (const s of all) assert.deepEqual([...findKeywords(wireSchema({ type: 'object', properties: { rows: { type: 'array', items: s } } }))], []);
});

function stubFetch(responses) {
  const original = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const next = responses.shift();
    return new Response(JSON.stringify(next.body), { status: next.status, headers: { 'content-type': 'application/json', 'request-id': 'synthetic' } });
  };
  return { bodies, restore: () => { globalThis.fetch = original; } };
}

const OK_MESSAGE = (text) => ({ id: 'msg_synthetic', type: 'message', role: 'assistant', model: DEFAULT_MODEL, stop_reason: 'end_turn',
  content: [{ type: 'text', text }], usage: { input_tokens: 20, output_tokens: 5 } });
const BAD_REQUEST = { type: 'error', error: { type: 'invalid_request_error', message: 'synthetic schema rejection' } };

test('messagesRound sends the wire schema and maps an HTTP error to a zero-cost api error', async () => {
  const stub = stubFetch([{ status: 400, body: BAD_REQUEST }]);
  try {
    const round = await messagesRound({ credential: { value: 'synthetic-key' }, system: 's', maxTokens: 64, model: DEFAULT_MODEL,
      messages: [{ role: 'user', content: 'x' }], schema: { type: 'object', properties: { c: { type: 'number', minimum: 0, maximum: 1 } }, additionalProperties: false } });
    assert.equal(round.api_error_status, 400);
    assert.equal(round.costUsd, 0);
    assert.equal(round.is_error, true);
    assert.deepEqual(stub.bodies[0].output_config.format.schema.properties.c, { type: 'number' });
  } finally { stub.restore(); }
});

test('a rejected live extract records zero cost and does not disable the engine', async () => {
  const stub = stubFetch([{ status: 400, body: BAD_REQUEST }, { status: 200, body: OK_MESSAGE('{"rows":[{"c":0.5}]}') }, { status: 200, body: OK_MESSAGE('{"rows":[{"c":7}]}') }]);
  const ledger = createMemoryLedger();
  const engine = createEngine({ mode: 'live', credential: 'synthetic-key', ledger });
  const schema = { type: 'object', properties: { c: { type: 'number', minimum: 0, maximum: 1 } }, required: ['c'], additionalProperties: false };
  const document = { type: 'text', text: 'Synthetic confidence one half.' };
  try {
    await assert.rejects(engine.extract({ document, schema, maxTokens: 64 }), ModelCallError);
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].costUsd, 0);
    assert.deepEqual(await engine.extract({ document, schema, maxTokens: 64 }), [{ c: 0.5 }], 'the engine still works after the rejection');
    await assert.rejects(engine.extract({ document, schema, maxTokens: 64 }), ModelCallError, 'the full schema still bounds the value locally');
  } finally { stub.restore(); }
});
