import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeSdkMessages, normalizeSdkRound, assistantText, messagesRound, sdkOptions, encodeTranscript, wireSchema, WIRE_UNSUPPORTED_KEYWORDS } from '../live.mjs';
import { DEFAULT_MODEL, usageCostUsd } from '../pricing.mjs';
import { createEngine, createMemoryLedger, ModelAccountingError, ModelCallError } from '../index.mjs';
import * as engineModule from '../index.mjs';

test('distinct assistant frames keep identical text, including a repeated digit', async () => {
  const frames = ['Set aside $1', '0', '0', '.'];
  async function* stream() {
    for (let n = 0; n < frames.length; n += 1) {
      yield { type: 'assistant', message: { id: `msg_${n}`, content: [{ type: 'text', text: frames[n] }], usage: { output_tokens: 1 } } };
    }
    yield { type: 'result', subtype: 'success', result: '.', total_cost_usd: 0.01 };
  }
  const observed = await consumeSdkMessages(stream());
  const round = normalizeSdkRound(observed, { model: DEFAULT_MODEL, registry: { results: [] }, maxTokens: 32, maxBudgetUsd: 1 });
  assert.equal(round.text, 'Set aside $100.');
  // One response streamed as one-block frames that share message.id (the real SDK shape; see
  // sdkResponse below). Each frame carries only its own block, so appending keeps the figure.
  async function* sameMessage() {
    yield* sdkResponse('msg_same', [{ type: 'text', text: 'Set aside $1' }, { type: 'text', text: '00.' }]);
    yield { type: 'result', subtype: 'success', result: '00.', total_cost_usd: 0.01 };
  }
  const again = normalizeSdkRound(await consumeSdkMessages(sameMessage()), { model: DEFAULT_MODEL, registry: { results: [] }, maxTokens: 32, maxBudgetUsd: 1 });
  assert.equal(again.text, 'Set aside $100.');
});

// Real SDK framing (Agent SDK 0.3.318, node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts,
// SDKAssistantMessage and SDKPartialAssistantMessage): with includePartialMessages the CLI yields
// { type: 'stream_event', event: <raw Messages API stream event>, parent_tool_use_id: null, uuid,
// session_id } frames (message_start, content_block_start, content_block_delta, content_block_stop,
// message_delta, message_stop), and after each content_block_stop one { type: 'assistant', message:
// { id, content: [<that one completed block>], stop_reason: null, usage: <not final> }, uuid } frame.
// Consecutive assistant frames of one response share message.id and each carries only its own block.
// The result's `result` is the text of the last completed block only ('' after a tool_use block).
// A frame may carry `supersedes: [uuid, ...]` naming earlier frames it replaces (refusal fallback).
// `supersedes` maps a block index to the uuids its assistant frame supersedes. The assistant frame
// for block n has uuid `${id}_block${n}`.
function* sdkResponse(id, blocks, { supersedes = {} } = {}) {
  let seq = 0;
  const wrap = event => ({ type: 'stream_event', event, parent_tool_use_id: null, uuid: `${id}_ev${seq++}`, session_id: 'synthetic-session' });
  yield wrap({ type: 'message_start', message: { id, type: 'message', role: 'assistant', model: DEFAULT_MODEL, content: [],
    stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } });
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'text') {
      yield wrap({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      yield wrap({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
    } else {
      yield wrap({ type: 'content_block_start', index, content_block: { ...block, input: {} } });
      yield wrap({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) } });
    }
    yield wrap({ type: 'content_block_stop', index });
    yield { type: 'assistant', message: { id, type: 'message', role: 'assistant', model: DEFAULT_MODEL, content: [block],
      stop_reason: null, usage: { input_tokens: 10, output_tokens: index + 1 } },
    parent_tool_use_id: null, uuid: `${id}_block${index}`, session_id: 'synthetic-session',
    ...(supersedes[index] ? { supersedes: supersedes[index] } : {}) };
  }
  yield wrap({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: blocks.length } });
  yield wrap({ type: 'message_stop' });
}

async function replay(frames) {
  const streamed = [];
  async function* stream() { yield* frames; }
  const observed = await consumeSdkMessages(stream(), e => { if (e.type === 'text') streamed.push(e.text); });
  const round = normalizeSdkRound(observed, { model: DEFAULT_MODEL, registry: { results: [] }, maxTokens: 128, maxBudgetUsd: 1 });
  return { round, streamed: streamed.join('') };
}

const resultFrame = (result, subtype = 'success') => ({ type: 'result', subtype, result, is_error: false,
  total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 4 }, uuid: 'result_uuid', session_id: 'synthetic-session' });

