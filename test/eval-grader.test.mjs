import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvalStore, writeScorecard } from '../evals/harness.mjs';
import { gradeFigures } from '../evals/graders.mjs';
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

test('sourced-number table grades answers over real demo tool results', async () => {
  const store = await createEvalStore();
  try {
    const call = async (name, args) => ({ name, args,
      result: await tools.find(tool => tool.name === name).handler(args, { db: store.db }) });
    const health = await call('query_transactions', { category: 'health', limit: 1 });
    const pace = await call('get_pace', {});
    const expense = Math.abs(health.result.rows[0].amount);
    assert.ok(health.result.rows[0].amount < 0);
    const target = pace.result.goals.find(goal => Number.isInteger(goal.target?.v)).target.v;
    for (const text of [
      `$${expense.toFixed(2)}`, expense.toFixed(2),
      `$${target.toLocaleString('en-US')}.00`, `${target}.00`,
      `$${target / 1000}k`, `${target / 1e6}m`,
      `$${Math.trunc(expense)}`, 'one transaction',
    ]) assert.equal(gradeFigures(text, [health, pace]).ok, true, text);
    const rounded = `$${Math.round(expense / 10) * 10}`;
    assert.equal(gradeFigures(rounded, [health]).rounded.length, 1);
    assert.equal(gradeFigures(`${Math.round(target / 1e6 * 10) / 10}m`, [pace]).rounded.length, 1);
    assert.equal(gradeFigures('seventeen dollars', [health]).spelledOut.length, 1);
    const context = store.db.prepare('SELECT v FROM figures WHERE v > 0 LIMIT 1').get().v;
    assert.equal(gradeFigures(`$${context}`, [], { contextNumbers: [context] }).contextOnly.length, 1);
  } finally { await store.close(); }
});

test('formatting preserves units, cent precision and dropped-cent direction', () => {
  assert.equal(gradeFigures('1.5m', read({ amount: 1500000.50 })).ok, false);
  assert.equal(gradeFigures('$1,188', read({ amount: 1187.40 })).ok, false);
  assert.equal(gradeFigures('$1,188', read({ amount: 1187.60 })).rounded.length, 1);
  assert.equal(gradeFigures('$1,187', read({ amount: -1187.40 })).ok, true);
  assert.equal(gradeFigures('$1.5 million', read({ amount: 1500000 })).ok, true);
  assert.equal(gradeFigures('$1,000,000.01', read({ amount: 1000000.02 })).ok, false);
  assert.equal(gradeFigures('1,000,000.01', read({ amount: 1000000.02 })).ok, false);
});

test('tier 1 demo fixtures state unsigned, dropped-cent and word-count figures', async () => {
  const store = await createEvalStore();
  try {
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));
    const ctx = { db: store.db };
    const specs = [
      ['business-pnl-january', 'pnl_by_month', { from: '2026-01', to: '2026-01' }, result =>
        [...result.rows.map(row => row.amount), ...Object.values(result.totals)]],
      ['goals-pace', 'get_pace', {}, result => {
        const values = [];
        const walk = value => {
          if (!value || typeof value !== 'object') return;
          if (Number.isFinite(value.v)) values.push(value.v);
          else Object.values(value).forEach(walk);
        };
        walk(result);
        return values;
      }],
      ['spending-latest-health', 'query_transactions', { category: 'health', limit: 1 }, result =>
        [...result.rows.map(row => row.amount), result.total]],
    ];
    for (const [id, name, args, values] of specs) {
      const result = await byName[name].handler(args, ctx);
      const calls = [{ name, args, result }];
      const answer = fixtureAnswer(values(result), result);
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
        figures: flat[0], attempts: flat.slice(1).map(figures => ({ figures })),
      }],
    }] });
    const summary = await readFile(join(dir, 'summary.md'), 'utf8');
    for (const kind of kinds) assert.match(summary, new RegExp(kind));
    assert.match(summary, /\| sample \| fail \| none \/  \| 1 \/ 1 \/ 1 \/ 1 \/ 1 \|/);
    const json = JSON.parse(await readFile(join(dir, 'scorecard.json'), 'utf8'));
    assert.equal(json.cases[0].turns[0].attempts.length, 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

function fixtureAnswer(values, result) {
  const words = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
  const lengths = [];
  const walk = value => {
    if (Array.isArray(value)) { lengths.push(value.length); value.forEach(walk); }
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(result);
  const counts = [...new Set(lengths.filter(n => n >= 1 && n <= 20))].map(n => `${words[n - 1]} rows`);
  const money = values.map(n => {
    const abs = Math.abs(n);
    const whole = Math.trunc(abs);
    const exact = abs.toLocaleString('en-US', { maximumFractionDigits: 20 });
    return abs === whole ? `$${whole.toLocaleString('en-US')}` : `$${whole.toLocaleString('en-US')} ($${exact})`;
  });
  return ['Figures follow.', ...counts, ...money].join(' ');
}
