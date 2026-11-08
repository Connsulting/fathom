import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvalStore } from '../evals/harness.mjs';
import { createEngine } from '../src/engine/index.mjs';
import { createLiveAnswerer, buildChatPrompt, ANSWER_STYLE } from '../src/api/answerer.mjs';
import { createLivePacks } from '../src/packs/live.mjs';
import { gradeFigures, gradeLength } from '../evals/graders.mjs';
import { ANSWER_MAX_WORDS } from '../src/shared/answer-contract.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { resolveTokens } from '../src/shared/tokens.mjs';
import { checkAnswerDiscipline } from '../src/shared/answer-discipline.mjs';
import { tools as REGISTRY } from '../src/tools/index.mjs';

const LONG = 'Your household plan remains available for review. '.repeat(24).trim();
const CLEAN = 'Your household plan remains available for review.';
const READ = { name: 'household', args: { operation: 'figures', keys: ['biz_cash', 'sp_cash'] } };
const CALCULATE = { name: 'calculate', args: { operation: 'add', label: 'Combined cash', operands: ['biz_cash', 'sp_cash'].map(key => ({
  ref: { tool: 'household', args: { operation: 'figures', keys: [key] }, path: '0' },
})) } };

async function ask(t, scripts, question = 'Describe the household plan.') {
  const store = await createEvalStore();
  t.after(() => store.close());
  for (const [key, value] of [['biz_cash', 173.41], ['sp_cash', 89.26]])
    store.db.prepare('UPDATE figures SET v=? WHERE key=?').run(value, key);
  const packs = createLivePacks(store.db, { dataDir: store.root });
  packs.refresh();
  const inner = createEngine({ mode: 'fake' });
  const calls = [];
  const reads = [];
  const responses = [];
  const engine = { mode: 'fake', isOn: () => true, async call(request) {
    const index = calls.length;
    calls.push(request);
    const response = await inner.call(scripts ? { ...request, fake: scripts[Math.min(index, scripts.length - 1)] } : request);
    responses.push(response);
    return response;
  } };
  const scenario = buildScenario(store.db, { packs });
  const text = typeof question === 'function' ? question(scenario) : question;
  const reply = await createLiveAnswerer({ engine, packs, root: store.root, onRead: r => reads.push(r) }).answer({
    db: store.db, key: 'ask:0a1b2c3d4e5f', text,
  });
  assert.ok(!reply.notice, JSON.stringify(reply));
  return { reply, calls, reads, responses, text: reply.paragraphs.join(' ').replace(/<[^>]+>/g, '') };
}

test('an over-length draft gets one corrective call and delivers the shorter answer', async t => {
  const { reply, calls, text } = await ask(t, [[{ text: LONG }], [{ text: CLEAN }]]);
  assert.equal(calls.length, 2);
  assert.equal(text, CLEAN);
  assert.equal(gradeLength(text, ANSWER_MAX_WORDS).ok, true);
  assert.match(calls[1].messages.at(-1).content, /shorten.*150 words/i);
  assert.equal(reply.provenance.grounding.retried, true);
  assert.deepEqual(reply.provenance.discipline.violations, []);
});

test('an explicit request for more detail keeps the length exception', async t => {
  const { calls, text } = await ask(t, [[{ text: LONG }]], 'Please explain the household plan in more detail.');
  assert.equal(calls.length, 1);
  assert.equal(text, LONG);
});

test('a spelled-out figure triggers correction', async t => {
  const { calls, text } = await ask(t, [[{ toolCalls: [READ] }, { text: 'Cash is about one hundred seventy three dollars.' }], [{ text: CLEAN }]]);
  assert.equal(calls.length, 2);
  assert.equal(text, CLEAN);
  assert.match(calls[1].messages.at(-1).content, /write every figure as digits/i);
});

test('a self-computed sum triggers correction and the delivered sum is sourced to calculate', async t => {
  const draft = 'Combined cash is $262.67.';
  const { reply, calls, text } = await ask(t, [[{ toolCalls: [READ] }, { text: draft }], [{ toolCalls: [CALCULATE] }, { text: draft }]]);
  assert.equal(calls.length, 2);
  assert.match(calls[1].messages.at(-1).content, /get every derived figure from the calculate tool/i);
  assert.equal(text, draft);
  assert.ok(reply.provenance.tools.some(r => r.name === 'calculate' && !r.isError));
  assert.ok(reply.provenance.literals.some(l => l.text === '$262.67' && l.source === 'calculated figures'));
  assert.deepEqual(reply.provenance.discipline.violations, []);
});

