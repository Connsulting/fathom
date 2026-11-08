import test from 'node:test';
import assert from 'node:assert/strict';
import { loadModelConfig, selectionFor } from '../src/models/config.mjs';
import { createModelPort, MODEL_ERROR_CODES } from '../src/models/port.mjs';
import { createEngine } from '../src/engine/index.mjs';

const messages = [{ role: 'user', content: 'Return a synthetic greeting.' }];
const config = adapter => ({ ask: { adapter, model: 'synthetic-model', baseUrl: 'http://localhost:9999', inputUsdPerMillion: 1, outputUsdPerMillion: 2 } });
const admitted = () => {
  const events = [];
  return { events, reserve: async r => { events.push(['reserve', r]); return { roundId: 'synthetic-round', boundUsd: r.boundUsd }; },
    settle: async (...a) => events.push(['settle', ...a]), hold: async (...a) => events.push(['hold', ...a]) };
};

test('default selection preserves every existing purpose', () => {
  const c = loadModelConfig({});
  for (const purpose of ['chat', 'job', 'confirm', 'extract', 'title', 'categorize']) {
    const s = selectionFor(c, purpose);
    assert.equal(s.adapter, purpose === 'categorize' ? 'jev' : 'claude');
    assert.equal(s.model, purpose === 'categorize' ? 'jev-1.14.0' : purpose === 'title' ? 'claude-haiku-5-5' : 'claude-opus-5-5');
  }
  assert.throws(() => loadModelConfig({ FATHOM_MODEL_ASK_ADAPTER: 'unknown' }));
  assert.throws(() => loadModelConfig({ FATHOM_MODEL_ASK_ADAPTER: 'openai', FATHOM_MODEL_ASK_MODEL: 'synthetic-model' }));
});