test('consumeSdkMessages keeps every completed block frame', async () => {
  // (a) Four one-block frames of one response; the result names only the last block.
  const digits = await replay([
    ...sdkResponse('msg_digits', ['Set aside $1', '0', '0', '.'].map(text => ({ type: 'text', text }))),
    resultFrame('.'),
  ]);
  assert.equal(digits.streamed, 'Set aside $100.');
  assert.equal(digits.round.text, 'Set aside $100.');
  assert.equal(digits.round.text, digits.streamed);

  // (b) Text, a tool call and text in one response: the opening before the tool is kept.
  const head = 'Give appreciated assets instead of cash.\n\nSources: "G';
  const tail = 'ifts of appreciated stock" and "Evaluate bunching across tax years."';
  const split = await replay([
    ...sdkResponse('msg_split', [
      { type: 'text', text: head },
      { type: 'tool_use', id: 'toolu_synthetic', name: 'mcp__fathom__household', input: {} },
      { type: 'text', text: tail },
    ]),
    resultFrame(tail),
  ]);
  assert.equal(split.round.text, head + tail);
  assert.equal(split.round.text, split.streamed);

  // (c) A refusal-fallback frame supersedes an earlier text frame: the evicted text is gone.
  const replaced = await replay([
    ...sdkResponse('msg_first', [{ type: 'text', text: 'Opening line. ' }, { type: 'text', text: 'Refused draft text.' }]),
    ...sdkResponse('msg_fallback', [{ type: 'text', text: 'Replacement answer.' }], { supersedes: { 0: ['msg_first_block1'] } }),
    resultFrame('Replacement answer.'),
  ]);
  assert.doesNotMatch(replaced.round.text, /Refused draft/);
  assert.match(replaced.round.text, /Replacement answer\./);
  assert.equal(replaced.round.text, 'Opening line. Replacement answer.');
});

test('superseded SDK frames leave the stream equal to storage', async () => {
  const run = async frames => {
    const events = [];
    async function* stream() { yield* frames; }
    const observed = await consumeSdkMessages(stream(), e => events.push(e));
    const round = normalizeSdkRound(observed, { model: DEFAULT_MODEL, registry: { results: [] }, maxTokens: 128, maxBudgetUsd: 1 });
    let effective = '';
    for (const e of events) {
      if (e.type === 'text') effective += e.text;
      else if (e.type === 'replace') effective = e.text;
    }
    return { round, events, effective };
  };
  const replaced = await run([
    ...sdkResponse('msg_first', [{ type: 'text', text: 'Opening line. ' }, { type: 'text', text: 'Refused draft text.' }]),
    ...sdkResponse('msg_fallback', [{ type: 'text', text: 'Replacement answer.' }], { supersedes: { 0: ['msg_first_block1'] } }),
    resultFrame('Replacement answer.'),
  ]);
  assert.equal(replaced.round.text, 'Opening line. Replacement answer.');
  assert.equal(replaced.events.filter(e => e.type === 'replace').length, 1, 'exactly one replace event');
  assert.equal(replaced.effective, replaced.round.text);
  const plain = await run([
    ...sdkResponse('msg_plain', [{ type: 'text', text: 'Opening line. ' }, { type: 'text', text: 'Kept text.' }]),
    resultFrame('Kept text.'),
  ]);
  assert.equal(plain.events.filter(e => e.type === 'replace').length, 0, 'no supersedes, no replace');
  assert.equal(plain.effective, plain.round.text);
});

test('superseded SDK frames leave the stream equal to storage', () => {
  assert.equal(typeof engineModule.createAnswerAssembler, 'function', 'createAnswerAssembler is exported');
  const a = engineModule.createAnswerAssembler();
  a.beginRound();
  assert.equal(a.streamPiece('Plan A'), 'Plan A');
  a.endRound('Plan A');
  a.beginRound();
  assert.equal(a.streamPiece('Refused'), '\n\nRefused');
  assert.equal(a.replaceRound('Keep a reserve.'), 'Plan A\n\nKeep a reserve.', 'replaceRound returns the full answer so far');
  assert.equal(a.streamPiece(' More.'), ' More.', 'the round has already started');
  a.endRound('Keep a reserve. More.');
  assert.equal(a.text, 'Plan A\n\nKeep a reserve. More.');
  const b = engineModule.createAnswerAssembler();
  b.beginRound();
  b.streamPiece('Plan A');
  b.endRound('Plan A');
  b.beginRound();
  assert.equal(b.replaceRound(''), 'Plan A', 'an empty replacement returns the stored text');
});