test('a still-violating correction is delivered intact with kinds only and no third call', async t => {
  const corrected = `${LONG} Cash is fifteen thousand dollars. An extra $987,654 is available.`;
  const { reply, calls, text } = await ask(t, [[{ text: LONG }], [{ text: corrected }], [{ text: 'Must not run.' }]]);
  assert.equal(calls.length, 2);
  assert.equal(text, corrected);
  assert.deepEqual(reply.provenance.discipline.violations.toSorted(), ['figures.spelled_out', 'figures.unsourced', 'length']);
  assert.deepEqual(Object.keys(reply.provenance.discipline), ['violations']);
});

test('one unsourced figure triggers correction and asks for tool evidence', async t => {
  const { calls, text } = await ask(t, [[{ text: 'Available cash is $987,654.' }], [{ text: CLEAN }]]);
  assert.equal(calls.length, 2);
  assert.equal(text, CLEAN);
  assert.match(calls[1].messages.at(-1).content, /drop any figure no tool returned/i);
});

test('a clean first draft makes exactly one call', async t => {
  const { reply, calls, text } = await ask(t, [[{ text: CLEAN }], [{ text: 'Must not run.' }]]);
  assert.equal(calls.length, 1);
  assert.equal(text, CLEAN);
  assert.deepEqual(reply.provenance.discipline.violations, []);
});

test('the figure rules are stated once and the existing word-limit sentence remains', () => {
  const { system } = buildChatPrompt({ summary: {}, question: 'Describe the plan.' });
  assert.equal([...system.matchAll(/write every figure as digits/gi)].length, 1);
  assert.match(system, /derived figures.*calculate/i);
  assert.match(system, /no figure without a tool source/i);
  assert.match(ANSWER_STYLE, /Keep the whole reply under 150 words unless the owner asks for more detail\./);
});

test('the shared implementation preserves the graders and exposes kind-only diagnostics', async () => {
  const shared = await import('../src/shared/answer-discipline.mjs');
  assert.equal(shared.gradeFigures, gradeFigures);
  assert.equal(shared.gradeLength, gradeLength);
  assert.deepEqual(shared.checkAnswerDiscipline('Cash is one hundred seventy three dollars.', [
    { name: 'read', args: {}, result: { balance: 173 } },
  ]).violations, ['figures.spelled_out']);
  const grade = shared.checkAnswerDiscipline(`${LONG} Combined cash is $262.67.`, [
    { name: 'read', args: {}, result: { balances: [173.41, 89.26] } },
  ]);
  assert.deepEqual(grade.violations.toSorted(), ['figures.self-computed', 'length']);
});

test('every suggested demo answer is clean on its first draft', async t => {
  const store = await createEvalStore();
  const ids = buildScenario(store.db).ask.suggested.map(q => q.id);
  await store.close();
  for (const id of ids) await t.test(id, async sub => {
    const { calls, reads, responses, reply } = await ask(sub, null,
      scenario => resolveTokens(scenario, scenario.ask.suggested.find(q => q.id === id).q, false));
    const draft = responses[0];
    const grade = checkAnswerDiscipline(draft.text, [...reads, ...draft.toolResults]);
    sub.diagnostic(JSON.stringify({ id, violations: grade.violations,
      spelledOut: grade.figures.spelledOut.map(v => v.text), selfComputed: grade.figures.selfComputed.map(v => v.text) }));
    assert.deepEqual(grade.violations, []);
    assert.equal(calls.length, 1);
    assert.equal(reply.provenance.grounding.retried, false);
    assert.deepEqual(reply.provenance.discipline.violations, []);
  });
});

test('a corrective round reuses the pre-model summary and lists each distinct read once', async t => {
  const household = REGISTRY.find(tool => tool.name === 'household');
  const handler = household.handler;
  let summaries = 0;
  household.handler = (args, ctx) => {
    if (args.operation === 'summary') summaries++;
    return handler(args, ctx);
  };
  t.after(() => { household.handler = handler; });
  const summary = { name: 'household', args: { operation: 'summary' } };
  const { calls, reads, responses, reply } = await ask(t, [
    [{ toolCalls: [summary, READ] }, { text: LONG }],
    [{ toolCalls: [summary, { name: 'household', args: { keys: READ.args.keys, operation: 'figures' } }] }, { text: CLEAN }],
  ]);
  assert.equal(calls.length, 2);
  assert.equal(summaries, 1, 'one executed summary read for the whole turn');
  const initial = reads.find(r => r.name === 'household' && r.args.operation === 'summary').result;
  for (const response of responses)
    assert.deepEqual(response.toolResults.find(r => r.args.operation === 'summary').result, initial);
  for (const operation of ['summary', 'figures'])
    assert.equal(reply.provenance.tools.filter(r => r.name === 'household' && r.args.operation === operation).length, 1, operation);
});
