import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvalStore, writeScorecard } from '../evals/harness.mjs';
import { evidenceNumbers, gradeFigures } from '../evals/graders.mjs';
import { tools } from '../src/tools/index.mjs';

const read = result => [{ name: 'read', args: {}, result }];

test('sourced-number table: sign, cents, abbreviations, rounding, words and context', () => {
  assert.equal(gradeFigures('Expense $17.05.', read({ amount: -17.05 })).ok, true);
  assert.equal(gradeFigures('Expense $1,187.40.', read({ amount: 1187.4 })).ok, true);
  assert.equal(gradeFigures('Expense $1187.40.', read({ amount: 1187.4 })).ok, true);
  assert.equal(gradeFigures('Expense $1,187.00.', read({ amount: 1187 })).ok, true);
  assert.equal(gradeFigures('Available: $1.2k.', read({ amount: 1200 })).ok, true);
  assert.equal(gradeFigures('Book $1.5m.', read({ amount: 1500000 })).ok, true);
  const roundedAbbrev = gradeFigures('About $1.2k.', read({ amount: 1187.4 }));
  assert.equal(roundedAbbrev.rounded[0]?.kind, 'rounded');
  const rounded = gradeFigures('About $1,200.', read({ amount: 1187.4 }));
  assert.equal(rounded.rounded[0]?.kind, 'rounded');
  const spelled = gradeFigures('The gap is twelve hundred dollars.', read({ amount: 1200 }));
  assert.equal(spelled.spelledOut[0]?.kind, 'spelled_out');
  assert.equal(gradeFigures('There are three open items.', read({ items: [{}, {}, {}] })).ok, true);
  const over = gradeFigures('There are twenty one open items.', read({ items: Array.from({ length: 21 }, () => ({})) }));
  assert.equal(over.spelledOut[0]?.kind, 'spelled_out');
  const context = gradeFigures('$123', [], { contextNumbers: [123] });
  assert.equal(context.contextOnly[0]?.kind, 'context-only');
  assert.equal(gradeFigures('$123', read({ amount: 123 }), { contextNumbers: [123] }).ok, true);
});

test('tier 1 demo fixtures state unsigned, dropped-cent and word-count figures', async () => {
  const store = await createEvalStore();
  try {
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
    const ctx = { db: store.db };
    const specs = [
      ['business-pnl-january', 'pnl_by_month', { from: '2026-01', to: '2026-01' }],
      ['goals-pace', 'get_pace', {}],
      ['spending-latest-health', 'query_transactions', { category: 'health', limit: 1 }],
    ];
    for (const [id, name, args] of specs) {
      const result = await byName[name].handler(args, ctx);
      const calls = [{ name, args, result }];
      const answer = fixtureAnswer(calls, result);
      const grade = gradeFigures(answer, calls);
      assert.equal(grade.ok, true, `${id}: ${JSON.stringify(grade)}`);
      const invented = gradeFigures(`${answer} Invented $424,242.42.`, calls);
      assert.equal(invented.ok, false, id);
      assert.ok(invented.unsourced.some(v => v.kind === 'unsourced'), id);
    }
  } finally { await store.close(); }
});

test('violation kinds are the five adjudication kinds and the harness counts them', async () => {
  const flat = [
    gradeFigures('$9', read({ amount: 1 })),
    gradeFigures('$140', read({ a: 100, b: 40 })),
    gradeFigures('about $1,200', read({ amount: 1187.4 })),
    gradeFigures('twelve dollars', read({ amount: 12 })),
    gradeFigures('$50', [], { contextNumbers: [50] }),
  ];
  const kinds = ['unsourced', 'self-computed', 'rounded', 'spelled_out', 'context-only'];
  assert.deepEqual(flat.map(grade => [...grade.unsourced, ...grade.selfComputed, ...grade.rounded, ...grade.spelledOut, ...grade.contextOnly].map(v => v.kind)[0]), kinds);
  const dir = await mkdtemp(join(tmpdir(), 'fathom-grader-score-'));
  try {
    await writeScorecard(dir, { live: false, costUsd: 0, stopped: null, cases: [{
      id: 'sample', status: 'fail', costUsd: 0, turns: [{
        tools: [], required: { checks: [] }, length: { words: 1, maxWords: 40 },
        figures: flat[0], attempts: [{ figures: flat[2] }],
      }],
    }] });
    const summary = await readFile(join(dir, 'summary.md'), 'utf8');
    for (const kind of kinds) assert.match(summary, new RegExp(kind));
    assert.match(summary, /\| sample \|/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function fixtureAnswer(calls, result) {
  const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
  const lengths = [];
  const walk = value => {
    if (Array.isArray(value)) { lengths.push(value.length); value.forEach(walk); }
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(result);
  const counts = [...new Set(lengths.filter(n => n >= 1 && n <= 20))].map(n => `${words[n - 1]} rows`);
  const money = evidenceNumbers(calls).map(n => {
    const abs = Math.abs(n);
    const whole = Math.trunc(abs);
    const exact = abs.toLocaleString('en-US', { maximumFractionDigits: 20 });
    return abs === whole ? `$${whole.toLocaleString('en-US')}` : `$${whole.toLocaleString('en-US')} ($${exact})`;
  });
  return ['Figures follow.', ...counts, ...money].join(' ');
}