test('a shorter SDK result does not replace text blocks split across a tool', () => {
  const head = 'Give appreciated assets instead of cash.\n\nSources: "G';
  const tail = 'ifts of appreciated stock" and "Evaluate bunching across tax years."';
  const content = [
    { type: 'text', text: head },
    { type: 'tool_use', id: 'synthetic', name: 'household', input: {} },
    { type: 'text', text: tail },
  ];
  assert.equal(assistantText(content, tail), head + tail);
  const round = normalizeSdkRound(
    { result: { subtype: 'success', result: tail, total_cost_usd: 0.01 }, content },
    { model: DEFAULT_MODEL, registry: { results: [] }, maxTokens: 128, maxBudgetUsd: 1 },
  );
  assert.equal(round.text, head + tail);
});

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
    tools: [{ name: 'lookup', description: 'Read stored data', kind: 'read', operations: [{ name: 'read', scope: 'read' }], inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: async () => ({ value: 42 }) }] });
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


const TAX_TEXT = 'SSN 900-12-3456; ITIN 900 70 1234; EIN 90-1234567; SSN: 900123456; ITIN: 900701234; EIN: 901234567';
const assertNoTaxIds = value => {
  const text = JSON.stringify(value);
  for (const id of ['900-12-3456', '900 70 1234', '90-1234567', '900123456', '900701234', '901234567']) {
    assert.ok(!text.includes(id), `outbound tax identifier: ${id}`);
  }
};

test('SDK outbound transcript and system text scrub tax identifiers without mutating callers', () => {
  const messages = [
    { role: 'user', content: TAX_TEXT },
    { role: 'assistant', content: [{ type: 'text', text: TAX_TEXT }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'synthetic-evidence', content: JSON.stringify({ filename: `tax_${TAX_TEXT}.pdf`, amount: 123456789, date: '2032-03-05' }) }] },
  ];
  const original = structuredClone(messages);
  const wire = encodeTranscript(messages);
  assertNoTaxIds(wire);
  assert.deepEqual(messages, original);
  assert.ok(wire.includes('123456789'));
  assert.ok(wire.includes('2032-03-05'));
  assert.ok(wire.includes('synthetic-evidence'));
  const options = sdkOptions({ credential: { value: 'synthetic-key' }, configDir: '/synthetic', system: TAX_TEXT, systemDynamic: TAX_TEXT, maxTokens: 64, model: DEFAULT_MODEL });
  assertNoTaxIds(options.systemPrompt);
});

test('Messages outbound body scrubs nested metadata, history and schema descriptions', async () => {
  const stub = stubFetch([{ status: 200, body: OK_MESSAGE('{}') }]);
  const messages = [{ role: 'user', content: [{ type: 'text', text: TAX_TEXT }, { type: 'document', title: `tax_${TAX_TEXT}.pdf`, source: { type: 'text', media_type: 'text/plain', data: TAX_TEXT } }] }];
  const original = structuredClone(messages);
  const schema = { type: 'object', description: TAX_TEXT, properties: { amount: { type: 'number', minimum: 0 }, date: { type: 'string' } }, additionalProperties: false };
  try {
    await messagesRound({ credential: { value: 'synthetic-key' }, system: TAX_TEXT, systemDynamic: TAX_TEXT, messages, schema, model: DEFAULT_MODEL, maxTokens: 64 });
    assertNoTaxIds(stub.bodies[0]);
    assert.deepEqual(messages, original);
    assert.equal(schema.description, TAX_TEXT);
    assert.deepEqual(stub.bodies[0].output_config.format.schema.properties, { amount: { type: 'number' }, date: { type: 'string' } });
  } finally { stub.restore(); }
});

test('MCP replies scrub success and error text while local evidence keeps original data', async () => {
  const { createRegistryServer } = await import('../tools.mjs');
  const result = { filename: `tax_${TAX_TEXT}.pdf`, amount: 123456789, date: '2032-03-05', evidence: { id: 'synthetic-evidence', excerpt: TAX_TEXT } };
  const registry = createRegistryServer([{ name: 'synthetic', kind: 'read', operations: [{ name: 'read', scope: 'read' }], description: TAX_TEXT,
    inputSchema: { type: 'object', properties: { operation: { type: 'string' } }, required: ['operation'], additionalProperties: false },
    handler: async args => {
      if (args.operation === 'fail') { const error = new Error(TAX_TEXT); error.name = 'ToolError'; throw error; }
      return result;
    } }], { purpose: 'chat' });
  const reply = await registry.invoke('synthetic', { operation: 'read' });
  assertNoTaxIds(reply);
  assert.deepEqual(registry.results[0].result, result);
  const wireResult = JSON.parse(reply.content[0].text);
  assert.equal(wireResult.amount, result.amount);
  assert.equal(wireResult.date, result.date);
  assert.equal(wireResult.evidence.id, result.evidence.id);
  const failed = await registry.invoke('synthetic', { operation: 'fail' });
  assert.equal(failed.isError, true);
  assertNoTaxIds(failed);
  const invalid = await registry.invoke('synthetic', { operation: TAX_TEXT, [TAX_TEXT]: 'invalid' });
  assertNoTaxIds(invalid);
});
