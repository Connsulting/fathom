import test from 'node:test';
import assert from 'node:assert/strict';
import { admitLive, cappedEngine } from '../evals/imports/live-cap.mjs';

const options = { authorized: true, credentials: true, funded: true, maxCostUsd: 5, maxCalls: 24 };
const request = { purpose: 'extract', maxTokens: 4096, budget: { maxCostUsd: 0.5, maxInputTokens: 32768, correlationId: 'import:file-a:call-a' } };
const estimate = { costUsd: 0.25, inputTokens: 200, model: 'synthetic-v1' };
const actual = { costUsd: 0.2, tokens: { input_tokens: 100, output_tokens: 200 }, model: 'synthetic-v1' };

test('live startup requires explicit authorization, credentials, funding and bounded numeric caps', () => {
  assert.doesNotThrow(() => admitLive(options));
  for (const key of ['authorized', 'credentials', 'funded', 'maxCostUsd', 'maxCalls']) assert.throws(() => admitLive({ ...options, [key]: undefined }));
  for (const value of [0, -1, NaN, Infinity, '5', 5.01]) assert.throws(() => admitLive({ ...options, maxCostUsd: value }));
  for (const value of [0, -1, 1.5, 25, '24']) assert.throws(() => admitLive({ ...options, maxCalls: value }));
});

test('24-call run ceiling stops before dispatch and keeps later cases unrun', async () => {
  let calls = 0;
  const gate = cappedEngine({ call: async () => { calls++; return { text: '{}', accounting: { ...actual, costUsd: 0 } }; } }, options, () => estimate);
  for (let i = 0; i < 24; i++) await gate.call({ ...request, budget: { ...request.budget, correlationId: `import:file-${i}:call` } });
  await assert.rejects(gate.call(request), /evaluation_cap/);
  assert.equal(calls, 24); assert.equal(gate.report().calls, 24);
  assert.equal(gate.report().stopReason, 'call_cap');
  assert.equal(gate.report().models['synthetic-v1'].outputTokens, 4800);
});

test('failed calls conservatively consume budget and stop later dispatches at USD 5', async () => {
  let calls = 0;
  const gate = cappedEngine({ call: async () => { calls++; throw new Error('provider unavailable'); } }, options, () => ({ ...estimate, costUsd: 0.5 }));
  for (let i = 0; i < 10; i++) await assert.rejects(gate.call({ ...request, budget: { ...request.budget, correlationId: `import:file-${i}:call` } }), /provider unavailable/);
  await assert.rejects(gate.call(request), /evaluation_cap/);
  assert.equal(calls, 10);
  assert.equal(gate.report().costUsd, 5);
  assert.equal(gate.report().estimatedCostUsd, 5);
  assert.equal(gate.report().failedCalls, 10);
  assert.equal(gate.report().stopReason, 'cost_cap');
});

test('per-file cost, call and token ceilings persist across retries while other files remain live', async () => {
  const engine = { call: async () => ({ text: '{}', accounting: { ...actual, costUsd: 0.1 } }) };
  const gate = cappedEngine(engine, options, () => ({ ...estimate, costUsd: 0.1 }));
  for (let i = 0; i < 4; i++) await gate.call(request);
  await assert.rejects(gate.call(request), /file_cap/);
  await gate.call({ ...request, budget: { ...request.budget, correlationId: 'import:file-b:call' } });
  assert.equal(gate.report().calls, 5);
  const spend = cappedEngine(engine, options, () => ({ ...estimate, costUsd: 0.5 }));
  await spend.call(request);
  await assert.rejects(spend.call(request), /file_cap/);
  const tokens = cappedEngine(engine, options, () => ({ ...estimate, inputTokens: 32769 }));
  await assert.rejects(tokens.call(request), /file_cap/);
  await assert.rejects(gate.call({ ...request, maxTokens: 4097 }), /file_cap/);
});

test('actual and estimated usage retain model version and over-budget provider reports stop the run', async () => {
  const gate = cappedEngine({ call: async () => ({ text: '{}', accounting: actual }) }, options, () => estimate);
  await gate.call(request);
  assert.equal(gate.report().costUsd, 0.2);
  assert.equal(gate.report().actualCostUsd, 0.2);
  assert.equal(gate.report().models['synthetic-v1'].inputTokens, 100);
  const over = cappedEngine({ call: async () => ({ accounting: { ...actual, costUsd: 6 } }) }, options, () => estimate);
  await assert.rejects(over.call(request), /accounting_exceeded/);
  await assert.rejects(over.call(request), /evaluation_cap/);
});
