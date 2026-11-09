import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, BudgetExceededError } from '../src/engine/index.mjs';
import { DEFAULT_MODEL, TITLE_MODEL } from '../src/engine/pricing.mjs';
import { estimateEvalCost } from '../evals/reservation.mjs';
import { createEvalStore, createEvalLedger, runCases } from '../evals/harness.mjs';
import { loadCases } from '../evals/cases.mjs';
import { gradeThreadTitle } from '../evals/graders.mjs';

async function cli(args = [], env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'fathom-eval-test-'));
  try {
    const child = spawnSync(process.execPath, ['evals/run.mjs', '--out', dir, ...args], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000,
    });
    let scorecard; try { scorecard = JSON.parse(await readFile(join(dir, 'scorecard.json'), 'utf8')); } catch {}
    return { ...child, scorecard, summary: scorecard ? await readFile(join(dir, 'summary.md'), 'utf8') : '' };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('tier one CLI executes all cases without credentials and writes scorecards in CI', async () => {
  const r = await cli([], { CI: '1', FATHOM_CLAUDE_CREDENTIAL_FILE: '/not-a-credential' });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(r.scorecard.cases.length >= 30);
  assert.ok(r.scorecard.cases.some(c => c.status === 'xfail'));
  assert.ok(r.scorecard.cases.some(c => c.status === 'pass'));
  assert.equal(r.scorecard.costUsd, 0);
  assert.equal(r.scorecard.live, false);
  assert.match(r.summary, /Required|Tools/);
  assert.match(r.summary, /unsourced \/ self-computed \/ rounded \/ spelled_out \/ context-only/);
});

test('filters select exact cases and reject unknown filters or invalid budget', async () => {
  const r = await cli(['--cases', 'retirement-hsa-room']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.scorecard.cases.map(c => c.id), ['retirement-hsa-room']);
  for (const args of [['--cases', 'unknown-case'], ['--max-usd', '-1'], ['--max-usd', 'NaN']]) assert.notEqual((await cli(args)).status, 0);
  assert.notEqual((await cli(['--live', '--max-usd', '2'], { CI: '1' })).status, 0);
  assert.equal((await cli(['--help'])).status, 0);
});

test('arithmetic drafts remain report-only when real Ask delivers a corrected answer', async () => {
  const cases = await loadCases();
  const c = cases.find(c => c.id === 'retirement-hsa-room');
  const r = await runCases({ cases: [c], scripts: async ({ db, attempt }) => {
    if (attempt) return [{ text: '{f:hsa_left}', costUsd: 0 }];
    const values = await db.prepare("SELECT v FROM figures WHERE key IN ('hsa_left','hsa_paid')").all();
    return [
      { toolCalls: [{ name: 'household', args: { operation: 'figures',  keys: ['hsa_left', 'hsa_paid'] } }], costUsd: 0 },
      // Two self-computed figures: since AQ1 a lone unchecked figure is neutralized in place, and only
      // an answer whose figures are mostly unchecked (two or more) is regenerated.
      { text: `${values[0].v + values[1].v}, or ${2 * (values[0].v + values[1].v)} over two years`, costUsd: 0 },
    ];
  } });
  assert.equal(r.cases[0].status, 'pass');
  assert.equal(r.failedDrafts, 1);
  assert.ok(r.cases[0].turns[0].attempts.some(a => a.figures.selfComputed.length));
  assert.ok(r.cases[0].turns[0].attempts.length > 1, 'production retried the arithmetic answer');
});

test('follow-up uses production history and real tools, system prompt and grounding', async () => {
  const c = (await loadCases()).find(c => c.turns.length > 1);
  const r = await runCases({ cases: [c] });
  assert.equal(r.cases[0].status, 'pass');
  assert.equal(r.cases[0].turns.length, 2);
  assert.ok(r.cases[0].turns[1].historyMessages >= 3);
  assert.equal(r.cases[0].turns[0].grounding.ok, true);
  assert.ok(r.cases[0].turns[0].tools.length);
});