// Wire shapes: OpenAI Chat Completions API reference and Ollama /api/chat documentation.
for (const adapter of ['openai', 'ollama']) {
  test(`${adapter} request, tools, structured JSON, and token accounting`, async () => {
    let body, url;
    const port = createModelPort({ selection: selectionFor(config(adapter), 'chat'), transport: async (u, o) => {
      url = u; body = JSON.parse(o.body);
      return Response.json(adapter === 'openai'
        ? { model: 'synthetic-model', choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 12, completion_tokens: 4 } }
        : { model: 'synthetic-model', done: true, message: { role: 'assistant', content: '{"ok":true}' }, prompt_eval_count: 12, eval_count: 4 });
    } });
    const r = await port.complete({ messages, system: 'Synthetic system', tools: [], maxTokens: 64,
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, registry: { names: [], results: [] } });
    assert.equal(r.text, '{"ok":true}'); assert.equal(r.tokens.input_tokens, 12); assert.equal(r.tokens.output_tokens, 4);
    assert.equal(r.costUsd, .000020); assert.equal(body.model, 'synthetic-model');
    assert.equal(url, `http://localhost:9999/${adapter === 'openai' ? 'chat/completions' : 'api/chat'}`);
    assert.equal(adapter === 'openai' ? body.max_tokens : body.options.num_predict, 64);
    assert.ok(adapter === 'openai' ? body.response_format.json_schema.schema : body.format);
  });
  test(`${adapter} goes through reservation, pause, funding and budget refusal`, async () => {
    let enabled = false, funded = true, calls = 0;
    const reservations = admitted();
    const engine = createEngine({ mode: 'live', credential: { type: 'api-key', value: 'synthetic-key' }, modelConfig: config(adapter),
      allowed: () => enabled, funded: () => funded, reservations, modelTransport: async () => {
        calls++; return Response.json(adapter === 'openai'
          ? { choices: [{ finish_reason: 'stop', message: { content: 'Hello' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }
          : { done: true, message: { content: 'Hello' }, prompt_eval_count: 5, eval_count: 2 });
      } });
    await assert.rejects(engine.call({ purpose: 'chat', messages }), e => e.name === 'EngineOffError');
    enabled = true; funded = false;
    await assert.rejects(engine.call({ purpose: 'chat', messages }), e => e.code === 'funding_unavailable');
    funded = true;
    await assert.rejects(engine.call({ purpose: 'chat', messages, budget: { maxCostUsd: 0 } }), e => e.name === 'BudgetExceededError');
    assert.equal(calls, 0); assert.equal(reservations.events.length, 0);
    const r = await engine.call({ purpose: 'chat', messages });
    assert.equal(r.text, 'Hello'); assert.equal(calls, 1);
    assert.deepEqual(reservations.events.map(x => x[0]), ['reserve', 'settle']);
  });
  for (const [status, code] of [[401, 'authentication'], [429, 'rate_limit'], [400, 'invalid_request'], [503, 'unavailable']]) {
    test(`${adapter} maps HTTP ${status}`, async () => {
      const port = createModelPort({ selection: selectionFor(config(adapter), 'chat'), transport: async () => new Response('', { status }) });
      const r = await port.complete({ messages, maxTokens: 32, tools: [], registry: { names: [], results: [] } });
      assert.equal(r.errorCode, code); assert.equal(r.costUsd, 0); assert.ok(MODEL_ERROR_CODES.includes(r.errorCode));
    });
  }
}

const tool = { name: 'synthetic_read', kind: 'read', operations: [], description: 'Read a synthetic value',
  inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false },
  handler: args => ({ label: args.key }) };
for (const adapter of ['openai', 'ollama']) {
  test(`${adapter} executes registered tools and correlates the continuation`, async () => {
    const bodies = [], reservations = admitted(), entries = [];
    const engine = createEngine({ mode: 'live', modelConfig: config(adapter), reservations,
      ledger: { monthSpendUsd: () => 0, record: entry => entries.push(entry) },
      modelTransport: async (_, options) => {
        const body = JSON.parse(options.body); bodies.push(body);
        if (bodies.length === 1) {
          const call = { id: 'synthetic-call', type: 'function', function: { name: 'synthetic_read', arguments: adapter === 'openai' ? '{"key":"hello"}' : { key: 'hello' } } };
          assert.equal(body.tools[0].function.name, tool.name);
          return Response.json(adapter === 'openai'
            ? { choices: [{ finish_reason: 'tool_calls', message: { content: '', tool_calls: [call] } }], usage: { prompt_tokens: 15, completion_tokens: 5 } }
            : { done: true, message: { content: '', tool_calls: [call] }, prompt_eval_count: 15, eval_count: 5 });
        }
        const result = body.messages.find(m => m.role === 'tool');
        assert.equal(result.tool_call_id, 'synthetic-call');
        assert.equal(result.content, '{"label":"hello"}');
        return Response.json(adapter === 'openai'
          ? { choices: [{ finish_reason: 'stop', message: { content: 'Synthetic answer.' } }], usage: { prompt_tokens: 22, completion_tokens: 8 } }
          : { done: true, message: { content: 'Synthetic answer.' }, prompt_eval_count: 22, eval_count: 8 });
      } });
    const r = await engine.call({ purpose: 'chat', messages, tools: [tool], maxTokens: 128, budget: { maxCostUsd: .1, correlationId: 'synthetic' } });
    assert.equal(r.text, 'Synthetic answer.'); assert.equal(r.toolResults.length, 1); assert.equal(entries.length, 2);
    assert.equal(entries[0].tokens.correlationId, 'synthetic');
    assert.deepEqual(reservations.events.map(e => e[0]), ['reserve', 'settle', 'reserve', 'settle']);
    assert.ok(reservations.events[0][1].boundUsd >= (Buffer.byteLength(JSON.stringify(bodies[0])) + 4096) / 1e6);
  });
  test(`${adapter} pause between tool rounds, predispatch refusal, and recovery`, async () => {
    let enabled = true, calls = 0;
    const reservations = admitted();
    const engine = createEngine({ mode: 'live', modelConfig: config(adapter), reservations, allowed: () => enabled,
      modelTransport: async () => {
        calls++;
        if (calls === 1) return Response.json(adapter === 'openai'
          ? { choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'c', function: { name: tool.name, arguments: '{"key":"x"}' } }] } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }
          : { done: true, message: { tool_calls: [{ function: { name: tool.name, arguments: { key: 'x' } } }] }, prompt_eval_count: 2, eval_count: 3 });
        return Response.json(adapter === 'openai'
          ? { choices: [{ finish_reason: 'stop', message: { content: 'Resumed' } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }
          : { done: true, message: { content: 'Resumed' }, prompt_eval_count: 2, eval_count: 3 });
      } });
    await assert.rejects(engine.call({ purpose: 'chat', messages, tools: [{ ...tool, handler: () => { enabled = false; return {}; } }] }), e => e.code === 'paused');
    assert.equal(calls, 1); assert.equal(reservations.events.filter(e => e[0] === 'reserve').length, 1);
    enabled = true;
    await assert.rejects(engine.call({ purpose: 'chat', messages, beforeDispatch: () => { throw new Error('synthetic refusal'); } }), /synthetic refusal/);
    assert.equal(calls, 1); assert.equal(reservations.events.at(-1)[2].costUsd, 0);
    assert.equal((await engine.call({ purpose: 'chat', messages })).text, 'Resumed');
  });
  test(`${adapter} validates typed choices and JSON without losing paid usage`, async () => {
    const choices = [{ state: { description: 'Synthetic merchant' }, instructions: 'Pick one', options: ['Groceries', 'Business'] }];
    let bad = true;
    const port = createModelPort({ selection: selectionFor(config(adapter), 'chat'), transport: async (_, o) => {
      const body = JSON.parse(o.body);
      assert.ok(adapter === 'openai' ? body.response_format.json_schema.schema.properties.q0 : body.format.properties.q0);
      const content = JSON.stringify({ q0: { choice: bad ? 'Unknown' : 'Groceries', confidence: .9, probabilities: { Groceries: .9, Business: .1 } } });
      return Response.json(adapter === 'openai'
        ? { choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }
        : { done: true, message: { content }, prompt_eval_count: 20, eval_count: 10 });
    } });
    const req = { messages, choices, tools: [], maxTokens: 256 };
    const failed = await port.complete(req); assert.equal(failed.errorCode, 'invalid_response'); assert.ok(failed.costUsd > 0);
    bad = false; assert.equal((await port.complete(req)).choices[0].choice, 'Groceries');
  });
  test(`${adapter} bounds a hung transport and holds missing usage`, async () => {
    const port = createModelPort({ selection: selectionFor(config(adapter), 'chat'), transport: async () => new Promise(() => {}) });
    const timeout = await port.complete({ messages, tools: [], maxTokens: 16, timeoutMs: 5 });
    assert.equal(timeout.errorCode, 'timeout'); assert.equal(timeout.accountingUnknown, true);
    const reservations = admitted();
    const engine = createEngine({ mode: 'live', modelConfig: config(adapter), reservations, modelTransport: async () => Response.json(adapter === 'openai'
      ? { choices: [{ finish_reason: 'stop', message: { content: 'No usage' } }] } : { done: true, message: { content: 'No usage' } }) });
    await assert.rejects(engine.call({ purpose: 'chat', messages }), e => e.code === 'accounting_hold');
    assert.deepEqual(reservations.events.map(e => e[0]), ['reserve', 'hold']);
  });
  test(`${adapter} refuses a binary document before reservation or dispatch`, async () => {
    const reservations = admitted(); let calls = 0;
    const engine = createEngine({ mode: 'live', modelConfig: config(adapter), reservations, modelTransport: async () => { calls++; } });
    await assert.rejects(engine.call({ purpose: 'chat', messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', data: 'synthetic' } }] }] }), /text documents only/);
    assert.equal(calls, 0); assert.equal(reservations.events.length, 0);
  });
}

test('reported aggregator cost settles exactly and an underpriced bound holds', async () => {
  const reservations = admitted(), entries = [];
  const engine = createEngine({ mode: 'live', modelConfig: config('openai'), reservations,
    ledger: { monthSpendUsd: () => 0, record: e => entries.push(e) }, modelTransport: async () => Response.json({
      choices: [{ finish_reason: 'stop', message: { content: 'Synthetic' } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 10 } }) });
  await assert.rejects(engine.call({ purpose: 'chat', messages }), e => e.code === 'accounting_hold');
  assert.equal(reservations.events.at(-1)[2].costUsd, 10); assert.equal(entries[0].costUsd, 10);
});
