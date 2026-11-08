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
