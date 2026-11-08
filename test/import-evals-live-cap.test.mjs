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

test('simulated live evaluation records a failed call and marks the other 23 base cases unrun', async () => {
  const { runEvaluation } = await import('../evals/imports/run.mjs');
  let calls = 0;
  const liveEngine = {
    isOn: () => true, credentialStateFor: () => 'loaded', status: () => ({ capUsd: 5, spentUsd: 0 }),
    async call(request) { request.beforeDispatch(); calls++; throw new Error('synthetic transport failure'); },
  };
  const report = await runEvaluation({ liveEngine, liveOptions: { ...options, maxCalls: 1 } });
  assert.equal(calls, 1);
  assert.equal(report.spend.failedCalls, 1);
  assert.ok(report.spend.estimatedCostUsd > 0);
  assert.equal(report.unrun, 23);
  assert.equal(report.cases.filter(c => c.status === 'unrun').length, 23);
  assert.equal(report.ok, false);
  assert.equal(report.spend.stopReason, 'call_cap');
});

test('per-file cumulative output, input and unknown-success accounting stop before the next transport', async () => {
  const output = cappedEngine({ call: async () => ({ accounting: { ...actual, costUsd: 0, tokens: { input_tokens: 10, output_tokens: 4096 } } }) }, options, () => ({ ...estimate, costUsd: 0 }));
  await output.call(request); await output.call(request);
  await assert.rejects(output.call(request), /file_cap/);
  const input = cappedEngine({ call: async () => ({ accounting: { ...actual, costUsd: 0, tokens: { input_tokens: 20000, output_tokens: 1 } } }) }, options, () => ({ ...estimate, costUsd: 0, inputTokens: 20000 }));
  await input.call(request);
  await assert.rejects(input.call(request), /file_cap/);
  const unknown = cappedEngine({ call: async () => ({ text: '{}' }) }, options, () => estimate);
  await unknown.call(request); await unknown.call(request);
  await assert.rejects(unknown.call(request), /file_cap/);
  assert.equal(unknown.report().estimatedCostUsd, 0.5);
});

test('completion uses the same cap and other engine entry points cannot dispatch outside the evaluation', async () => {
  let calls = 0;
  const engine = { call: async () => { calls++; return { text: '{}', accounting: actual }; }, complete: async () => { throw new Error('unguarded'); }, extract: async () => { throw new Error('unguarded'); } };
  const gate = cappedEngine(engine, { ...options, maxCalls: 1 }, () => estimate);
  await gate.complete(request);
  await assert.rejects(gate.complete(request), /evaluation_cap/);
  await assert.rejects(gate.extract({}), /evaluation_purpose/);
  await assert.rejects(gate.call({ ...request, purpose: 'categorize' }), /evaluation_purpose/);
  assert.equal(calls, 1);
});

test('a cost ceiling that cannot admit the first call marks all 24 cases unrun', async () => {
  const { runEvaluation } = await import('../evals/imports/run.mjs');
  let calls = 0;
  const liveEngine = { isOn: () => true, credentialStateFor: () => 'loaded', status: () => ({ capUsd: 5, spentUsd: 0 }), async call() { calls++; throw new Error('must not dispatch'); } };
  const report = await runEvaluation({ liveEngine, liveOptions: { ...options, maxCostUsd: 0.000001 } });
  assert.equal(calls, 0);
  assert.equal(report.unrun, 24);
  assert.equal(report.failed, 0);
  assert.equal(report.passed, 0);
  assert.equal(report.f1, 0);
  assert.equal(report.ok, false);
});
