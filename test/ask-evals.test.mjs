import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCases, validateCases, expectedFigures } from '../evals/cases.mjs';
import { gradeRequiredTools, gradeFigures, gradeLength, gradeExpected } from '../evals/graders.mjs';
import { createEvalStore } from '../evals/harness.mjs';
import { groundAnswer } from '../src/api/answerer.mjs';
import { buildScenario } from '../src/scenario/build.mjs';

const result = (value, extra = {}) => ({ name: 'read', args: {}, result: { value }, ...extra });
test('catalog validates at least thirty cases and all question families', async () => {
  const cases = await loadCases();
  assert.ok(cases.length >= 30);
  assert.equal(validateCases(cases), true);
  for (const family of ['spending', 'cash-flow', 'business', 'net-worth', 'retirement', 'taxes', 'goals', 'freshness', 'unavailable'])
    assert.ok(cases.some(c => c.family === family), family);
  for (const id of ['spending-annual-exclusions', 'spending-portfolio-withdrawal']) {
    const c = cases.find(c => c.id === id);
    assert.ok(c.expectedFail.missingTools.length);
    assert.ok(c.turns[0].expected.length);
  }
  for (const c of cases) for (const turn of c.turns) {
    assert.ok(turn.rubric && turn.maxWords > 0);
    assert.deepEqual(turn.forbidden, ['unsourced-figure', 'self-computed-figure']);
    assert.ok(turn.required.every(r => r.name && Array.isArray(r.predicates)));
    assert.ok(turn.expected.every(e => !Object.hasOwn(e, 'value')));
  }
});

test('schema rejects invalid cases, duplicate ids and unknown predicates', async () => {
  const cases = await loadCases();
  for (const mutate of [c => { c[0].turns[0].maxWords = -1; }, c => { c[0].turns[0].expected = [{ kind: 'magic' }]; },
    c => { c[0].turns[0].required[0].predicates = [{ path: 'keys', op: 'execute', value: 'x' }]; },
    c => { c[1].id = c[0].id; }, c => { c[0].turns[0].question = ''; }]) {
    const bad = structuredClone(cases); mutate(bad); assert.throws(() => validateCases(bad));
  }
});

test('expected figures come from current demo rows and respond to a changed store', async () => {
  const store = await createEvalStore();
  try {
    const descriptor = { kind: 'figure', key: 'hsa_left' };
    const before = expectedFigures(store.db, [descriptor]);
    store.db.prepare('UPDATE figures SET v = v + 13 WHERE key = ?').run(descriptor.key);
    assert.equal(expectedFigures(store.db, [descriptor])[0], before[0] + 13);
    const cases = await loadCases();
    for (const c of cases) for (const turn of c.turns) assert.ok(expectedFigures(store.db, turn.expected).every(Number.isFinite), c.id);
    const spending = cases.find(c => c.id === 'spending-annual-exclusions').turns[0].expected;
    const prior = expectedFigures(store.db, spending)[0];
    store.db.prepare("UPDATE transactions SET amount = amount - 17 WHERE id = (SELECT min(id) FROM transactions WHERE category = 'health')").run();
    assert.ok(expectedFigures(store.db, spending)[0] > prior);
  } finally { await store.close(); }
});

test('required tools and all argument predicates reject wrong calls and errors', () => {
  const required = [{ name: 'query', predicates: [
    { path: 'keys', op: 'includes', value: 'cash' }, { path: 'from', op: 'eq', value: '2032-01-01' },
    { path: 'limit', op: 'gte', value: 2 }, { path: 'limit', op: 'lte', value: 10 }, { path: 'limit', op: 'exists' },
  ] }];
  const good = { name: 'query', args: { keys: ['cash'], from: '2032-01-01', limit: 5 }, result: {} };
  assert.equal(gradeRequiredTools(required, [good]).ok, true);
  for (const calls of [[], [{ ...good, isError: true }], [{ ...good, args: { ...good.args, from: '2031-01-01' } }],
    [{ ...good, args: { ...good.args, keys: ['other'] } }], [{ ...good, args: { ...good.args, limit: 20 } }],
    [{ ...good, args: { ...good.args, limit: 1 } }]]) assert.equal(gradeRequiredTools(required, calls).ok, false);
});

test('numeric grader distinguishes returned, unsourced and self-computed amounts', () => {
  assert.equal(gradeFigures('Available: $1,200.', [result(1200)]).ok, true);
  assert.equal(gradeFigures('Available: $1.2k.', [result(1200)]).ok, true);
  assert.equal(gradeFigures('Available: $333.', [result(1200)]).ok, false);
  for (const text of ['$140', '$60', '$4,000', '2.5', '250%']) {
    const grade = gradeFigures(text, [result(100), result(40)]);
    assert.equal(grade.ok, false, text);
    assert.equal(grade.selfComputed.length, 1, text);
  }
  assert.equal(gradeFigures('one hundred fifty dollars', [result(100), result(50)]).ok, false);
  assert.equal(gradeFigures('1. Available: $100.\n2. Available: $50.', [result(100), result(50)]).ok, true);
  assert.equal(gradeFigures('$100', [result(100, { isError: true })]).ok, false);
  assert.equal(gradeFigures('Rate: four percent.', [result(4)]).ok, true);
  assert.equal(gradeFigures('$150', [result('$150')]).ok, true);
});

test('args, result echoes, identifiers, keys, labels and dates cannot source figures', () => {
  for (const call of [
    { name: 'read', args: { minAmount: 150 }, result: {} },
    { name: 'read', args: { minAmount: 150 }, result: { minAmount: 150 } },
    { name: 'read', args: { minAmount: 150 }, result: { total: 150 } },
    { name: 'read', args: {}, result: { id: 150 } },
    { name: 'read', args: {}, result: { body: 'Publication 150' } },
    { name: 'read', args: {}, result: { label: '$150', key: '150', asOf: '2032-01-01' } },
  ]) assert.equal(gradeFigures('$150', [call]).ok, false);
});

test('earlier-turn values and context-only tokens fail independently of production grounding', async () => {
  const store = await createEvalStore();
  try {
    const text = '{f:hsa_left}';
    const scenario = buildScenario(store.db);
    assert.equal(groundAnswer(text, { scenario }).ok, true);
    const figures = Object.fromEntries(store.db.prepare('SELECT key,v FROM figures').all().map(r => [r.key, r.v]));
    assert.equal(gradeFigures(text, [], { figures }).ok, false);
    const sourced = [{ name: 'get_figures', args: { keys: ['hsa_left'] }, result: [{ key: 'hsa_left', v: figures.hsa_left }] }];
    assert.equal(gradeFigures(text, sourced, { figures }).ok, true);
    assert.equal(gradeFigures('$123', [], { contextNumbers: [123] }).contextOnly.length, 1);
  } finally { await store.close(); }
});

test('expected values must appear and length budgets are enforced', () => {
  assert.equal(gradeExpected('Available: $1.2k', [1200]).ok, true);
  assert.equal(gradeExpected('No answer.', [1200]).ok, false);
  assert.equal(gradeLength('A brief answer.', 3).ok, true);
  assert.equal(gradeLength('A much longer answer.', 3).ok, false);
});
