import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngine, createMemoryLedger, loadCredential, BudgetExceededError } from '../index.mjs';

const enabled = process.env.FATHOM_LIVE === '1' && Boolean(process.env.FATHOM_CLAUDE_CREDENTIAL_FILE);

test('opt-in live SDK tool, caching, per-round accounting and continuation cap', { skip: !enabled, timeout: 180000 }, async () => {
  const credential = await loadCredential(process.env.FATHOM_CLAUDE_CREDENTIAL_FILE);
  const system = 'You are a synthetic financial assistant. Use only tool figures. ' +
    Array.from({ length: 600 }, (_, i) => `Policy ${String.fromCharCode(65 + i % 26)}: Read stored data, give brief grounded advice, and never infer amounts. `).join('') +
    'When asked for a balance call synthetic_balance exactly once. If a tool result is already in the transcript, answer with its amount and do not call a tool again.';
  let calls = 0;
  const tool = { name: 'synthetic_balance', description: 'Read the synthetic balance.', scope: 'read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => { calls++; return { amount: 42 }; } };
  const request = { purpose: 'chat', system, messages: [{ role: 'user', content: 'Call synthetic_balance once, then tell me the balance.' }], tools: [tool], maxTokens: 256 };
  const ledger = createMemoryLedger();
  const result = await createEngine({ mode: 'live', credential, ledger }).call(request);
  assert.ok(calls >= 1);
  assert.ok(ledger.entries.length >= 2);
  assert.equal(ledger.entries.length, result.rounds.length);
  assert.ok(ledger.entries.every(e => e.costUsd > 0));
  assert.ok(result.rounds.every(r => r.tools.length === 1 && r.tools[0] === 'mcp__fathom__synthetic_balance'));
  assert.ok(result.rounds.every(r => r.maxTokens === 256));
  assert.ok(ledger.entries[1].tokens.cache_read_input_tokens > 0);
  assert.match(result.text, /42/);
  const cappedLedger = createMemoryLedger();
  const capped = createEngine({ mode: 'live', credential, ledger: cappedLedger, capUsd: 0.000001 });
  const callsBeforeCap = calls;
  await assert.rejects(capped.call(request), BudgetExceededError);
  assert.equal(cappedLedger.entries.length, 1);
  assert.ok(calls > callsBeforeCap);
  const extractionLedger = createMemoryLedger();
  const extractor = createEngine({ mode: 'live', credential, ledger: extractionLedger });
  const rows = await extractor.extract({ document: { type: 'text', text: 'Synthetic amount: 42 dollars.' },
    schema: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'], additionalProperties: false }, maxTokens: 128 });
  assert.deepEqual(rows, [{ amount: 42 }]);
  assert.equal(extractionLedger.entries.length, 1);
  assert.ok(extractionLedger.entries[0].costUsd > 0);
  console.log(JSON.stringify({ live: 'passed', rounds: ledger.entries.length, costUsd: result.costUsd,
    cacheReadTokens: ledger.entries[1].tokens.cache_read_input_tokens, cappedRounds: cappedLedger.entries.length,
    extractionCostUsd: extractionLedger.entries[0].costUsd, groundingOk: result.grounding.ok }));
});
