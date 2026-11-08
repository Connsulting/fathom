import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCases, validateCases } from '../evals/cases.mjs';
import { runCases, createEvalLedger, createEvalStore } from '../evals/harness.mjs';
import { ANSWER_STYLE } from '../src/api/answerer.mjs';
import { estimateEvalCost } from '../evals/reservation.mjs';
import { SDK_RESPONSE_BOUND } from '../src/engine/index.mjs';
import { usageCostUsd, DEFAULT_MODEL, TITLE_MODEL, estimateUnknownCost } from '../src/engine/pricing.mjs';
import { main } from '../evals/run.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const one = (id, turn) => ({ id, family: 'freshness', turns: [{
  question: 'Describe the household.', required: [], expected: [],
  forbidden: ['unsourced-figure', 'self-computed-figure'], rubric: 'Stay grounded.', ...turn,
}] });

test('AC1: Ask summary reads are executed evidence even when the model requests no tools', async () => {
  const c = one('summary-read', { required: [{ name: 'household', operation: 'summary', predicates: [] }] });
  const r = await runCases({ cases: [c], scripts: () => [{ text: 'Your household data is available.', costUsd: 0 }] });
  assert.equal(r.cases[0].status, 'pass');
  const calls = r.cases[0].turns[0].tools;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.operation, 'summary');
  assert.ok(calls[0].result.facts);
});

test('AC2: a corrected delivered answer passes and failed superseded drafts are report-only', async () => {
  const c = (await loadCases()).find(c => c.id === 'retirement-hsa-room');
  const r = await runCases({ cases: [c], scripts: ({ attempt }) => attempt
    ? [{ text: '{f:hsa_left}', costUsd: 0 }]
    : [{ toolCalls: [{ name: 'household', args: { operation: 'figures', keys: ['hsa_left'] } }], costUsd: 0 },
      { text: '$987654321 and $876543219', costUsd: 0 }] });
  assert.equal(r.cases[0].status, 'pass');
  assert.equal(r.cases[0].turns[0].failedDrafts, 1);
  assert.equal(r.failedDrafts, 1);
  const bad = await runCases({ cases: [c], scripts: () => [{ text: '$987654321', costUsd: 0 }] });
  assert.equal(bad.cases[0].status, 'fail');
  assert.ok(bad.cases[0].failingChecks.includes('figures.unsourced'));

});

test('AC3: catalog defaults match the prompt and tighter limits require a reason', async () => {
  const cases = await loadCases();
  assert.match(ANSWER_STYLE, /150 words/);
  assert.ok(cases.every(c => c.turns.every(t => t.maxWords === 150 || t.wordLimitReason)));
  assert.throws(() => validateCases([one('tight-limit', { maxWords: 20 })]), /reason/i);
  assert.equal(validateCases([one('tight-limit', { maxWords: 20, wordLimitReason: 'Test concise refusals.' })]), true);
  const r = await runCases({ cases: [one('default-length')], scripts: () => [{ text: 'Qualitative. '.repeat(120), costUsd: 0 }] });
  assert.equal(r.cases[0].status, 'pass');
});

test('AC4: missing operations explain dependent expectations but never mask independent violations', async () => {
  // A synthetic operation that never ships keeps this independent of which reads exist.
  const c = { ...one('missing-operation', { required: [{ name: 'spending', operation: 'not_built', predicates: [] }] }),
    expectedFail: { missingOperations: ['spending.not_built'] } };
  const r = await runCases({ cases: [c], scripts: () => [{ text: "Fathom doesn't have that.", costUsd: 0 }] });
  assert.equal(r.cases[0].status, 'xfail');
  assert.deepEqual(r.cases[0].missingOperations, ['spending.not_built']);
  assert.deepEqual(r.cases[0].turns[0].blockedBy, ['spending.not_built']);
  const bad = await runCases({ cases: [c], scripts: () => [{ text: '$987654321', costUsd: 0 }] });
  assert.equal(bad.cases[0].status, 'fail');
  assert.ok(bad.cases[0].failingChecks.includes('figures.unsourced'));
  const corrected = await runCases({ cases: [c], scripts: ({ attempt }) => [
    { text: attempt ? "Fathom doesn't have that." : '$987654321 and $876543219', costUsd: 0 },
  ] });
  assert.equal(corrected.cases[0].status, 'xfail');
  assert.equal(corrected.failedDrafts, 1);
  const mixed = structuredClone(c);
  mixed.turns[0].required.push({ name: 'household', operation: 'facts', predicates: [{ path: 'keys', op: 'includes', value: 'required-fact' }] });
  const unrelated = await runCases({ cases: [mixed], scripts: () => [
    { toolCalls: [{ name: 'household', args: { operation: 'facts', keys: ['other-fact'] } }], costUsd: 0 },
    { text: "Fathom doesn't have that.", costUsd: 0 },
  ] });
  assert.equal(unrelated.cases[0].status, 'fail');
  assert.ok(unrelated.cases[0].failingChecks.includes('required.household.facts'));
  const cases = await loadCases();
  const q17 = cases.find(c => c.id === 'q17-business-profit-margin').turns[0];
  const q18 = cases.find(c => c.id === 'q18-revenue-vs-last-year').turns[0];
  assert.deepEqual(q17.required[0].predicates.map(p => p.path), ['from', 'to']);
  assert.equal(q18.required.length, 2);
  assert.ok([...q17.required, ...q18.required].every(r => r.predicates.every(p => ['from', 'to', 'entity'].includes(p.path))));
});

