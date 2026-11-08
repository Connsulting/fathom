import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCases, validateCases } from '../evals/cases.mjs';
import { runCases, createEvalLedger, createEvalStore } from '../evals/harness.mjs';
import { ANSWER_STYLE } from '../src/api/answerer.mjs';

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
  const c = structuredClone((await loadCases()).find(c => c.id === 'spending-annual-exclusions'));
  const r = await runCases({ cases: [c] });
  assert.equal(r.cases[0].status, 'xfail');
  assert.ok(r.cases[0].missingOperations.includes('spending.total'));
  const bad = await runCases({ cases: [c], scripts: () => [{ text: '$987654321', costUsd: 0 }] });
  assert.equal(bad.cases[0].status, 'fail');
  assert.ok(bad.cases[0].failingChecks.includes('figures.unsourced'));
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

test('AC6: round receipts report estimate, actual and remaining without answer content', async () => {
  const store = await createEvalStore();
  const rounds = [];
  try {
    const ledger = createEvalLedger({ db: store.db, maxUsd: 1, onRound: r => rounds.push(r) });
    const request = { purpose: 'chat', system: 'Use data.', messages: [{ role: 'user', content: 'Describe it.' }], tools: [], maxTokens: 128 };
    ledger.begin(request);
    ledger.admitRound(request);
    ledger.record({ ts: new Date().toISOString(), purpose: 'chat', model: 'fake', costUsd: 0.001, tokens: {} });
    assert.equal(rounds.length, 1);
    assert.ok(rounds[0].estimateUsd >= rounds[0].actualUsd);
    assert.equal(rounds[0].remainingUsd, 0.999);
    assert.ok(!JSON.stringify(rounds).includes('Describe it'));
  } finally { await store.close(); }
});
