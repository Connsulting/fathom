import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine, BudgetExceededError } from '../src/engine/index.mjs';
import { estimateUnknownCost, DEFAULT_MODEL } from '../src/engine/pricing.mjs';
import { createEvalStore, createEvalLedger, runCases } from '../evals/harness.mjs';
import { loadCases } from '../evals/cases.mjs';

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
});

test('filters select exact cases and reject unknown filters or invalid budget', async () => {
  const r = await cli(['--cases', 'retirement-hsa-room']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.scorecard.cases.map(c => c.id), ['retirement-hsa-room']);
  for (const args of [['--cases', 'unknown-case'], ['--max-usd', '-1'], ['--max-usd', 'NaN']]) assert.notEqual((await cli(args)).status, 0);
  assert.notEqual((await cli(['--live', '--max-usd', '2'], { CI: '1' })).status, 0);
  assert.equal((await cli(['--help'])).status, 0);
});

test('arithmetic transcript fails through real Ask and corrected retries cannot hide it', async () => {
  const cases = await loadCases();
  const c = cases.find(c => c.id === 'retirement-hsa-room');
  const r = await runCases({ cases: [c], scripts: ({ db, attempt }) => {
    if (attempt) return [{ text: '{f:hsa_left}', costUsd: 0 }];
    const values = db.prepare("SELECT v FROM figures WHERE key IN ('hsa_left','hsa_paid')").all();
    return [
      { toolCalls: [{ name: 'get_figures', args: { keys: ['hsa_left', 'hsa_paid'] } }], costUsd: 0 },
      { text: String(values[0].v + values[1].v), costUsd: 0 },
    ];
  } });
  assert.equal(r.cases[0].status, 'fail');
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
    const ledger = createEvalLedger({ db: store.db, maxUsd: 1 });
    assert.equal(ledger.costUsd, 0);
    const request = { purpose: 'chat', system: 'Use tools.', messages: [{ role: 'user', content: 'Read the value.' }], maxTokens: 1024,
      tools: [{ name: 'read', scope: 'read', description: 'Read a value.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: () => ({ value: 10 }) }] };
    const wrapped = ledger.begin(request);
    const engine = createEngine({ mode: 'fake', ledger, capUsd: 1, responses: [
      { toolCalls: [{ name: 'read', args: {} }], costUsd: 0.99 }, { text: '10', costUsd: 0.02 },
    ] });
    await assert.rejects(engine.call(wrapped), BudgetExceededError);
    assert.equal(ledger.state.stopped, 'budget');
    assert.equal(ledger.costUsd, 0.99);
    assert.equal(ledger.reserves.length, 2);
    const transcript = [...request.messages, { role: 'assistant', content: [{ type: 'tool_use', name: 'read', input: {} }] },
      { role: 'tool', content: [{ name: 'read', args: {}, result: { value: 10 } }] }];
    const estimate = estimateUnknownCost({ model: DEFAULT_MODEL, maxTokens: 1024, system: request.system, messages: transcript, tools: request.tools });
    assert.ok(ledger.reserves[1] >= estimate.costUsd);
  } finally { await store.close(); }
});

test('budget admits valid neighboring rounds and records existing engine accounting', async () => {
  const store = await createEvalStore();
  try {
    const ledger = createEvalLedger({ db: store.db, maxUsd: 1 });
    const req = ledger.begin({ purpose: 'chat', system: 'Read.', messages: [{ role: 'user', content: 'Hi.' }], maxTokens: 1024, tools: [] });
    const engine = createEngine({ mode: 'fake', ledger, capUsd: 1, responses: [{ text: 'Hi.', costUsd: 0.01 }] });
    await engine.call(req);
    assert.equal(ledger.state.stopped, null);
    assert.equal(ledger.costUsd, 0.01);
    assert.equal(ledger.monthSpendUsd('203201'), 0.01);
  } finally { await store.close(); }
});

test('budget and unknown accounting stop on their originating case and start no later cases', async () => {
  const cases = (await loadCases()).filter(c => !c.expectedFail).slice(0, 2);
  const stopped = await runCases({ cases, maxUsd: 0 });
  assert.equal(stopped.cases.length, 1);
  assert.equal(stopped.cases[0].status, 'budget-stopped');
  const unknown = await runCases({ cases, scripts: () => [{ text: 'Not available.', costUsd: null }] });
  assert.equal(unknown.cases.length, 1);
  assert.equal(unknown.cases[0].status, 'accounting-stopped');
  assert.ok(unknown.costUsd > 0);
});


test('a corrective Ask retry receives fresh budget admission and stops before a second charge', async () => {
  const c = (await loadCases()).find(c => c.id === 'retirement-hsa-room');
  const r = await runCases({ cases: [c], maxUsd: 10, scripts: () => [{ text: '$987654321', costUsd: 9.99 }] });
  assert.equal(r.cases[0].status, 'budget-stopped');
  assert.equal(r.costUsd, 9.99);
  assert.equal(r.cases[0].turns[0].attempts.length, 2);
});
