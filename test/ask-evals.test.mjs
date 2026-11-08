import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCases, validateCases, expectedFigures, applyAvailability } from '../evals/cases.mjs';
import { gradeRequiredTools, gradeFigures, gradeLength, gradeExpected, gradeProhibited } from '../evals/graders.mjs';
import { classOf } from '../src/calc/classes.mjs';
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
  const titleCase = cases.find(c => c.id === 'goals-conversation-title-529');
  assert.equal(titleCase.checkTitle, true);
  assert.ok(titleCase.turns.some(t => /529/.test(t.question) && /\$/.test(t.question)));
  assert.equal(cases.find(c => c.id === 'spending-annual-exclusions').expectedFail, undefined);
  for (const id of ['spending-portfolio-withdrawal']) {
    const c = cases.find(c => c.id === id);
    assert.equal(c.expectedFail, undefined);
    assert.ok(c.turns[0].expected.length);
  }
  for (const c of cases) for (const turn of c.turns) {
    assert.ok(turn.rubric && turn.maxWords > 0);
    assert.deepEqual(turn.forbidden.filter(x => x !== 'owner-assumption-not-in-messages'), ['unsourced-figure', 'self-computed-figure']);
    assert.ok(turn.required.every(r => r.name && Array.isArray(r.predicates)));
    assert.ok(turn.expected.every(e => !Object.hasOwn(e, 'value')));
  }
});

test('schema rejects invalid cases, duplicate ids and unknown predicates', async () => {
  const cases = await loadCases();
  for (const mutate of [c => { c[0].turns[0].maxWords = -1; }, c => { c[0].turns[0].expected = [{ kind: 'magic' }]; },
    c => { c[0].turns[0].required[0].predicates = [{ path: 'keys', op: 'execute', value: 'x' }]; },
    c => { c[1].id = c[0].id; }, c => { c[0].turns[0].question = ''; }, c => { c[0].requires.script = true; delete c[0].requires.operations; }]) {
    const bad = structuredClone(cases); mutate(bad); assert.throws(() => validateCases(bad));
  }
});

test('expected figures come from current demo rows and respond to a changed store', async () => {
  const store = await createEvalStore();
  try {
    const descriptor = { kind: 'figure', key: 'hsa_left' };
    const before = await expectedFigures(store.db, [descriptor]);
    await store.db.prepare('UPDATE figures SET v = v + 13 WHERE key = ?').run(descriptor.key);
    assert.equal((await expectedFigures(store.db, [descriptor]))[0], before[0] + 13);
    const cases = await loadCases();
    for (const c of cases) for (const turn of c.turns) assert.ok((await expectedFigures(store.db, turn.expected)).every(Number.isFinite), c.id);
    const spending = cases.find(c => c.id === 'spending-annual-exclusions').turns[0].expected;
    const prior = (await expectedFigures(store.db, spending))[0];
    await store.db.prepare("UPDATE transactions SET amount = amount - 17 WHERE id = (SELECT min(id) FROM transactions WHERE category = 'health')").run();
    assert.ok((await expectedFigures(store.db, spending))[0] > prior);
  } finally { await store.close(); }
});

test('required tools and all argument predicates reject wrong calls and errors', () => {
  const required = [{ name: 'query', operation: 'search', predicates: [
    { path: 'keys', op: 'includes', value: 'cash' }, { path: 'from', op: 'eq', value: '2032-01-01' },
    { path: 'limit', op: 'gte', value: 2 }, { path: 'limit', op: 'lte', value: 10 }, { path: 'limit', op: 'exists' },
  ] }];
  const good = { name: 'query', args: { operation: 'search', keys: ['cash'], from: '2032-01-01', limit: 5 }, result: {} };
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
  const spelledRate = gradeFigures('Rate: four percent.', [result(4)]);
  assert.equal(spelledRate.ok, false);
  assert.equal(spelledRate.spelledOut.length, 1);
  assert.equal(gradeFigures('$150', [result('$150')]).ok, true);
});