test('AC5: an unaffordable round leaves later affordable cases runnable at concurrency one', async () => {
  const cases = ['first-round', 'expensive-round', 'last-round'].map(id => one(id));
  let index = 0;
  const r = await runCases({ cases, maxUsd: 0.12, scripts: () => [{
    text: 'Household data is available.', costUsd: ++index === 2 ? 0.2 : 0.05,
  }] });
  assert.deepEqual(r.cases.map(c => c.status), ['pass', 'budget-stopped', 'pass']);
  assert.equal(r.costUsd, 0.1);
  assert.equal(r.outstandingReservedUsd, 0);
});

test('AC5: synthetic usage rows fit the production SDK reservation bound', async () => {
  // Synthetic English/JSON prompt sizes and SDK usage shapes, not a live usage recording.
  const fixtures = [
    { model: DEFAULT_MODEL, characters: 12000, maxTokens: 1024,
      usage: { input_tokens: 3200, output_tokens: 420, cache_creation_input_tokens: 500 } },
    { model: DEFAULT_MODEL, characters: 60000, maxTokens: 1024,
      usage: { input_tokens: 5000, output_tokens: 700, cache_creation_input_tokens: 7000, cache_read_input_tokens: 4000 } },
    { model: DEFAULT_MODEL, characters: 180000, maxTokens: 1024,
      usage: { input_tokens: 30000, output_tokens: 1024, cache_creation_input_tokens: 10000, cache_read_input_tokens: 6000 } },
    { model: TITLE_MODEL, characters: 6000, maxTokens: 128,
      usage: { input_tokens: 1700, output_tokens: 40 } },
  ];
  const store = await createEvalStore();
  try {
    const ledger = await createEvalLedger({ db: store.db, maxUsd: 10 });
    for (const [i, fixture] of fixtures.entries()) {
      const request = { model: fixture.model, maxTokens: fixture.maxTokens, system: 'Use stored household data. ',
        messages: [{ role: 'user', content: 'Synthetic account context. '.repeat(Math.ceil(fixture.characters / 27)).slice(0, fixture.characters) }], tools: [] };
      await ledger.record({ ts: new Date().toISOString(), purpose: fixture.model === TITLE_MODEL ? 'title' : 'chat',
        model: fixture.model, costUsd: usageCostUsd(fixture.model, fixture.usage), tokens: fixture.usage });
      const row = await store.db.prepare('SELECT model, cost_usd, tokens FROM spend_ledger ORDER BY id DESC LIMIT 1').get();
      const actual = usageCostUsd(row.model, JSON.parse(row.tokens));
      const estimate = estimateEvalCost(request).costUsd;
      assert.equal(actual, row.cost_usd);
      assert.ok(estimate >= actual, `fixture ${i}: reserve covers actual`);
      assert.equal(estimate, Number((estimateUnknownCost(request).costUsd * SDK_RESPONSE_BOUND).toFixed(12)),
        `fixture ${i}: eval admission covers the SDK response bound`);
    }
  } finally { await store.close(); }
});

test('AC6: round receipts report estimate, actual and remaining without answer content', async () => {
  const store = await createEvalStore();
  const rounds = [];
  try {
    const ledger = await createEvalLedger({ db: store.db, maxUsd: 1, onRound: r => rounds.push(r) });
    const request = { purpose: 'chat', system: 'Use data.', messages: [{ role: 'user', content: 'Describe it.' }], tools: [], maxTokens: 128 };
    ledger.begin(request);
    await ledger.admitRound(request);
    await ledger.record({ ts: new Date().toISOString(), purpose: 'chat', model: 'fake', costUsd: 0.001, tokens: {} });
    assert.equal(rounds.length, 1);
    assert.ok(rounds[0].estimateUsd >= rounds[0].actualUsd);
    assert.equal(rounds[0].remainingUsd, 0.999);
    assert.ok(!JSON.stringify(rounds).includes('Describe it'));
  } finally { await store.close(); }
});

test('AC6: CLI stdout preserves failing case IDs and check names without violating figures', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'eval-parity-'));
  const logged = [];
  const original = console.log;
  console.log = line => logged.push(JSON.parse(line));
  try {
    const status = await main(['--cases', 'retirement-hsa-room', '--out', dir], {
      scripts: () => [{ text: '$987654321', costUsd: 0 }],
    });
    assert.equal(status, 1);
    const summary = logged.at(-1);
    assert.equal(summary.scorecard[0].id, 'retirement-hsa-room');
    assert.ok(summary.scorecard[0].failingChecks.includes('figures.unsourced'));
    assert.ok(logged.some(line => line.type === 'round' && line.remainingUsd === 100));
    assert.ok(!JSON.stringify(logged).includes('987654321'));
  } finally { console.log = original; await rm(dir, { recursive: true, force: true }); }
});