test('budget ledger excludes demo spend and refuses a later round inside one engine call', async () => {
  const store = await createEvalStore();
  try {
    const ledger = await createEvalLedger({ db: store.db, maxUsd: 1 });
    assert.equal(await ledger.costUsd, 0);
    const request = { purpose: 'chat', system: 'Use tools.', messages: [{ role: 'user', content: 'Read the value.' }], maxTokens: 1024,
      tools: [{ name: 'read', kind: 'read', operations: [{ name: 'read', scope: 'read' }], description: 'Read a value.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: () => ({ value: 10 }) }] };
    const wrapped = ledger.begin({ ...request, fake: [
      { toolCalls: [{ name: 'read', args: {} }], costUsd: 0.99 }, { text: '10', costUsd: 0.02 },
    ] });
    const engine = createEngine({ admitRound: async req => await ledger.admitRound(req), mode: 'fake', ledger, capUsd: 1, responses: [
      { toolCalls: [{ name: 'read', args: {} }], costUsd: 0.99 }, { text: '10', costUsd: 0.02 },
    ] });
    await assert.rejects(engine.call(wrapped), BudgetExceededError);
    assert.equal(ledger.state.stopped, 'budget');
    assert.equal(await ledger.costUsd, 0.99);
    assert.equal(ledger.reserves.length, 2);
    assert.equal(ledger.reserves[1], 0.02);
  } finally { await store.close(); }
});

test('budget admits valid neighboring rounds and records existing engine accounting', async () => {
  const store = await createEvalStore();
  try {
    const ledger = await createEvalLedger({ db: store.db, maxUsd: 1 });
    const req = ledger.begin({ purpose: 'chat', system: 'Read.', messages: [{ role: 'user', content: 'Hi.' }], maxTokens: 1024, tools: [] });
    const engine = createEngine({ admitRound: async req => await ledger.admitRound(req), mode: 'fake', ledger, capUsd: 1, responses: [{ text: 'Hi.', costUsd: 0.01 }] });
    await engine.call(req);
    assert.equal(ledger.state.stopped, null);
    assert.equal(await ledger.costUsd, 0.01);
    assert.equal(await ledger.monthSpendUsd('203201'), 0.01);
  } finally { await store.close(); }
});

test('budget and unknown accounting stop on their originating case and start no later cases', async () => {
  const cases = (await loadCases()).filter(c => !c.expectedFail).slice(0, 2);
  const stopped = await runCases({ cases, maxUsd: 0 });
  assert.equal(stopped.cases.length, cases.length);
  assert.equal(stopped.cases[1].status, 'unrun');
  assert.match(stopped.cases[1].reason, /budget/);
  assert.equal(stopped.cases[0].status, 'budget-stopped');
  const unknown = await runCases({ cases, scripts: () => [{ text: 'Not available.', costUsd: null }] });
  assert.equal(unknown.cases.length, cases.length);
  assert.equal(unknown.cases[1].status, 'unrun');
  assert.match(unknown.cases[1].reason, /accounting/);
  assert.equal(unknown.cases[0].status, 'accounting-stopped');
  assert.ok(unknown.costUsd > 0);
});


test('a corrective Ask retry receives fresh budget admission and stops before a second charge', async () => {
  const c = (await loadCases()).find(c => c.id === 'retirement-hsa-room');
  const r = await runCases({ cases: [c], maxUsd: 10, scripts: () => [{ text: '$987654321 and $876543219', costUsd: 9.99 }] });
  assert.equal(r.cases[0].status, 'budget-stopped');
  assert.equal(r.costUsd, 9.99);
  assert.equal(r.cases[0].turns[0].attempts.length, 2);
});


test('CLI entrypoint exits nonzero and writes evidence for a self-computed answer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fathom-eval-negative-'));
  try {
    const program = `import {main} from './evals/run.mjs';
      process.exitCode=await main(['--cases','retirement-hsa-room','--out',process.env.EVAL_TEST_OUTPUT],{
        scripts:async ({db})=>[
          {toolCalls:[{name:'household',args:{ operation: 'figures', keys:['hsa_left','hsa_paid']}}],costUsd:0},
          {text:String((await db.prepare("SELECT sum(v) AS v FROM figures WHERE key IN ('hsa_left','hsa_paid')").get()).v),costUsd:0}
        ]});`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', program], {
      cwd: new URL('../', import.meta.url), env: { ...process.env, EVAL_TEST_OUTPUT: dir }, encoding: 'utf8', timeout: 60000,
    });
    assert.equal(r.status, 1, r.stderr);
    const report = JSON.parse(await readFile(join(dir, 'scorecard.json'), 'utf8'));
    assert.equal(report.cases[0].status, 'fail');
    assert.ok(report.cases[0].turns[0].attempts[0].figures.selfComputed.length);
    const logged = r.stdout.trim().split('\n').map(line => JSON.parse(line));
    const summary = logged.at(-1);
    assert.equal(summary.scorecard[0].id, 'retirement-hsa-room');
    assert.ok(summary.scorecard[0].failingChecks.includes('figures.self-computed'));
    assert.equal(summary.correctionTriggers['figures.self-computed'], 1);
    assert.ok(logged.some(line => line.type === 'round' && line.estimateUsd === 0 && line.actualUsd === 0 && line.remainingUsd === 100));
    assert.ok(summary.scorecard.every(row => !Object.hasOwn(row, 'delivered') && !Object.hasOwn(row, 'figures')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing tool markers never mask an unrelated failed follow-up', async () => {
  const cases = await loadCases();
  const c = structuredClone(cases.find(c => c.id === 'spending-annual-exclusions'));
  c.turns.push(structuredClone(cases.find(c => c.id === 'retirement-hsa-room').turns[0]));
  const r = await runCases({ cases: [c], scripts: ({ turn }) => turn.required[0].name === 'spending'
    ? [{ text: "Fathom doesn't have that.", costUsd: 0 }]
    : [{ toolCalls: [{ name: 'household', args: { operation: 'figures',  keys: ['hsa_left'] } }], costUsd: 0 }, { text: 'No figure provided.', costUsd: 0 }] });
  assert.equal(r.cases[0].status, 'fail');
});

test('unavailable cases accept a clear refusal in ordinary wording', async () => {
  const c = (await loadCases()).find(c => c.id === 'unavailable-credit-score');
  const r = await runCases({ cases: [c], scripts: () => [
    { toolCalls: [{ name: 'household', args: { operation: 'facts', } }], costUsd: 0 }, { text: "Fathom doesn't track your credit score.", costUsd: 0 },
  ] });
  assert.equal(r.cases[0].status, 'pass');
});

const budgetCatalog = n => Array.from({ length: n }, (_, i) => ({
  id: `budget-case-${i}`, family: 'goals', turns: [{ question: 'Discuss education savings.', required: [],
    forbidden: ['unsourced-figure', 'self-computed-figure'], expected: [], maxWords: 100, wordLimitReason: 'Keep budget fixtures brief.',
    rubric: 'Stay qualitative.', scriptedReply: 'Education savings can support the goal.' }],
}));
const paidReply = () => [{ text: 'Education savings can support the goal.', costUsd: 0.05 }];

test('a catalog whose actual spend fits the cap attempts every case and releases reservations', async () => {
  const cases = budgetCatalog(20);
  const r = await runCases({ cases, maxUsd: 1, scripts: paidReply });
  assert.equal(r.completed, cases.length);
  assert.equal(r.attempted, cases.length);
  assert.equal(r.stopped, null);
  assert.ok(r.cases.every(c => c.status === 'pass' && c.costUsd === 0.05));
  assert.equal(r.costUsd, 1);
  assert.equal(r.reservedUsd, 1);
  assert.equal(r.outstandingReservedUsd, 0);
});

test('an unaffordable round dispatches nothing and reports every remaining case with its reason', async () => {
  let dispatched = 0;
  const r = await runCases({ cases: budgetCatalog(5), maxUsd: 0.12, scripts: () => {
    dispatched++;
    return paidReply();
  } });
  assert.equal(r.costUsd, 0.1);
  assert.ok(r.costUsd <= r.maxUsd);
  assert.deepEqual(r.cases.map(c => c.status), ['pass', 'pass', 'budget-stopped', 'budget-stopped', 'budget-stopped']);
  assert.equal(r.completed, 2);
  assert.equal(r.attempted, 5);
  assert.equal(dispatched, 5);
  assert.ok(r.cases.slice(2).every(c => /budget/.test(c.reason)));
  assert.equal(r.outstandingReservedUsd, 0);
});

test('budget admission bounds a cost spike before spend can exceed the cap', async () => {
  let i = 0;
  const r = await runCases({ cases: budgetCatalog(4), maxUsd: 0.12, scripts: () => [
    { text: 'Education savings can support the goal.', costUsd: ++i === 2 ? 0.2 : 0.05 },
  ] });
  assert.equal(r.costUsd, 0.1);
  assert.deepEqual(r.cases.map(c => c.status), ['pass', 'budget-stopped', 'pass', 'budget-stopped']);
});

test('stored conversation title uses a model title without amounts and permits 529', async () => {
  const c = (await loadCases()).find(c => c.id === 'goals-conversation-title-529');
  assert.ok(c);
  const r = await runCases({ cases: [c] });
  assert.equal(r.cases[0].status, 'pass');
  assert.equal(r.cases[0].title.title, '529 education savings');
  assert.equal(r.cases[0].title.ok, true);
  assert.equal(r.cases[0].title.source, 'auto');
  const fallback = await runCases({ cases: [c], scripts: ({ purpose }) => [
    { text: purpose === 'title' ? 'invalid JSON' : 'Education savings can support the goal.', costUsd: 0 },
  ] });
  assert.equal(fallback.cases[0].status, 'fail');
  assert.equal(fallback.cases[0].title.ok, false);
});

test('title grading rejects fallback, missing titles and amounts independently of title validation', () => {
  const row = title => ({ title, title_source: 'auto' });
  assert.equal(gradeThreadTitle(row('529 education savings'), 'Discuss my savings').ok, true);
  for (const title of [null, '', 'Discuss my savings', '$2,400 education savings', '2400 education savings',
    '529 dollars education savings', 'two thousand education savings']) {
    assert.equal(gradeThreadTitle(row(title), 'Discuss my savings').ok, false, String(title));
  }
});

test('live reservation uses the actual transcript, output limit and purpose model without synthetic growth', async () => {
  const store = await createEvalStore();
  try {
    const ledger = await createEvalLedger({ db: store.db, maxUsd: 2 });
    const request = { purpose: 'chat', system: 'Use tools.', systemDynamic: 'Current context.', tools: [],
      maxTokens: 128, messages: [{ role: 'user', content: 'Discuss education savings.' }] };
    ledger.begin(request);
    await ledger.admitRound(request);
    const first = estimateEvalCost({ model: DEFAULT_MODEL, maxTokens: 128,
      system: 'Use tools.\nCurrent context.', messages: request.messages, tools: [] }).costUsd;
    assert.equal(ledger.reserves[0], first);
    await ledger.record({ ts: new Date().toISOString(), purpose: 'chat', model: DEFAULT_MODEL, costUsd: 0.001, tokens: {} });
    assert.equal(ledger.outstandingReservedUsd, 0);
    const next = { ...request, messages: [...request.messages, { role: 'assistant', content: 'A short reply.' }] };
    await ledger.admitRound(next);
    assert.equal(ledger.reserves[1], estimateEvalCost({ model: DEFAULT_MODEL, maxTokens: 128,
      system: 'Use tools.\nCurrent context.', messages: next.messages, tools: [] }).costUsd);
    ledger.end();
    ledger.begin({ ...request, purpose: 'title' });
    await ledger.admitRound({ ...request, purpose: 'title' });
    assert.equal(ledger.reserves[2], estimateEvalCost({ model: TITLE_MODEL, maxTokens: 128,
      system: 'Use tools.\nCurrent context.', messages: request.messages, tools: [] }).costUsd);
    assert.ok(ledger.reserves[2] < first);
    ledger.end();
    assert.equal(ledger.outstandingReservedUsd, 0);
  } finally { await store.close(); }
});

test('title calls share the cap and later unaffordable cases are reported', async () => {
  const c = (await loadCases()).find(c => c.id === 'goals-conversation-title-529');
  const r = await runCases({ cases: [c, ...budgetCatalog(1)], maxUsd: 0.06, scripts: ({ purpose }) => [
    { text: purpose === 'title' ? JSON.stringify({ title: '529 education savings' }) : 'Education savings can support the goal.', costUsd: 0.04 },
  ] });
  assert.equal(r.costUsd, 0.04);
  assert.equal(r.cases[0].status, 'budget-stopped');
  assert.match(r.cases[0].reason, /title/);
  assert.equal(r.cases[1].status, 'budget-stopped');
  assert.equal(r.outstandingReservedUsd, 0);
});



test('scorecards count correction triggers per answer even when the delivered answer is clean', async () => {
  const c = (await loadCases()).find(c => c.id === 'unavailable-market-forecast');
  const dir = await mkdtemp(join(tmpdir(), 'fathom-trigger-scorecard-'));
  try {
    const r = await runCases({ cases: [c], outDir: dir, scripts: ({ attempt }) => [
      { toolCalls: [{ name: 'accounts', args: { operation: 'holdings' } }], costUsd: 0 },
      { text: attempt ? "Fathom doesn't have that." : 'Expect forty percent or fifty percent.', costUsd: 0 },
    ] });
    assert.equal(r.cases[0].status, 'pass');
    assert.deepEqual(r.correctionTriggers, { 'figures.spelled_out': 1 });
    assert.deepEqual(r.cases[0].turns[0].discipline.triggeredBy, ['figures.spelled_out']);
    assert.match(await readFile(join(dir, 'summary.md'), 'utf8'), /figures\.spelled_out: 1/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('recorded synthetic live eval overruns fit the reservation, including corrective requests', () => {
  // Admission receipts from the synthetic eval at 6d9e494, rounds 1, 3, 81, 82, 85, 86.
  // Receipts contain costs, not token usage or transcripts; reconstruct byte lengths from
  // the old estimator (ceil(bytes / 3) + 1024, priced as a five-minute cache write).
  const receipts = [
    [0.318715, 0.334673], [0.340835, 0.364248], [0.865815, 0.9678536],
    [0.93785, 1.0877186], [0.865775, 0.9698036], [0.870365, 0.9819436],
  ];
  for (const [estimateUsd, actualUsd] of receipts) {
    const recordedTokens = Math.round((estimateUsd - 1024 * 20 / 1e6) / (5 / 1e6));
    const request = { model: DEFAULT_MODEL, maxTokens: 1024, system: 'Synthetic system.', tools: [],
      messages: [{ role: 'user', content: '' }] };
    const emptyBytes = Buffer.byteLength(JSON.stringify({ system: request.system, messages: request.messages, tools: [] }));
    request.messages[0].content = 'x'.repeat(3 * (recordedTokens - 1024) - emptyBytes);
    assert.equal(Number(((recordedTokens * 5 + 1024 * 20) / 1e6).toFixed(12)), estimateUsd);
    assert.ok(estimateEvalCost(request).costUsd >= actualUsd, `${estimateUsd} must cover ${actualUsd}`);
    const corrective = { ...request, messages: [...request.messages, { role: 'assistant', content: 'Forty dollars.' },
      { role: 'user', content: 'Correct figures.spelled_out. Write every figure as digits.' }] };
    assert.ok(estimateEvalCost(corrective).costUsd >= actualUsd);
  }
});


test('scripted catalog drafts follow all four steers without a corrective round', async () => {
  const ids = ['business-stored-revenue', 'net-worth-change', 'spending-annual-exclusions', 'spending-latest-groceries'];
  const cases = (await loadCases()).filter(c => ids.includes(c.id));
  assert.equal(cases.length, ids.length);
  const r = await runCases({ cases });
  assert.deepEqual(r.correctionTriggers, {});
  for (const c of r.cases) {
    assert.equal(c.status, 'pass', c.id);
    for (const t of c.turns) {
      assert.equal(t.attempts.length, 1, c.id);
      assert.equal(t.grounding.retried, false, c.id);
      assert.equal(t.attempts[0].figures.ok, true, c.id);
      assert.deepEqual(t.attempts[0].figures.spelledOut, [], c.id);
    }
  }
  const calls = id => r.cases.find(c => c.id === id).turns[0].tools;
  assert.ok(calls(ids[0]).some(t => t.name === 'household' && t.args.operation === 'figures'));
  assert.ok(calls(ids[1]).some(t => t.name === 'calculate' && t.args.operation === 'subtract'));
  assert.ok(calls(ids[2]).some(t => t.name === 'spending' && t.args.operation === 'total'));
  assert.ok(calls(ids[3]).some(t => t.name === 'transactions' && t.args.operation === 'search'));
});


test('a required block cannot pass vacuously when a script omits it', async () => {
  const c = structuredClone((await loadCases()).find(c => c.id === 'retirement-hsa-room'));
  c.blocks = [{ op: 'table' }];
  const result = await runCases({ cases: [c] });
  assert.equal(result.cases[0].status, 'fail');
  assert.ok(result.cases[0].failingChecks.includes('block_missing'));
});

test('gradeBlocks identifies every violation and accepts the real snapshot', async () => {
  const { gradeBlocks } = await import('../evals/graders.mjs');
  const { buildSnapshot } = await import('../src/blocks/snapshot.mjs');
  const call = { name: 'transactions', args: { operation: 'search' }, result: { rows: [{ date: '2026-03-01', amount: -12 }] } };
  const spec = { source: { tool: call.name, args: call.args, path: 'rows' }, columns: ['date', 'amount'] };
  const block = { id: 'b1', op: 'table', calls: [{ tool: call.name, args: call.args }], spec, snapshot: buildSnapshot('table', spec, [call]) };
  const grade = (b, calls = [call], notes = []) => gradeBlocks({ blocks: b, blockNotes: notes }, calls, [{ op: 'table' }]);
  assert.equal(grade([block]).ok, true);
  assert.equal(grade([]).violations[0].kind, 'block_missing');
  assert.ok(grade([block], []).violations.some(v => v.kind === 'block_unreferenced'));
  const badValue = structuredClone(block); badValue.snapshot.rows[0].cells[1].value++;
  assert.ok(grade([badValue]).violations.some(v => v.kind === 'block_value_mismatch'));
  for (const spec of [{ ...block.spec, title: 'Double spending' }, { ...block.spec, injected: 12 }]) {
    assert.ok(grade([{ ...block, spec }]).violations.some(v => v.kind === 'block_literal'));
  }
  assert.ok(grade([block], [call], [{ reason: 'bad_input' }]).violations.some(v => v.kind === 'block_dropped'));
});