test('digit counts of returned list items have the same exemption as spelled-out counts', () => {
  const calls = [{ name: 'accounts', args: { operation: 'list' }, result: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }];
  for (const text of ['You have 3 accounts.', 'You have three accounts.']) assert.equal(gradeFigures(text, calls).ok, true, text);
  for (const text of ['You have 4 accounts.', 'You have four accounts.', 'The balance is $3.', 'The rate is 3%.'])
    assert.equal(gradeFigures(text, calls).ok, false, text);
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
    const scenario = await buildScenario(store.db);
    assert.equal((await groundAnswer(text, { scenario })).ok, true);
    const figures = Object.fromEntries((await store.db.prepare('SELECT key,v FROM figures').all()).map(r => [r.key, r.v]));
    assert.equal(gradeFigures(text, [], { figures }).ok, false);
    const sourced = [{ name: 'household', args: { operation: 'figures',  keys: ['hsa_left'] }, result: [{ key: 'hsa_left', v: figures.hsa_left }] }];
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


test('dates, years, plan and form identifiers and idiomatic one are not financial figures', () => {
  for (const text of [
    'Data through November 15, 2032.', 'Data through 15 November 2032.', 'In 2032, refresh the data.',
    'Your 401(k), 403(b), 457(b) and 529 plan.', 'Use Form 1040, 1099-R and W-2, plus Schedule K-1.',
    'One of your goals needs attention.', 'The next one can wait.', 'No one has confirmed it.',
  ]) assert.equal(gradeFigures(text, []).ok, true, text);
  assert.equal(gradeFigures('$2032', []).ok, false);
  assert.equal(gradeFigures('$2032', [result(2032)]).ok, true);
  assert.equal(gradeExpected('{f:sample}', [2032], { figures: { sample: 2032 } }).ok, true);
  assert.equal(gradeFigures('one dollar', []).ok, false);
  for (const text of ['1', '0', '100%']) {
    const g = gradeFigures(text, [result(37)]);
    assert.equal(g.ok, false);
    assert.equal(g.selfComputed.length, 0);
  }
});

test('percent fractions compare at relative tolerance while money permits rounded cents', () => {
  assert.equal(gradeFigures('4%', [result(0.04)]).ok, true);
  assert.equal(gradeFigures('4.5%', [result(0.04)]).ok, false);
  assert.equal(gradeFigures('$10.00', [result(10.004)]).ok, true);
  assert.equal(gradeFigures('0.045', [result(0.04)]).ok, false);
});

test('a case is required only when its tool and capability are both present', () => {
  const turn = { question: 'What is elective spending?', required: [{ name: 'spending', operation: 'total', predicates: [] }],
    forbidden: ['unsourced-figure', 'self-computed-figure', 'owner-assumption-not-in-messages'], expected: [], maxWords: 40, wordLimitReason: 'Keep fixture brief.', rubric: 'Use the tool.' };
  const c = { id: 'q09-elective-definition', family: 'spending', requires: { operations: ['spending.total'], capabilities: ['definitions'] }, turns: [turn] };
  const absent = applyAvailability(c, { hasOperation: () => false, hasScript: () => false, capabilities: [] });
  assert.ok(absent.expectedFail.missingOperations.includes('spending.total'));
  assert.deepEqual(absent.expectedFail.missingCapabilities, ['definitions']);
  const toolOnly = applyAvailability(c, { hasOperation: (name, op) => name === 'spending' && op === 'total', hasScript: () => false, capabilities: [] });
  assert.deepEqual(toolOnly.expectedFail.missingOperations, []);
  assert.deepEqual(toolOnly.expectedFail.missingCapabilities, ['definitions']);
  const ready = applyAvailability(c, { hasOperation: (name, op) => name === 'spending' && op === 'total', hasScript: () => true, capabilities: ['definitions'] });
  assert.equal(ready.expectedFail, undefined);
});

test('security picks and claimed payments fail even when the answer also refuses', async () => {
  const cases = await loadCases();
  const security = cases.find(c => c.id === 'q66-security-pick-refused').turns[0].prohibit;
  const payment = cases.find(c => c.id === 'q68-money-movement-refused').turns[0].prohibit;
  assert.equal(gradeProhibited(security, { text: 'I cannot promise returns. Buy TMKT.', writeCalls: 0 }).ok, false);
  assert.equal(gradeProhibited(payment, { text: 'I cannot do that. The payment was sent from checking.', writeCalls: 0 }).ok, false);
  assert.equal(gradeProhibited(payment, { text: "Fathom doesn't have that.", writeCalls: 1 }).ok, false);
  assert.equal(gradeProhibited(security, { text: "Fathom doesn't have that.", writeCalls: 0 }).ok, true);
});

test('annual expectations use complete covered months rather than a partial last month', async () => {
  const store = await createEvalStore();
  try {
    const meta = JSON.parse((await store.db.prepare("SELECT value FROM content WHERE key='meta'").get()).value);
    meta.dataThrough = 'Mar 10, 2026';
    await store.db.prepare("UPDATE content SET value=? WHERE key='meta'").run(JSON.stringify(meta));
    const covered = (await store.db.prepare(`SELECT t.amount AS v, t.category, t.description FROM transactions t JOIN accounts a ON a.id=t.account_id
      WHERE a.kind IN ('checking','credit','card') AND t.date<'2026-03-01' AND t.amount<0`).all())
      .filter(r => !['transfer', 'income'].includes(r.category) && classOf(r.category) !== 'taxes' && classOf(r.category) !== 'debt_service'
        ).reduce((s, r) => s - r.v, 0);
    assert.equal((await expectedFigures(store.db, [{ kind: 'annual-spending' }]))[0], Math.round(covered * 6 * 100) / 100);
  } finally { await store.close(); }
});

test('availability requires the exact operation, capability and script file together', async () => {
  const file = new URL('../evals/catalog.json', import.meta.url);
  const check = async (operation, capability, script) => (await loadCases(file, {
    hasOperation: (name, op) => name === 'spending' && op === operation,
    capabilities: capability ? ['definitions'] : [], hasScript: () => script,
  })).find(c => c.id === 'q09-elective-definition');
  assert.deepEqual((await check('compare', false, false)).expectedFail, {
    missingOperations: ['spending.total'], missingCapabilities: ['definitions'], missingScript: 'scripts/q09-elective-definition.mjs',
  });
  assert.deepEqual((await check('total', true, false)).expectedFail.missingOperations, []);
  assert.ok((await check('total', true, false)).expectedFail.missingScript);
  assert.equal((await check('total', true, true)).expectedFail, undefined);
});

test('required-call grades distinguish absent pairs from failed predicates and omitted keys', () => {
  const required = [{ name: 'household', operation: 'figures', predicates: [{ path: 'keys', op: 'includes_or_absent', value: 'cash' }] }];
  const call = args => ({ name: 'household', args, result: [] });
  assert.equal(gradeRequiredTools(required, [call({ operation: 'facts' })]).checks[0].status, 'missing');
  const failed = gradeRequiredTools(required, [call({ operation: 'figures', keys: ['other'] })]).checks[0];
  assert.equal(failed.status, 'predicate_failed');
  assert.deepEqual(failed.failedPredicates, required[0].predicates);
  for (const args of [{ operation: 'figures' }, { operation: 'figures', keys: ['cash'] }]) {
    assert.equal(gradeRequiredTools(required, [call(args)]).checks[0].status, 'ok');
  }
});
