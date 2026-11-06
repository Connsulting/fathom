// AC2 and AC3: the live answerer. Prompt assembly keeps the cacheable system prompt free of
// household data (D1), groundAnswer validates every token and refuses stored figures written as
// literals (R9, R14, R15), renderAnswer escapes untrusted model text (D6), one corrective retry
// (D5), notices instead of fabricated text (D13, R7), write-tool gating (D12) and provenance.
//
// The answerer runs over a real runtime engine in fake mode on a temp demo store. Where a test
// needs specific model output it wraps the runtime so the next call carries a scripted
// request.fake; every other method passes through to the real runtime.

import test from 'node:test';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import demo from '../demo/scenario.mjs';
import { seedDemo } from '../demo/seed.mjs';
import { loadConfig } from '../src/config.mjs';
import { setSetting } from '../src/store/db.mjs';
import { buildScenario, clockNow } from '../src/scenario/build.mjs';
import { callTool, tools as REGISTRY } from '../src/tools/index.mjs';
import { sdkOptions } from '../src/engine/live.mjs';
import { createRuntimeEngine, createSpendLedger } from '../src/engine/runtime.mjs';
import { createLivePacks } from '../src/packs/live.mjs';
import { PRODUCT_RULES, NOTICES, buildChatPrompt, groundAnswer, renderAnswer, createLiveAnswerer } from '../src/api/answerer.mjs';
import { ACTION_STATUS } from '../src/shared/rules.mjs';
import { ROOT, tempDb } from './helpers/server.mjs';
import { writeSyntheticPack, ALWAYS } from './helpers/packs.mjs';

const ACTIVE_DEMO_PACKS = ['advanced-retirement', 'kids-dependents', 's-corp-owner', 'self-employed-partnership', 'virginia-resident', 'w2-benefits'];
const UNVERIFIED = '<span class="fx-unverified" title="Not found in your data or tool results">';
const INVENTED = '$987,654';
// An Ask thread key: the answerer needs no stored row, and a new key has no history.
const THREAD = 'ask:0123456789ab';
// The suggested question 'leave', sent as free text (suggested ids resolve only through matchQuestion).
const LEAVE = demo.ask.suggested.find(q => q.id === 'leave').q;

// `prepare(dataDir)` runs before the pack refresher first loads, so a test can put a synthetic
// pack in the data volume pack directory.
async function demoStore(t, env = {}, { prepare } = {}) {
  const s = await tempDb();
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  seedDemo(s.db);
  if (prepare) prepare(s.dataDir);
  const config = loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake', ...env });
  const runtime = createRuntimeEngine({ db: s.db, config });
  const packs = createLivePacks(s.db, { dataDir: s.dataDir });
  packs.refresh();
  return { ...s, config, runtime, packs };
}

// The runtime with call() intercepted: records each request and, while scripts remain, sends the
// next one as request.fake. `before(n)` runs before call n (0-based) is delegated. `responses`
// holds each completed call's engine result (tool results included).
function scripted(runtime, scripts = [], { before } = {}) {
  const queue = [...scripts];
  const requests = [];
  const responses = [];
  const engine = new Proxy(runtime, {
    get(target, key) {
      if (key === 'call') {
        return async request => {
          const n = requests.length;
          requests.push(request);
          if (before) before(n);
          const next = queue.shift();
          const response = await target.call(next ? { ...request, fake: next } : request);
          responses.push(response);
          return response;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { engine, requests, responses };
}

test('a tool preamble and the answer stay as two paragraphs and the stream matches', async t => {
  const s = await demoStore(t);
  const seen = [];
  const { engine } = scripted(s.runtime, [[
    { text: 'Let me check your figures.', toolCalls: [{ name: 'household_summary', args: {} }] },
    { text: 'Keep a reserve.' },
  ]]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({
    db: s.db, key: THREAD, text: 'What should I keep?', onEvent: e => seen.push(e),
  });
  const streamed = seen.filter(e => e.type === 'text').map(e => e.text).join('');
  assert.equal(seen.some(e => e.type === 'reset'), false);
  assert.equal(streamed, 'Let me check your figures.\n\nKeep a reserve.');
  assert.deepEqual(reply.paragraphs, ['Let me check your figures.', 'Keep a reserve.']);
  assert.equal(reply.paragraphs.join('\n\n'), streamed);
});

test('text before a tool round is kept when the model resumes mid-word', async t => {
  const s = await demoStore(t);
  const head = 'Give appreciated assets instead of cash.\n\nSources: "G';
  const tail = 'ifts of appreciated stock" and "Evaluate bunching across tax years."\n\nQuarterly tax payments. The federal safe harbor follows last year.\n\nThe most useful next steps are to schedule the payment.';
  const { engine } = scripted(s.runtime, [[
    { content: [
      { type: 'text', text: head },
      { type: 'tool_use', id: 'synthetic', name: 'household_summary', input: {} },
    ], toolCalls: [{ name: 'household_summary', args: {} }] },
    { text: tail },
  ]]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'What am I missing?' });
  const body = joined(reply);
  assert.match(body, /Give appreciated assets instead of cash/);
  assert.match(body, /Quarterly tax payments/);
  assert.match(body, /most useful next steps/);
  assert.doesNotMatch(body, /ifts of appreciated/);
  assert.doesNotMatch(body, /Sources:/);
});

const spendCount = db => db.prepare('SELECT count(*) AS n FROM spend_ledger').get().n;
const joined = reply => reply.paragraphs.join('\n');
const toolNames = request => (request.tools || []).map(tool => tool.name);
const sorted = list => [...list].sort();

// ---------------------------------------------------------------- prompt assembly

test('PRODUCT_RULES states the advisory boundaries, the figure token rule and the proposal rule', () => {
  assert.equal(typeof PRODUCT_RULES, 'string');
  assert.match(PRODUCT_RULES, /advisory/i);
  assert.ok(PRODUCT_RULES.includes('{f:'), 'figure tokens are explained');
  assert.ok(PRODUCT_RULES.includes('get_figures'));
  // B2: chat never writes; the rule names the proposal tool instead of the write tool.
  assert.ok(PRODUCT_RULES.includes('propose_recommendation_action'));
  assert.ok(!PRODUCT_RULES.includes('set_recommendation_status'));
});

test('buildChatPrompt keeps the static system identical across summaries and questions and free of household data', () => {
  const packContextText = '{"packs":[{"id":"synthetic-pack","title":"SYNTHETIC-PACK-CONTEXT"}],"version":1}';
  const one = buildChatPrompt({
    packContextText, summary: { needsYouCount: 7351, marker: 'SUMMARY-MARKER-ONE', facts: { 'household.state': 'ZZ' } },
    context: null, history: [], question: 'First synthetic question?',
  });
  const two = buildChatPrompt({
    packContextText, summary: { needsYouCount: 8462, marker: 'SUMMARY-MARKER-TWO', facts: { 'household.state': 'YY' } },
    context: { rec: { id: 'synthetic-rec', title: 'CONTEXT-MARKER' } }, history: [], question: 'Second synthetic question?',
  });
  assert.equal(one.system, two.system);
  assert.equal(one.system, PRODUCT_RULES + '\n\n<knowledge_packs>\n' + packContextText + '\n</knowledge_packs>');
  for (const value of ['SUMMARY-MARKER-ONE', 'SUMMARY-MARKER-TWO', '7351', '8462', 'CONTEXT-MARKER', 'First synthetic', 'Second synthetic']) {
    assert.ok(!one.system.includes(value), `static system has no ${value}`);
  }
  assert.ok(one.systemDynamic.includes('<household_summary>'));
  assert.ok(one.systemDynamic.includes('</household_summary>'));
  assert.ok(one.systemDynamic.includes('SUMMARY-MARKER-ONE'));
  assert.ok(one.systemDynamic.includes('7351'));
  assert.ok(!one.systemDynamic.includes('<conversation_context>'), 'no context block without context');
  assert.ok(two.systemDynamic.includes('<conversation_context>'));
  assert.ok(two.systemDynamic.includes('CONTEXT-MARKER'));
  assert.ok(two.systemDynamic.includes('SUMMARY-MARKER-TWO'));
  assert.deepEqual(one.messages, [{ role: 'user', content: 'First synthetic question?' }]);
  assert.deepEqual(two.messages, [{ role: 'user', content: 'Second synthetic question?' }]);
});

test('buildChatPrompt maps history to plain-text turns, drops notices, keeps the last 20, then the question', () => {
  const history = Array.from({ length: 26 }, (_, i) => ({
    id: `m${i}`, role: i % 2 ? 'fathom' : 'me', text: `<p>Synthetic message ${i}</p>`, refs: [], ts: 'Nov 5, 9:00 AM', notice: false,
  }));
  history[21].notice = true;
  history[23].notice = true;
  const out = buildChatPrompt({ packContextText: '{}', summary: {}, context: null, history, question: 'Latest synthetic question' });
  const kept = history.filter(m => !m.notice).slice(-20);
  assert.equal(out.messages.length, 21);
  assert.deepEqual(out.messages.slice(0, -1), kept.map(m => ({
    role: m.role === 'me' ? 'user' : 'assistant', content: m.text.replace(/<\/?p>/g, ''),
  })));
  assert.deepEqual(out.messages.at(-1), { role: 'user', content: 'Latest synthetic question' });
  assert.ok(out.messages.every(m => !m.content.includes('<p>')));
});

test('sdkOptions places the static system before the dynamic boundary and the dynamic part after it', () => {
  const base = { credential: { type: 'api-key', value: 'synthetic-placeholder' }, configDir: 'synthetic-config',
    system: 'STATIC-SYSTEM', maxTokens: 64, model: 'claude-opus-5-5' };
  const withDynamic = sdkOptions({ ...base, systemDynamic: 'DYNAMIC-SYSTEM' }).systemPrompt;
  assert.equal(withDynamic.length, 4);
  assert.equal(withDynamic[0], 'STATIC-SYSTEM');
  assert.equal(typeof withDynamic[1], 'string');
  assert.ok(withDynamic[1].length > 0, 'engine rules sit between the system and the boundary');
  assert.equal(withDynamic[2], SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
  assert.equal(withDynamic[3], 'DYNAMIC-SYSTEM');
  const plain = sdkOptions(base).systemPrompt;
  assert.equal(plain.length, 3);
  assert.equal(plain[0], 'STATIC-SYSTEM');
  assert.equal(plain[2], SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
});

// ---------------------------------------------------------------- grounding

test('groundAnswer accepts valid tokens of every kind, masks them, and collects figure keys', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  // {f:port_3m} would read as "3m" if it were not masked.
  const text = 'Reserve sits at {f:true_reserve} against {f:port_3m}, {n:spouse} agrees, the {l:deferral} limit holds and {p:phase_in} applies.';
  const r = groundAnswer(text, { scenario, toolResults: [], data: [] });
  assert.deepEqual(r.violations, []);
  assert.equal(r.ok, true);
  assert.deepEqual(sorted(r.figureKeys), ['port_3m', 'true_reserve']);
});

test('groundAnswer reports each unknown token of any kind once, at its index', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const tokens = ['{f:no_such_figure}', '{n:nobody}', '{l:nolaw}', '{p:nopct}'];
  const text = `See ${tokens[0]} with ${tokens[1]} under ${tokens[2]} at ${tokens[3]}.`;
  const r = groundAnswer(text, { scenario, toolResults: [], data: [] });
  assert.equal(r.ok, false);
  assert.equal(r.violations.length, tokens.length, JSON.stringify(r.violations));
  assert.deepEqual(sorted(r.violations.map(v => v.text)), sorted(tokens));
  for (const v of r.violations) assert.equal(v.index, text.indexOf(v.text));
  assert.deepEqual(r.figureKeys, []);
});

test('groundAnswer treats a stored figure written as a literal as a violation unless a tool result supports it', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const value = scenario.fig.fixed_fee.v;
  const literal = `$${value.toLocaleString('en-US')}`;
  const text = `About ${literal} of delivered work is not invoiced.`;
  const bare = groundAnswer(text, { scenario, toolResults: [], data: [] });
  assert.equal(bare.ok, false);
  assert.equal(bare.violations.length, 1);
  assert.equal(bare.violations[0].text, literal);
  assert.equal(bare.violations[0].reason, 'stored figure written as a literal');

  const supported = groundAnswer(text, { scenario, data: [],
    toolResults: [{ name: 'get_figures', args: { keys: ['fixed_fee'] }, result: [{ key: 'fixed_fee', v: value }] }] });
  assert.equal(supported.ok, true, JSON.stringify(supported.violations));
});

test('groundAnswer grounds literals in tool results and context data, and flags unsupported numbers and number words', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const fromTool = groundAnswer('You have 37 open items.', { scenario, data: [],
    toolResults: [{ name: 'household_summary', args: {}, result: { needsYouCount: 37 } }] });
  assert.equal(fromTool.ok, true, JSON.stringify(fromTool.violations));
  const fromData = groundAnswer('You have 37 open items.', { scenario, toolResults: [], data: [{ openItems: 37 }] });
  assert.equal(fromData.ok, true, JSON.stringify(fromData.violations));
  const invented = groundAnswer(`You could save ${INVENTED} next year.`, { scenario, toolResults: [], data: [] });
  assert.equal(invented.ok, false);
  assert.deepEqual(invented.violations.map(v => v.text), [INVENTED]);
  const word = groundAnswer('It works across two years.', { scenario, toolResults: [], data: [] });
  assert.deepEqual(word.violations.map(v => v.text), ['two']);
  assert.equal(groundAnswer('It works across two years.', { scenario, toolResults: [], data: [{ years: 2 }] }).ok, true);
});

// ---------------------------------------------------------------- B3: no number laundering

const LAUNDERED = 'The synthetic amount is 4821.';
const laundered = r => r.violations.map(v => v.text);

test('B3: a tool result value that echoes a call argument does not ground the number', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const echoes = [
    // A number echoed under an ordinary key.
    { name: 'get_recommendation', args: { id: 'synthetic', amount: 4821 }, result: { amount: 4821, title: 'Synthetic' } },
    // A number echoed under the same key, compared numerically. (A number under a different key
    // is a value since round 3; see "R3 A" below.)
    { name: 'query_transactions', args: { minAmount: 4821 }, result: { rows: [], minAmount: 4821.0, total: 0 } },
    // A string echoed verbatim (after trim).
    { name: 'query_transactions', args: { text: ' 4821 ' }, result: { rows: [], query: '4821', total: 0 } },
    // A string that contains an argument string of length 3 or more with a digit.
    { name: 'query_transactions', args: { text: 'plan 4821' }, result: { rows: [], note: 'No rows matched plan 4821 this year', total: 0 } },
  ];
  for (const echo of echoes) {
    const r = groundAnswer(LAUNDERED, { scenario, toolResults: [echo], data: [] });
    assert.equal(r.ok, false, `ungrounded via ${JSON.stringify(echo)}`);
    assert.ok(laundered(r).includes('4821'), JSON.stringify(r.violations));
    assert.ok(!r.literals.some(l => l.text === '4821'), 'never attributed to the echoing tool');
  }
});

test('B3: identifier and citation keys in a tool result do not ground a number', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const keys = ['id', 'ids', 'key', 'keys', 'recId', 'fileIds', 'source_id', 'url', 'href', 'cites', 'citation', 'citations',
    'source', 'sources', 'file', 'fileName', 'page', 'pages'];
  const values = [4821, '4821', 'plan-4821.md', 'https://example.invalid/doc/4821', [4821], { label: 'plan-4821.md, page 4821' }];
  for (const key of keys) {
    for (const value of values) {
      const result = { title: 'Synthetic', entry: { [key]: value } };
      const r = groundAnswer(LAUNDERED, { scenario, toolResults: [{ name: 'get_recommendation', args: {}, result }], data: [] });
      assert.equal(r.ok, false, `${key}: ${JSON.stringify(value)} must not ground 4821`);
      assert.ok(laundered(r).includes('4821'));
    }
  }
});

test('B3: a real value field still grounds, also next to an unrelated argument and dropped metadata', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const result = [{ key: 'synthetic', v: 4821, page: 77, source: { id: 'synthetic-source', name: 'plan 9517' } }];
  const r = groundAnswer(LAUNDERED, { scenario, data: [],
    toolResults: [{ name: 'get_figures', args: { keys: ['synthetic'] }, result }] });
  assert.equal(r.ok, true, JSON.stringify(r.violations));
  assert.equal(r.literals.find(l => l.text === '4821').source, 'get_figures');
  const other = groundAnswer('It is page 77 of plan 9517.', { scenario, data: [],
    toolResults: [{ name: 'get_figures', args: { keys: ['synthetic'] }, result }] });
  assert.deepEqual(laundered(other), ['77', '9517'], 'the page and the source label are metadata');
});

// A synthetic active pack whose entry carries citation and metadata lines with numbers.
const META_PACK = {
  id: 'synthetic-metadata',
  name: 'Synthetic metadata',
  appliesWhen: ALWAYS,
  covers: ['synthetic limits'],
  entries: [{
    file: 'synthetic-limit.md',
    title: 'Synthetic limit',
    body: [
      '# Synthetic limit', '',
      'The synthetic limit is $6,175 for the year.', '',
      'Source: synthetic_guide_4821.md, page 4377',
      'sources: synthetic_appendix_9517.md',
      'Tax year: 2026',
      'REVIEWED: 2026-11-05 by reviewer 3141', '',
    ].join('\n'),
  }],
};

test('B3: pack entry citation and metadata lines never ground a number; the body does, and the model sees both', async t => {
  const s = await demoStore(t, {}, { prepare: dataDir => writeSyntheticPack(dataDir, META_PACK) });
  const said = 'The guide is 4821, page 4377, appendix 9517, reviewer 3141, and the limit is $6,175.';
  const { engine, requests } = scripted(s.runtime, [[{ text: said }], [{ text: said }]]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Synthetic metadata question' });
  assert.ok(reply.provenance.packIds.includes('synthetic-metadata'), 'the synthetic pack is active');
  assert.ok(requests[0].system.includes('synthetic_guide_4821.md, page 4377'), 'the model still sees the full entry text');
  assert.deepEqual(sorted(reply.provenance.grounding.unverified), sorted(['4821', '4377', '9517', '3141']));
  assert.ok(!reply.provenance.grounding.unverified.includes('$6,175'), 'the body amount is grounded');
  const literal = reply.provenance.literals.find(l => l.text === '$6,175');
  assert.ok(literal, JSON.stringify(reply.provenance.literals));
});

test('B3: in a pack conversation, metadata lines of context.entries never ground a number', async t => {
  const s = await demoStore(t, {}, { prepare: dataDir => writeSyntheticPack(dataDir, META_PACK) });
  // Turned off, so only the conversation context carries its entries.
  s.db.prepare("UPDATE packs_state SET active = 0 WHERE id = 'synthetic-metadata'").run();
  const said = 'The guide is 4821 and the limit is $6,175.';
  const { engine, requests } = scripted(s.runtime, [[{ text: said }], [{ text: said }]]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: 'pack:synthetic-metadata', text: 'Synthetic follow-up' });
  assert.ok(!reply.provenance.packIds.includes('synthetic-metadata'), 'not active');
  assert.ok(requests[0].systemDynamic.includes('synthetic_guide_4821.md'), 'the model still sees the full entry text');
  assert.deepEqual(reply.provenance.grounding.unverified, ['4821']);
});

// ---------------------------------------------------------------- B3: context metadata and account identifiers

// The runtime with every chat call answered by `text`, the first answer and any corrective retry.
const always = (runtime, text) => scripted(runtime, Array.from({ length: 8 }, () => [{ text }]));

// A synthetic manifest pack whose identifiers and labels carry digits its entry bodies never state.
const DIGIT_PACK = {
  id: 'plan4821',
  name: 'Synthetic plan 7316',
  version: '3.1.0',
  curator: 'Synthetic curator 5093',
  prompt: 'What would a synthetic allowance change?',
  covers: ['synthetic allowance'],
  entries: [{
    file: 'synthetic-allowance.md',
    title: 'Synthetic allowance',
    body: '# Synthetic allowance\n\nThe synthetic allowance is $6,175 per year.\n',
  }],
};

test('B3: pack id and labels in the conversation context never ground a number in a What if or a follow-up; entry bodies do', async t => {
  const s = await demoStore(t, {}, { prepare: dataDir => writeSyntheticPack(dataDir, DIGIT_PACK) });
  assert.ok(s.db.prepare("SELECT id FROM packs_state WHERE id = 'plan4821'").get(), 'the manifest pack has its own packs_state row');
  for (const e of DIGIT_PACK.entries) {
    for (const n of ['4821', '4,821', '7316', '7,316', '5093', '5,093']) assert.ok(!e.body.includes(n), `entry bodies are free of ${n}`);
  }
  const said = 'Plan 7316 by curator 5093 is worth $4,821, and the allowance is $6,175.';
  const { engine, requests } = always(s.runtime, said);
  const answerer = createLiveAnswerer({ engine, packs: s.packs });

  const whatIf = await answerer.whatIf({ db: s.db, packId: 'plan4821' });
  assert.ok(!whatIf.notice);
  assert.ok(!whatIf.provenance.packIds.includes('plan4821'), 'the pack is not active, so only the context carries it');
  assert.ok(requests[0].systemDynamic.includes('plan4821'), 'the model still sees the pack id');
  const followUp = await answerer.answer({ db: s.db, key: 'pack:plan4821', text: 'Synthetic follow-up' });
  assert.ok(!followUp.notice);

  for (const [label, reply] of [['What if', whatIf], ['follow-up', followUp]]) {
    const { unverified } = reply.provenance.grounding;
    assert.ok(unverified.includes('$4,821'), `${label}: the pack id plan4821 grounds $4,821: ${JSON.stringify(reply.provenance.grounding)}`);
    assert.ok(unverified.includes('7316'), `${label}: the pack name grounds 7316: ${JSON.stringify(unverified)}`);
    assert.ok(unverified.includes('5093'), `${label}: the pack curator grounds 5093: ${JSON.stringify(unverified)}`);
    assert.ok(!unverified.includes('$6,175'), `${label}: the entry body amount still grounds`);
    const literal = reply.provenance.literals.find(l => l.text === '$6,175');
    assert.equal(literal && literal.source, 'conversation context', JSON.stringify(reply.provenance.literals));
  }
});

test('B3: a rec id in a rec conversation context never grounds a number; its value data does', async t => {
  const s = await demoStore(t);
  const base = s.db.prepare("SELECT * FROM recs WHERE id = 'deferral'").get();
  const recId = 'rec8263';
  const def = { ...JSON.parse(base.def), id: recId, title: 'Synthetic invoicing review',
    value: [{ cls: 'cash', text: 'About $2,750 of synthetic cash arrives early' }] };
  s.db.prepare(`INSERT INTO recs (id, def, status, waiting_on, wake, tasks_done, window_close, window_label, pack_id, sort, updated_at, file_id, parser, locator)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(recId, JSON.stringify(def), base.status, base.waiting_on, base.wake, base.tasks_done, base.window_close, base.window_label,
      base.pack_id, 999, base.updated_at, base.file_id, base.parser, base.locator);
  const scenario = buildScenario(s.db);
  assert.ok(scenario.recs.some(r => r.id === recId), 'the synthetic rec is visible');
  // Self-check: without its id, the rec context has no 8263 to ground.
  const { id: _id, ...rest } = await callTool('get_recommendation', { id: recId }, { db: s.db, now: '2026-11-05' });
  assert.equal(groundAnswer('$8,263', { scenario, data: [rest] }).ok, false, 'only the id carries 8263');

  const said = 'This one is worth $8,263, and about $2,750 arrives early.';
  const { engine, requests } = always(s.runtime, said);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: recId, text: 'Synthetic rec question' });
  assert.ok(!reply.notice);
  assert.ok(requests[0].systemDynamic.includes(recId), 'the model still sees the rec id');
  const { unverified } = reply.provenance.grounding;
  assert.ok(unverified.includes('$8,263'), `the rec id grounds $8,263: ${JSON.stringify(reply.provenance.grounding)}`);
  assert.ok(!unverified.includes('$2,750'), 'the value data amount still grounds');
  const literal = reply.provenance.literals.find(l => l.text === '$2,750');
  assert.equal(literal && literal.source, 'conversation context', JSON.stringify(reply.provenance.literals));
});

const asAmount = n => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

test('B3: an account mask from the real list_accounts result never grounds a number; that account balance does', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const now = '2026-11-05';
  const accounts = await callTool('list_accounts', {}, { db: s.db, now });
  const masked = accounts.filter(a => typeof a.mask === 'string' && /^\d+$/.test(a.mask) && Number.isFinite(a.balance) && a.balance > 0);
  assert.ok(masked.length > 0, 'the demo store has masked accounts with balances');

  // The household summary carries no masks or account ids, so only the tool result could leak one.
  const summaryJson = JSON.stringify(await callTool('household_summary', {}, { db: s.db, now }));
  assert.ok(!/"(?:masks?|accountIds?|account_ids?)"/i.test(summaryJson), 'no mask or account id keys in the summary');
  for (const a of accounts) assert.ok(!summaryJson.includes(`"${a.id}"`), `the summary does not name account ${a.id}`);

  // Masks nothing else grounds: a baseline answer with no tool call states them all.
  const baselineText = `Synthetic amounts: ${masked.map(a => asAmount(a.mask)).join(', ')}.`;
  const baseline = await createLiveAnswerer({ engine: always(s.runtime, baselineText).engine, packs: s.packs })
    .answer({ db: s.db, key: THREAD, text: 'Synthetic baseline' });
  const free = new Set(baseline.provenance.grounding.unverified);
  // ...and that no other field of the tool result states.
  const stripped = accounts.map(({ mask: _mask, ...rest }) => rest);
  const account = masked.find(a => free.has(asAmount(a.mask)) && Number(a.mask) !== a.balance
    && !groundAnswer(asAmount(a.mask), { scenario, toolResults: [{ name: 'list_accounts', args: {}, result: stripped }] }).ok);
  assert.ok(account, 'some masked account has a mask nothing else grounds');
  const mask = asAmount(account.mask);
  const balance = asAmount(account.balance);

  const said = `The account holds ${balance}, and ${mask} is worth noting.`;
  const { engine, responses } = scripted(s.runtime, [
    [{ toolCalls: [{ name: 'list_accounts', args: {} }] }, { text: said }],
    [{ text: said }],
  ]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Synthetic accounts question' });
  assert.ok(!reply.notice);
  const listed = responses[0].toolResults.find(r => r.name === 'list_accounts');
  assert.ok(listed && !listed.isError, JSON.stringify(responses[0].toolResults));
  const real = listed.result.find(a => a.id === account.id);
  assert.ok(real && real.mask === account.mask, 'the scripted round ran the real tool and its result carries the mask');
  const { unverified } = reply.provenance.grounding;
  assert.ok(unverified.includes(mask), `the account mask ${account.mask} grounds ${mask}: ${JSON.stringify(reply.provenance.grounding)}`);
  assert.ok(!unverified.includes(balance), `the balance ${balance} still grounds`);
  const literal = reply.provenance.literals.find(l => l.text === balance);
  assert.equal(literal && literal.source, 'list_accounts', JSON.stringify(reply.provenance.literals));
});

test('B3 r2: a figure reference (mine[].fig = plan529) in the va529 rec context never grounds $529; a real amount does', async t => {
  const s = await demoStore(t);
  const said = 'The 529 holds $529 today, and the cap is $4,000.';
  const { engine } = always(s.runtime, said);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: 'va529', text: 'Synthetic rec question' });
  assert.ok(!reply.notice);
  const { unverified } = reply.provenance.grounding;
  assert.ok(unverified.includes('$529'), `the fig reference must not ground $529: ${JSON.stringify(reply.provenance.grounding)}`);
  assert.ok(!unverified.includes('$4,000'), 'a real amount of the rec still grounds');
});

test('B3 r2: a figure reference in a scripted get_recommendation result never grounds $529; a real amount does', async t => {
  const s = await demoStore(t);
  const said = 'The 529 holds $529 today, and the cap is $4,000.';
  const { engine, responses } = scripted(s.runtime, [
    [{ toolCalls: [{ name: 'get_recommendation', args: { id: 'va529' } }] }, { text: said }],
    [{ text: said }],
  ]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Synthetic ask' });
  assert.ok(!reply.notice);
  const got = responses[0].toolResults.find(r => r.name === 'get_recommendation');
  assert.ok(got && !got.isError && got.result.mine[0].fig === 'plan529', 'the real reader returns the fig reference');
  const { unverified } = reply.provenance.grounding;
  assert.ok(unverified.includes('$529'), `the fig reference must not ground $529: ${JSON.stringify(reply.provenance.grounding)}`);
  assert.ok(!unverified.includes('$4,000'), 'a real amount still grounds');
  const literal = reply.provenance.literals.find(l => l.text === '$4,000');
  assert.equal(literal && literal.source, 'get_recommendation', JSON.stringify(reply.provenance.literals));
});

test('B3 r2: an identifier-like string under an unremarkable key never grounds its digits', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  for (const [text, value] of [['8263', 'rec8263'], ['$529', 'plan529'], ['4821', 'acct4821x']]) {
    for (const key of ['ref', 'note', 'fig', 'detail', 'tag']) {
      const result = { title: 'Synthetic', entry: { [key]: value, v: 12 } };
      const r = groundAnswer(`The amount is ${text}.`, { scenario, data: [], toolResults: [{ name: 'get_recommendation', args: {}, result }] });
      assert.equal(r.ok, false, `${key}: ${value} must not ground ${text}`);
      assert.ok(laundered(r).includes(text));
    }
  }
  const pos = groundAnswer('The amount is 4821.', { scenario, data: [],
    toolResults: [{ name: 'get_recommendation', args: {}, result: { entry: { note: 'plan529', amount: 4821 } } }] });
  assert.equal(pos.ok, true, JSON.stringify(pos.violations));
});

test('B3 r2: an exact amount query keeps the stored row amounts as grounding, attributed to query_transactions', async t => {
  const s = await demoStore(t);
  const now = '2026-11-05';
  const all = await callTool('query_transactions', { limit: 200 }, { db: s.db, now });
  const pick = all.rows.find(r => Math.abs(r.amount) >= 100 && !all.rows.some(o => o !== r && o.amount === r.amount));
  assert.ok(pick, 'some stored transaction has a unique amount');
  const amount = pick.amount;
  const text = asAmount(Math.abs(amount));
  const said = `The matching transaction is ${text}.`;
  const baseline = await createLiveAnswerer({ engine: always(s.runtime, said).engine, packs: s.packs })
    .answer({ db: s.db, key: THREAD, text: 'Synthetic baseline' });
  assert.ok(baseline.provenance.grounding.unverified.includes(text), 'nothing else grounds the amount');

  const { engine, responses } = scripted(s.runtime, [
    [{ toolCalls: [{ name: 'query_transactions', args: { minAmount: amount, maxAmount: amount } }] }, { text: said }],
    [{ text: said }],
  ]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Synthetic exact amount' });
  assert.ok(!reply.notice);
  const got = responses[0].toolResults.find(r => r.name === 'query_transactions');
  assert.ok(got && !got.isError && got.result.rows.some(r => r.amount === amount), 'the real tool returns the row');
  const { unverified } = reply.provenance.grounding;
  assert.ok(!unverified.includes(text), `the row amount grounds ${text}: ${JSON.stringify(reply.provenance.grounding)}`);
  const literal = reply.provenance.literals.find(l => l.text === text);
  assert.equal(literal && literal.source, 'query_transactions', JSON.stringify(reply.provenance.literals));
});

test('B3 r2: argument echoes under the same key still do not ground, while other keys with the same value do', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const echoed = groundAnswer(LAUNDERED, { scenario, data: [],
    toolResults: [{ name: 'query_transactions', args: { minAmount: 4821, maxAmount: 4821 }, result: { minAmount: 4821, maxAmount: 4821, rows: [], total: 0 } }] });
  assert.equal(echoed.ok, false);
  const contained = groundAnswer(LAUNDERED, { scenario, data: [],
    toolResults: [{ name: 'query_transactions', args: { text: 'plan 4821' }, result: { rows: [], note: 'No rows matched plan 4821 this year', total: 0 } }] });
  assert.equal(contained.ok, false);
  const real = groundAnswer(LAUNDERED, { scenario, data: [],
    toolResults: [{ name: 'query_transactions', args: { minAmount: 4821, maxAmount: 4821 }, result: { rows: [{ id: 1, amount: 4821 }], total: 1 } }] });
  assert.equal(real.ok, true, JSON.stringify(real.violations));
  assert.equal(real.literals.find(l => l.text === '4821').source, 'query_transactions');
});

// ---------------------------------------------------------------- rendering

test('renderAnswer escapes markup, quotes and stray braces, keeps valid tokens, and splits paragraphs on blank lines', () => {
  const text = 'Hello <script>alert(1)</script> & "quoted" it\'s {stray} here.\n\nSecond {f:true_reserve} paragraph.';
  const out = renderAnswer(text, []);
  assert.equal(out.length, 2);
  const html = out.join('\n');
  assert.ok(!html.includes('<script'), html);
  assert.ok(html.includes('&lt;script&gt;'), html);
  assert.ok(html.includes('&amp;'), html);
  assert.ok(html.includes('&quot;quoted&quot;'), html);
  assert.ok(html.includes('&#39;'), html);
  assert.ok(html.includes('&#123;stray&#125;'), html);
  assert.ok(!html.includes('{stray}'), html);
  assert.ok(out[1].includes('{f:true_reserve}'), 'a valid token stays raw for the UI to resolve');
});

test('renderAnswer wraps each violation in an fx-unverified span and neutralizes an invalid token', () => {
  const text = `You could save ${INVENTED} next year, see {f:nope}.`;
  const violations = [
    { text: INVENTED, index: text.indexOf(INVENTED), reason: 'number or unit absent from sources' },
    { text: '{f:nope}', index: text.indexOf('{f:nope}'), reason: 'unknown figure token' },
  ];
  const html = renderAnswer(text, violations).join('');
  assert.ok(html.includes(`${UNVERIFIED}${INVENTED}</span>`), html);
  assert.ok(!html.includes('{f:nope}'), 'an invalid token is never left resolvable');
  assert.equal(html.split('class="fx-unverified"').length - 1, 2, html);
});

// ---------------------------------------------------------------- the live answerer

test('a suggested question answers through the fake engine with tools, figures, refs, packs and cost in provenance', async t => {
  const s = await demoStore(t);
  const { engine, requests } = scripted(s.runtime);
  const answerer = createLiveAnswerer({ engine, packs: s.packs });
  const before = spendCount(s.db);
  const reply = await answerer.answer({ db: s.db, key: THREAD, text: LEAVE });
  assert.ok(!reply.notice);
  assert.ok(reply.paragraphs.length > 0);
  assert.ok(joined(reply).includes('{f:yearend_cash}'), joined(reply));
  for (const id of ['reserve', 'deferral']) assert.ok(reply.refs.includes(id), `refs include ${id}`);
  const p = reply.provenance;
  assert.equal(p.engine, 'fake');
  assert.equal(p.model, 'fake');
  assert.ok(p.costUsd > 0);
  assert.deepEqual(p.grounding, { ok: true, retried: false, unverified: [] });
  const figures = ['fixed_fee', 'reserve_target', 'true_reserve', 'yearend_cash'];
  assert.deepEqual(sorted(p.figures), figures);
  const summary = p.tools.find(x => x.name === 'household_summary');
  assert.ok(summary, JSON.stringify(p.tools));
  assert.deepEqual(summary.args, {});
  const figs = p.tools.find(x => x.name === 'get_figures');
  assert.ok(figs, JSON.stringify(p.tools));
  assert.deepEqual(sorted(figs.args.keys), figures);
  assert.deepEqual(sorted(p.packIds), ACTIVE_DEMO_PACKS);
  assert.equal(requests.length, 1);
  assert.ok(spendCount(s.db) > before, 'spend was recorded');
});

test('an answer that fails grounding is retried once and the grounded retry is stored', async t => {
  const s = await demoStore(t);
  const { engine, requests } = scripted(s.runtime, [
    [{ text: `You could save ${INVENTED} this year.` }],
    [{ text: 'Your plan already covers the leave months.' }],
  ]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Synthetic retry question' });
  assert.equal(requests.length, 2, 'two model calls');
  assert.ok(!reply.notice);
  assert.deepEqual(reply.provenance.grounding, { ok: true, retried: true, unverified: [] });
  assert.ok(!joined(reply).includes('987,654'), joined(reply));
  assert.ok(joined(reply).includes('leave months'));
  assert.equal(requests[1].system, requests[0].system, 'the corrective turn keeps the cached system');
  assert.ok(requests[1].messages.length > requests[0].messages.length, 'the retry carries a corrective turn');
  assert.equal(requests[1].messages.at(-1).role, 'user');
});

test('an answer still ungrounded after the retry is stored with the number marked unverified', async t => {
  const s = await demoStore(t);
  const { engine, requests } = scripted(s.runtime, [
    [{ text: `You could save ${INVENTED} this year.` }],
    [{ text: `You could still save ${INVENTED} this year.` }],
  ]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Synthetic retry question' });
  assert.equal(requests.length, 2);
  assert.ok(!reply.notice);
  assert.ok(joined(reply).includes(`${UNVERIFIED}${INVENTED}</span>`), joined(reply));
  assert.equal(reply.provenance.grounding.ok, false);
  assert.equal(reply.provenance.grounding.retried, true);
  assert.ok(reply.provenance.grounding.unverified.includes(INVENTED));
});

// B1: a corrective retry that fails answers with the matching notice, never the first ungrounded
// text, and the spend the engine recorded before it threw stays in the ledger.

const chatRows = db => db.prepare("SELECT id, purpose, model, cost_usd FROM spend_ledger WHERE purpose = 'chat' ORDER BY id").all().map(r => ({ ...r }));
// The runtime records spend at the current time (no clock-based now in this fixture).
const thisMonth = () => new Date().toISOString().slice(0, 7);

test('B1: a corrective retry refused by the engine switch answers with the engine-off notice and keeps the first spend row', async t => {
  const s = await demoStore(t);
  const { engine, requests } = scripted(s.runtime, [
    [{ text: `You could save ${INVENTED} this year.` }],
    [{ text: 'must not run' }],
  ], { before: n => { if (n === 1) setSetting(s.db, 'engine', { on: false }); } });
  const before = chatRows(s.db).length;
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Synthetic retry question' });
  assert.equal(requests.length, 2, 'the retry was attempted');
  assert.equal(reply.notice, true);
  assert.deepEqual(reply.paragraphs, [NOTICES.engineOff]);
  assert.ok(!joined(reply).includes('987,654'), 'the first ungrounded text is never returned');
  assert.ok(!joined(reply).includes('must not run'));
  const added = chatRows(s.db).slice(before);
  assert.equal(added.length, 1, 'the first call spend row stays; the refused retry recorded none');
  assert.equal(added[0].model, 'fake');
  assert.ok(added[0].cost_usd > 0);
});

test('B1: a corrective retry refused over the cap the first call exhausted answers with the over-cap notice', async t => {
  const s = await demoStore(t);
  // The cap sits half a dollar above this month's spend; the first call spends a whole dollar.
  setSetting(s.db, 'cap', { usd: createSpendLedger(s.db).monthSpendUsd(thisMonth()) + 0.5 });
  const { engine, requests } = scripted(s.runtime, [
    [{ text: `You could save ${INVENTED} this year.`, costUsd: 1 }],
    [{ text: 'must not run' }],
  ]);
  const before = chatRows(s.db).length;
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Synthetic retry question' });
  assert.equal(requests.length, 2, 'the retry was attempted');
  assert.equal(reply.notice, true, 'a notice, not the first answer marked');
  assert.deepEqual(reply.paragraphs, [NOTICES.overCap]);
  assert.ok(!joined(reply).includes('987,654'), joined(reply));
  assert.ok(!joined(reply).includes('must not run'));
  const added = chatRows(s.db).slice(before);
  assert.equal(added.length, 1, 'the first call spend row stays; the refused retry recorded none');
  assert.equal(added[0].cost_usd, 1);
});

test('B1: a corrective retry that fails in the model answers with the model-error notice and keeps both spend rows', async t => {
  const s = await demoStore(t);
  const { engine, requests } = scripted(s.runtime, [
    [{ text: `You could save ${INVENTED} this year.` }],
    [{ text: 'Fabricated $123,456 figure', is_error: true, status: 'error_during_execution' }],
  ]);
  const before = chatRows(s.db).length;
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Synthetic retry question' });
  assert.equal(requests.length, 2, 'the retry was attempted');
  assert.equal(reply.notice, true);
  assert.deepEqual(reply.paragraphs, [NOTICES.modelError]);
  assert.ok(!joined(reply).includes('987,654'), joined(reply));
  assert.ok(!joined(reply).includes('Fabricated'));
  assert.ok(!joined(reply).includes('123,456'));
  // The fake engine records the failed round before it throws, as the live engine does.
  assert.equal(chatRows(s.db).slice(before).length, 2, 'the first call row and the failed retry round row');
});

test('a literal number grounded by a tool result is bound to its source and listed in provenance', async t => {
  const s = await demoStore(t);
  const n = (await callTool('household_summary', {}, { db: s.db, now: '2026-11-05' })).needsYouCount;
  const { engine } = scripted(s.runtime, [[
    { toolCalls: [{ name: 'household_summary', args: {} }] },
    { text: `From your household summary, ${n} items need you right now.` },
  ]]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'How many items need me?' });
  assert.ok(!reply.notice);
  assert.equal(reply.provenance.grounding.ok, true);
  assert.match(joined(reply), new RegExp(`<span class="fx-src" data-src="[^"]*" title="From [^"]+">${n}</span>`));
  const literal = (reply.provenance.literals || []).find(x => x.text === String(n));
  assert.ok(literal, JSON.stringify(reply.provenance.literals));
  assert.match(String(literal.source), /household.summary/i);
});

test('a retry that drops the tool call stays grounded by the first attempt tool results', async t => {
  const s = await demoStore(t);
  const value = buildScenario(s.db).fig.fixed_fee.v;
  const amount = `$${value.toLocaleString('en-US')}`;
  const { engine, requests } = scripted(s.runtime, [
    [
      { toolCalls: [{ name: 'get_figures', args: { keys: ['fixed_fee'] } }] },
      { text: `About ${amount} of delivered work is not invoiced, and you could save ${INVENTED}.` },
    ],
    [{ text: `About ${amount} of delivered work is not invoiced.` }],
  ]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Synthetic invoice question' });
  assert.equal(requests.length, 2);
  assert.ok(!reply.notice);
  const html = joined(reply);
  assert.ok(!html.includes('fx-unverified'), html);
  assert.ok(!html.includes('987,654'), html);
  assert.ok(new RegExp(`<span class="fx-src"[^>]*>${amount.replace('$', '\\$')}</span>`).test(html), html);
  assert.deepEqual(reply.provenance.grounding, { ok: true, retried: true, unverified: [] });
  const call = reply.provenance.tools.find(x => x.name === 'get_figures');
  assert.ok(call, JSON.stringify(reply.provenance.tools));
  assert.deepEqual(call.args, { keys: ['fixed_fee'] });
});

test('engine off by the switch answers with the engine-off notice and spends nothing; back on answers again', async t => {
  const s = await demoStore(t);
  const answerer = createLiveAnswerer({ engine: s.runtime, packs: s.packs });
  setSetting(s.db, 'engine', { on: false });
  const before = spendCount(s.db);
  const off = await answerer.answer({ db: s.db, key: THREAD, text: LEAVE });
  assert.equal(off.notice, true);
  assert.ok(joined(off).includes('Engine is off, so answers are paused.'), joined(off));
  assert.equal(spendCount(s.db), before);
  setSetting(s.db, 'engine', { on: true });
  const on = await answerer.answer({ db: s.db, key: THREAD, text: LEAVE });
  assert.ok(!on.notice);
  assert.ok(on.provenance);
});

test('engine off by configuration answers with the configuration notice and spends nothing', async t => {
  const s = await demoStore(t);
  const off = createRuntimeEngine({ db: s.db, config: loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'off' }) });
  const before = spendCount(s.db);
  const reply = await createLiveAnswerer({ engine: off, packs: s.packs }).answer({ db: s.db, key: THREAD, text: LEAVE });
  assert.equal(reply.notice, true);
  assert.ok(joined(reply).includes('off in this deployment'), joined(reply));
  assert.ok(!joined(reply).includes('{f:yearend_cash}'), 'no answer text');
  assert.equal(spendCount(s.db), before);
});

test('over the cap answers with the budget notice and spends nothing; a raised cap answers again', async t => {
  const s = await demoStore(t);
  const answerer = createLiveAnswerer({ engine: s.runtime, packs: s.packs });
  setSetting(s.db, 'cap', { usd: 0 });
  const before = spendCount(s.db);
  const capped = await answerer.answer({ db: s.db, key: THREAD, text: LEAVE });
  assert.equal(capped.notice, true);
  assert.ok(joined(capped).includes('{f:engine.budget.monthly}'), joined(capped));
  assert.ok(joined(capped).includes('is used up, so answers are paused'), joined(capped));
  assert.equal(spendCount(s.db), before);
  setSetting(s.db, 'cap', { usd: 200 });
  assert.ok(!(await answerer.answer({ db: s.db, key: THREAD, text: LEAVE })).notice);
});

test('a model error answers with the model-error notice and never stores the failed text', async t => {
  const s = await demoStore(t);
  const { engine } = scripted(s.runtime, [[{ text: 'Fabricated $123,456 figure', is_error: true, status: 'error_during_execution' }]]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Synthetic question' });
  assert.equal(reply.notice, true);
  assert.ok(joined(reply).includes('could not answer just now, so nothing was made up'), joined(reply));
  assert.ok(!joined(reply).includes('Fabricated'));
  assert.ok(!joined(reply).includes('123,456'));
});

// ---------------------------------------------------------------- B2: chat proposes, never writes

const PROPOSE = 'propose_recommendation_action';
const WRITE = 'set_recommendation_status';
const recStatus = (db, id) => db.prepare('SELECT status FROM recs WHERE id = ?').get(id).status;
const recEvents = db => db.prepare('SELECT count(*) AS n FROM rec_events').get().n;
const allStatuses = db => Object.fromEntries(db.prepare('SELECT id, status FROM recs ORDER BY id').all().map(r => [r.id, r.status]));
const proposeResults = responses => responses.flatMap(r => r.toolResults || []).filter(r => r.name === PROPOSE);
const STATUS_TEXTS = ['Please mark this done', 'mark this done', 'Do not mark anything done', 'Snooze this until next month',
  'Should I mark this done?', 'Tell me about the payroll cash', 'dismiss this'];

test('B2: ask and rec conversations offer propose_recommendation_action and never set_recommendation_status for any text', async t => {
  const s = await demoStore(t);
  const { engine, requests } = scripted(s.runtime);
  const answerer = createLiveAnswerer({ engine, packs: s.packs });
  for (const key of ['deferral', THREAD]) {
    for (const text of STATUS_TEXTS) await answerer.answer({ db: s.db, key, text });
  }
  await answerer.answer({ db: s.db, key: 'deferral', questionId: 0 });
  await answerer.answer({ db: s.db, key: THREAD, text: LEAVE });
  assert.equal(requests.length, STATUS_TEXTS.length * 2 + 2);
  for (const r of requests) {
    const names = toolNames(r);
    assert.ok(names.includes(PROPOSE), `${PROPOSE} is offered: ${r.messages.at(-1).content}`);
    assert.ok(!names.includes(WRITE), `${WRITE} is never offered: ${r.messages.at(-1).content}`);
    assert.ok(names.includes('household_summary'), 'read tools are always offered');
  }
});

test('B2: pack conversations and What if offer neither the proposal tool nor the write tool', async t => {
  const s = await demoStore(t);
  const { engine, requests } = scripted(s.runtime);
  const answerer = createLiveAnswerer({ engine, packs: s.packs });
  await answerer.answer({ db: s.db, key: 'pack:giving', text: 'Please mark this done' });
  await answerer.answer({ db: s.db, key: 'pack:giving', text: 'dismiss this' });
  await answerer.whatIf({ db: s.db, packId: 'giving' });
  assert.equal(requests.length, 3);
  for (const r of requests) {
    assert.ok(!toolNames(r).includes(PROPOSE), 'no proposal tool');
    assert.ok(!toolNames(r).includes(WRITE), 'no write tool');
    assert.ok(toolNames(r).includes('household_summary'));
  }
});

test('B2: the proposal tool is a read-scoped tool with a closed schema over the rec actions', async t => {
  const s = await demoStore(t);
  const { engine, requests } = scripted(s.runtime);
  await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Synthetic question' });
  const tool = requests[0].tools.find(x => x.name === PROPOSE);
  assert.ok(tool, 'offered');
  assert.equal(tool.scope, 'read');
  assert.equal(typeof tool.description, 'string');
  assert.equal(typeof tool.handler, 'function');
  const schema = tool.inputSchema;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(sorted(schema.required), ['action', 'id']);
  assert.deepEqual(sorted(Object.keys(schema.properties)), ['action', 'id', 'wake']);
  assert.equal(schema.properties.id.type, 'string');
  assert.equal(schema.properties.action.type, 'string');
  assert.deepEqual(sorted(schema.properties.action.enum), sorted(Object.keys(ACTION_STATUS)));
  assert.ok(!schema.properties.action.enum.includes('none'));
  assert.equal(schema.properties.wake.type, 'string');
  assert.equal(schema.properties.wake.maxLength, 200);
});

test('B2: a scripted proposal yields provenance.proposal and leaves the rec and its history unchanged', async t => {
  const s = await demoStore(t);
  const status = recStatus(s.db, 'deferral');
  const events = recEvents(s.db);
  const { engine, responses } = scripted(s.runtime, [[
    { toolCalls: [{ name: PROPOSE, args: { id: 'deferral', action: 'dismiss' } }] },
    { text: 'You can confirm setting this aside below.' },
  ]]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: 'deferral', text: 'dismiss this' });
  assert.ok(!reply.notice);
  assert.deepEqual(reply.provenance.proposal, { recId: 'deferral', action: 'dismiss' });
  const [result] = proposeResults(responses);
  assert.ok(result && !result.isError, JSON.stringify(result));
  assert.deepEqual(result.result, { proposed: true }, 'the handler returns only { proposed: true }, no echo of its arguments');
  assert.equal(recStatus(s.db, 'deferral'), status, 'the store is not touched');
  assert.equal(recEvents(s.db), events, 'no rec history row');
  const call = reply.provenance.tools.find(x => x.name === PROPOSE);
  assert.deepEqual(call.args, { id: 'deferral', action: 'dismiss' }, 'tool provenance keeps the call');
});

test('B2: a snooze proposal in ask carries its wake label, and the last successful proposal wins', async t => {
  const s = await demoStore(t);
  const before = allStatuses(s.db);
  const { engine } = scripted(s.runtime, [[
    { toolCalls: [{ name: PROPOSE, args: { id: 'dcfsa', action: 'start' } }] },
    { toolCalls: [{ name: PROPOSE, args: { id: 'dcfsa', action: 'snooze', wake: 'Next month' } }] },
    { toolCalls: [{ name: PROPOSE, args: { id: 'daf', action: 'dismiss' } }] },
    { text: 'You can confirm the snooze below.' },
  ]]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Snooze the dependent care one' });
  assert.ok(!reply.notice);
  assert.deepEqual(reply.provenance.proposal, { recId: 'dcfsa', action: 'snooze', wake: 'Next month' },
    'one proposal: the last successful call (the later hidden-rec call fails)');
  assert.deepEqual(allStatuses(s.db), before);
});

test('B2: in a rec conversation a proposal for a different rec is dropped', async t => {
  const s = await demoStore(t);
  const before = allStatuses(s.db);
  const { engine, requests, responses } = scripted(s.runtime, [[
    { toolCalls: [{ name: PROPOSE, args: { id: 'dcfsa', action: 'dismiss' } }] },
    { text: 'You can confirm it below.' },
  ]]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: 'deferral', text: 'dismiss the other one' });
  assert.ok(!reply.notice);
  assert.ok(toolNames(requests[0]).includes(PROPOSE), 'the proposal tool is offered in a rec conversation');
  const [result] = proposeResults(responses);
  assert.ok(result, 'the call ran');
  assert.ok(reply.provenance.proposal == null, 'no proposal for a rec other than the conversation rec');
  assert.deepEqual(allStatuses(s.db), before);
});

test('B2: a proposal for a hidden or unknown rec, an unknown action or an extra argument is an error with no proposal', async t => {
  const s = await demoStore(t);
  assert.equal(recStatus(s.db, 'daf'), 'hidden', 'daf is behind an inactive pack');
  const before = allStatuses(s.db);
  const bad = [
    { id: 'daf', action: 'dismiss' },
    { id: 'no-such-rec', action: 'start' },
    { id: 'dcfsa', action: 'accept' }, // retired: Doing it is the start action
    { id: 'dcfsa', action: 'delete' },
    { id: 'dcfsa', action: 'none' },
    { id: 'dcfsa', action: 'complete', status: 'done' },
    { id: 'dcfsa', action: 'snooze', wake: 'w'.repeat(201) },
  ];
  for (const args of bad) {
    const { engine, requests, responses } = scripted(s.runtime, [[
      { toolCalls: [{ name: PROPOSE, args }] },
      { text: 'Nothing to confirm here.' },
    ]]);
    const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Synthetic proposal question' });
    assert.ok(!reply.notice, JSON.stringify(args));
    assert.ok(toolNames(requests[0]).includes(PROPOSE), 'the proposal tool is offered in ask');
    const results = proposeResults(responses);
    assert.equal(results.length, 1, JSON.stringify(args));
    assert.equal(results[0].isError, true, `an error result for ${JSON.stringify(args)}`);
    assert.ok(reply.provenance.proposal == null, `no proposal for ${JSON.stringify(args)}`);
  }
  assert.deepEqual(allStatuses(s.db), before);
});

test('B2: the fake engine proposes an explicit command that names the rec, and never a negation', async t => {
  const s = await demoStore(t);
  const before = allStatuses(s.db);
  const dcfsaTitle = buildScenario(s.db).recs.find(r => r.id === 'dcfsa').title;
  assert.ok(!dcfsaTitle.includes('{'), 'a title with no tokens to name in the text');
  const answerer = createLiveAnswerer({ engine: s.runtime, packs: s.packs });
  const cases = [
    ['deferral', 'dismiss this', { recId: 'deferral', action: 'dismiss' }],
    ['deferral', 'Please complete this', { recId: 'deferral', action: 'complete' }],
    ['deferral', 'start this one', { recId: 'deferral', action: 'start' }],
    [THREAD, 'Please start dcfsa', { recId: 'dcfsa', action: 'start' }],
    [THREAD, `Dismiss ${dcfsaTitle}`, { recId: 'dcfsa', action: 'dismiss' }],
  ];
  for (const [key, text, want] of cases) {
    const reply = await answerer.answer({ db: s.db, key, text });
    assert.ok(!reply.notice, text);
    const got = reply.provenance.proposal;
    assert.ok(got, `a proposal for "${text}"`);
    assert.deepEqual({ recId: got.recId, action: got.action }, want, text);
    const call = reply.provenance.tools.find(x => x.name === PROPOSE);
    assert.ok(call, `the scripted tool round calls ${PROPOSE} for "${text}"`);
    assert.equal(call.args.id, want.recId);
    assert.equal(call.args.action, want.action);
    assert.match(joined(reply), /confirm/i, 'the text says the owner can confirm it below');
  }
  const none = [
    ['deferral', 'Do not mark anything done'],
    ['deferral', 'Should I dismiss this?'],
    ['deferral', 'Tell me why I should not dismiss this'],
    [THREAD, 'dismiss something'],
    [THREAD, 'Do not dismiss dcfsa'],
    ['pack:giving', 'dismiss this'],
  ];
  for (const [key, text] of none) {
    const reply = await answerer.answer({ db: s.db, key, text });
    assert.ok(!reply.provenance || reply.provenance.proposal == null, `no proposal for "${text}" in ${key}`);
    assert.ok(!(reply.provenance ? reply.provenance.tools : []).some(x => x.name === PROPOSE), `no proposal call for "${text}"`);
  }
  assert.deepEqual(allStatuses(s.db), before, 'no rec status changed');
});

test('a rec conversation answer refs the rec and reads it through get_recommendation', async t => {
  const s = await demoStore(t);
  const reply = await createLiveAnswerer({ engine: s.runtime, packs: s.packs }).answer({ db: s.db, key: 'deferral', questionId: 0 });
  assert.ok(!reply.notice);
  assert.ok(reply.refs.includes('deferral'));
  const rec = reply.provenance.tools.find(x => x.name === 'get_recommendation');
  assert.ok(rec, JSON.stringify(reply.provenance.tools));
  assert.deepEqual(rec.args, { id: 'deferral' });
});

test('a manual pack override changes the prompt pack context and the provenance pack ids', async t => {
  const s = await demoStore(t);
  const { engine, requests } = scripted(s.runtime);
  const answerer = createLiveAnswerer({ engine, packs: s.packs });
  const base = await answerer.answer({ db: s.db, key: THREAD, text: 'Synthetic override question' });
  assert.deepEqual(sorted(base.provenance.packIds), ACTIVE_DEMO_PACKS);
  s.db.prepare("UPDATE packs_state SET active = 1 WHERE id = 'giving'").run();
  const on = await answerer.answer({ db: s.db, key: THREAD, text: 'Synthetic override question' });
  assert.ok(on.provenance.packIds.includes('charitable-giving'));
  assert.notEqual(requests[1].system, requests[0].system, 'pack context follows the override');
  s.db.prepare("UPDATE packs_state SET active = 0 WHERE id = 'scorp'").run();
  const off = await answerer.answer({ db: s.db, key: THREAD, text: 'Synthetic override question' });
  assert.ok(!off.provenance.packIds.includes('s-corp-owner'));
  assert.ok(off.provenance.packIds.includes('charitable-giving'));
});

test('provenance.packEntries lists cited entries of the conversation pack even when it is not active', async t => {
  const s = await demoStore(t);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'packs', 'charitable-giving', 'manifest.json'), 'utf8'));
  const givingTitle = manifest.entries.find(e => e.file === 'bunching.md').title;
  const scorpTitle = JSON.parse(readFileSync(join(ROOT, 'packs', 's-corp-owner', 'manifest.json'), 'utf8'))
    .entries.find(e => e.file === 'reasonable-compensation.md').title;
  assert.ok(!/\d/.test(givingTitle) && !/\d/.test(scorpTitle), 'titles carry no numbers to ground');
  assert.equal(buildScenario(s.db).packs.find(p => p.id === 'giving').status, 'suggested', 'giving is not active');
  const { engine } = scripted(s.runtime, [
    [{ text: `${givingTitle} is the entry that matters here.` }],
    [{ text: `As a follow-up, ${givingTitle} still applies.` }],
    [{ text: `${scorpTitle} is the entry that matters here.` }],
  ]);
  const answerer = createLiveAnswerer({ engine, packs: s.packs });

  const whatIf = await answerer.whatIf({ db: s.db, packId: 'giving' });
  assert.ok(!whatIf.notice);
  assert.ok(whatIf.provenance.packEntries.includes(givingTitle), JSON.stringify(whatIf.provenance.packEntries));

  const followUp = await answerer.answer({ db: s.db, key: 'pack:giving', text: 'Tell me more about that' });
  assert.ok(!followUp.notice);
  assert.ok(followUp.provenance.packEntries.includes(givingTitle), JSON.stringify(followUp.provenance.packEntries));

  const active = await answerer.answer({ db: s.db, key: THREAD, text: 'Which entry matters' });
  assert.ok(active.provenance.packEntries.includes(scorpTitle), 'active pack entries are still found');
  assert.ok(!active.provenance.packEntries.includes(givingTitle));
});

test('a what-if runs a live conversation seeded with the pack prompt and pack metadata', async t => {
  const s = await demoStore(t);
  const { engine, requests } = scripted(s.runtime);
  const def = buildScenario(s.db, { packs: s.packs }).packs.find(p => p.id === 'giving');
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).whatIf({ db: s.db, packId: 'giving' });
  assert.ok(!reply.notice);
  assert.ok(reply.paragraphs.length > 0);
  assert.equal(reply.provenance.engine, 'fake');
  assert.equal(reply.provenance.grounding.ok, true);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].messages.some(m => typeof m.content === 'string' && m.content.includes(def.whatIf.prompt)),
    'the pack prompt opens the conversation');
  assert.ok(requests[0].systemDynamic.includes(def.entryList[0].title), 'pack entries are in the dynamic system');
  assert.ok(!requests[0].system.includes('<household_summary>'));
});

// ---------------------------------------------------------------- round 3: evidence by construction
//
// A: an echo is only a result leaf under the same key as an equal argument, or a string containing
// an argument string; tools never launder arguments (the contract test). B: inside prose strings
// only quantity-marked numbers ($, %, percent, k, thousand, million, billion) are evidence.
// D: a hyphen glued to a letter or digit is not a minus sign.

const SENTINEL_TEXT = 'zq7sentinel93';
const SENTINEL_AMOUNT = 987654.31;
const SENTINEL_STRINGS = [SENTINEL_TEXT, `zq7 ${SENTINEL_AMOUNT} sentinel`];
const SENTINEL_DATES = ['2091-07-23', '2091-07'];
const SENTINEL_MARKS = ['zq7', '987654', '987,654', '2091'];
const IDENTIFIER_KEY = /^(?:id|ids|key|keys)$|(?:Id|Ids|_id|_ids)$/;

// Every tool the answerer offers in an ask and a rec conversation, read from its own requests.
async function offeredTools(s) {
  const { engine, requests } = scripted(s.runtime);
  const answerer = createLiveAnswerer({ engine, packs: s.packs });
  await answerer.answer({ db: s.db, key: THREAD, text: 'Synthetic contract question' });
  await answerer.answer({ db: s.db, key: 'deferral', text: 'Synthetic contract question' });
  const byName = new Map();
  for (const r of requests) for (const tool of r.tools || []) byName.set(tool.name, tool);
  return [...byName.values()];
}

// Each leaf (and object key) of a result with the key path it sits under.
function leaves(v, key, out = []) {
  if (Array.isArray(v)) for (const x of v) leaves(x, key, out);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) { out.push({ key, value: k, isKey: true }); leaves(x, k, out); }
  } else out.push({ key, value: v });
  return out;
}

// In-domain argument candidates for one property schema: { value, sentinel }.
function candidates(schema, name, intSentinel) {
  if (schema.anyOf) return schema.anyOf.flatMap(branch => candidates(branch, name, intSentinel));
  if (schema.enum) return [{ value: schema.enum[0], sentinel: false }];
  const type = [].concat(schema.type)[0];
  if (type === 'string') {
    if (schema.pattern) {
      const date = SENTINEL_DATES.find(d => new RegExp(schema.pattern).test(d));
      assert.ok(date, `extend the contract test: no sentinel matches ${name} pattern ${schema.pattern}`);
      return [{ value: date, sentinel: true }];
    }
    return SENTINEL_STRINGS.map(value => ({ value, sentinel: true }));
  }
  if (type === 'number') {
    assert.ok(schema.minimum == null && schema.maximum == null, `extend the contract test: ${name} has a numeric range`);
    return [SENTINEL_AMOUNT, -SENTINEL_AMOUNT].map(value => ({ value, sentinel: true }));
  }
  if (type === 'integer') {
    assert.ok(Number.isInteger(intSentinel), `extend the contract test: no integer sentinel for ${name}`);
    return [{ value: intSentinel, sentinel: true }];
  }
  if (type === 'array') return candidates(schema.items || { type: 'string' }, name, intSentinel).map(c => ({ value: [c.value], sentinel: c.sentinel }));
  if (type === 'boolean') return [{ value: true, sentinel: false }];
  return assert.fail(`extend the contract test: ${name} has type ${type}`);
}

test('R3 A contract: no tool the answerer offers returns a sentinel argument outside identifier keys', async t => {
  const s = await demoStore(t);
  const offered = await offeredTools(s);
  const names = offered.map(tool => tool.name);
  assert.deepEqual(sorted(names), sorted([...REGISTRY.filter(x => x.scope === 'read').map(x => x.name), PROPOSE, 'propose_goal']),
    'every read tool and the local proposal tools, nothing else');
  const recId = s.db.prepare("SELECT id FROM recs WHERE status != 'hidden' ORDER BY id LIMIT 1").get().id;
  const realPack = s.packs.loaded().find(p => p.id === 's-corp-owner');
  const ctx = { db: s.db, now: clockNow(s.db) };

  const calls = [];
  const plan = new Map();
  for (const tool of offered) {
    const props = (tool.inputSchema && tool.inputSchema.properties) || {};
    const required = new Set(tool.inputSchema.required || []);
    // Required arguments take real store values so the tool answers; a sentinel id is an error result.
    const base = {};
    for (const name of required) {
      const schema = props[name];
      if (schema.enum) base[name] = schema.enum[0];
      else if (name === 'id') base[name] = recId;
      else if (name === 'packId') base[name] = realPack.id;
      else if (name === 'file') base[name] = realPack.entries[0].file;
      else if (name === 'query') base[name] = 'tax';
      else if (name === 'title') base[name] = 'Synthetic goal';
      else assert.fail(`extend the contract test: ${tool.name} requires ${name}`);
    }
    // An integer sentinel in range that the tool never returns for real arguments at their widest.
    const widest = { ...base };
    for (const [name, schema] of Object.entries(props)) if (schema.type === 'integer' && schema.maximum != null) widest[name] = schema.maximum;
    const seen = JSON.stringify(await tool.handler(widest, ctx));
    const numbers = new Set(leaves(JSON.parse(seen)).map(l => l.value).filter(v => typeof v === 'number'));
    const intProp = Object.values(props).find(p => p.type === 'integer');
    let intSentinel;
    if (intProp) {
      for (let n = intProp.maximum ?? 1000; n >= (intProp.minimum ?? 1) && intSentinel === undefined; n--) {
        if (!numbers.has(n)) intSentinel = n;
      }
    }
    const args = [base];
    const all = { ...base };
    for (const [name, schema] of Object.entries(props)) {
      const list = candidates(schema, name, intSentinel);
      for (const c of list) args.push({ ...base, [name]: c.value });
      if (!required.has(name)) all[name] = list[0].value;
    }
    args.push(all);
    plan.set(tool.name, { intSentinel });
    for (const a of args) calls.push({ name: tool.name, args: a });
  }

  const { engine, responses } = scripted(s.runtime, [[{ toolCalls: calls }, { text: 'Synthetic contract answer.' }]]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Synthetic contract run' });
  assert.ok(!reply.notice, JSON.stringify(reply));
  const results = responses[0].toolResults;
  assert.equal(results.length, calls.length, 'every scripted call ran');
  for (const r of results) {
    assert.ok(!(r.isError && r.result && r.result.error), `schema-valid arguments: ${r.name} ${JSON.stringify(r.args)}`);
  }
  for (const name of names) {
    assert.ok(results.some(r => r.name === name && !r.isError), `${name} answers some sentinel call`);
    const props = Object.keys(offered.find(x => x.name === name).inputSchema.properties || {});
    for (const p of props) {
      assert.ok(results.some(r => r.name === name && !r.isError && Object.hasOwn(r.args, p)), `${name} answers a call with ${p}`);
    }
  }
  for (const r of results.filter(x => !x.isError)) {
    const { intSentinel } = plan.get(r.name);
    for (const leaf of leaves(r.result)) {
      if (!leaf.isKey && leaf.key !== undefined && IDENTIFIER_KEY.test(leaf.key)) continue;
      const where = `${r.name}(${JSON.stringify(r.args)}) ${leaf.isKey ? 'key' : `under ${leaf.key}`}: ${JSON.stringify(leaf.value)}`;
      if (typeof leaf.value === 'number') {
        assert.ok(Math.abs(leaf.value) !== SENTINEL_AMOUNT, where);
        if (Object.values(r.args || {}).includes(intSentinel)) assert.notEqual(leaf.value, intSentinel, where);
      } else if (typeof leaf.value === 'string') {
        const lc = leaf.value.toLowerCase();
        assert.ok(!SENTINEL_MARKS.some(m => lc.includes(m)), where);
      }
    }
  }
});

test('R3 A (F2): query_transactions total equal to the limit argument grounds, attributed to query_transactions', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  // The real match count per account, read from the store; one whose count fits in a single page.
  const counts = s.db.prepare('SELECT account_id AS id, count(*) AS n FROM transactions GROUP BY account_id ORDER BY n, account_id').all()
    .filter(c => c.n >= 1 && c.n <= 200);
  let pick = null;
  for (const c of counts) {
    const said = `There are ${c.n} matching transactions.`;
    const baseline = await createLiveAnswerer({ engine: always(s.runtime, said).engine, packs: s.packs })
      .answer({ db: s.db, key: THREAD, text: 'Synthetic baseline' });
    if (!baseline.provenance.grounding.unverified.includes(String(c.n))) continue;
    const page = await callTool('query_transactions', { accountId: c.id, limit: c.n }, { db: s.db, now: '2026-11-05' });
    const { total: _total, ...withoutTotal } = page;
    if (groundAnswer(said, { scenario, toolResults: [{ name: 'query_transactions', args: {}, result: withoutTotal }] }).ok) continue;
    pick = c;
    break;
  }
  assert.ok(pick, 'some account has a match count that only the total states');
  const n = pick.n;
  const said = `There are ${n} matching transactions.`;
  const { engine, responses } = scripted(s.runtime, [
    [{ toolCalls: [{ name: 'query_transactions', args: { accountId: pick.id, limit: n } }] }, { text: said }],
    [{ text: said }],
  ]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: THREAD, text: 'Synthetic count question' });
  assert.ok(!reply.notice);
  const got = responses[0].toolResults.find(r => r.name === 'query_transactions');
  assert.ok(got && !got.isError, JSON.stringify(responses[0].toolResults));
  assert.equal(got.result.total, n, 'the real tool counts every match');
  assert.equal(got.result.rows.length, n);
  assert.equal(got.result.truncated, false);
  const { unverified } = reply.provenance.grounding;
  assert.ok(!unverified.includes(String(n)), `the computed total ${n} grounds: ${JSON.stringify(reply.provenance.grounding)}`);
  const literal = reply.provenance.literals.find(l => l.text === String(n));
  assert.equal(literal && literal.source, 'query_transactions', JSON.stringify(reply.provenance.literals));

  // A top-level number under a different key than the equal argument is a value, not an echo.
  const other = groundAnswer(LAUNDERED, { scenario, data: [],
    toolResults: [{ name: 'query_transactions', args: { minAmount: 4821 }, result: { rows: [], floor: 4821, total: 0 } }] });
  assert.equal(other.ok, true, JSON.stringify(other.violations));
  assert.equal(other.literals.find(l => l.text === '4821').source, 'query_transactions');
});

// B: prose sentences that carry bare numbers only, and ones that carry one marked quantity each.
const BARE_PROSE = 'Catch up at age 50 or older under Section 125 rules, and see IRS Publication 560 for details.';
const BARE_NUMBERS = ['50', '125', '560', '$560'];
const MARKED = [
  { prose: 'The synthetic cap is $7,000 for the year.', said: '$7,000', span: '$7,000' },
  { prose: 'The synthetic rate is 6% this year.', said: '6%', span: '6%' },
  { prose: 'The synthetic rate is 6 percent this year.', said: '6 percent', span: '6 percent' },
  { prose: 'It saves about 20k a year.', said: '20k', span: '20k' },
  // The answer side reads "million" as its own number word, so only the numeral is asserted.
  { prose: 'It reaches about 2 million in total.', said: '2 million', span: '2' },
];

// The four places prose evidence reaches groundAnswer, each carrying `prose`.
const proseSources = prose => [
  { label: 'pack entry body', toolResults: [], data: [[`# Synthetic entry\n\n${prose}\n`]] },
  { label: 'tool result description', data: [], toolResults: [{ name: 'list_recommendations', args: {}, result: [{ status: 'doing', description: prose }] }] },
  { label: 'rec context', toolResults: [], data: [{ recommendation: { status: 'doing', why: prose } }] },
  { label: 'household summary', toolResults: [], data: [{ facts: { 'synthetic.note': prose } }] },
];

test('R3 B: bare numbers in prose evidence never ground; marked quantities and JSON numbers do', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  for (const where of proseSources(BARE_PROSE)) {
    for (const text of BARE_NUMBERS) {
      const r = groundAnswer(`The figure is ${text}.`, { scenario, ...where });
      assert.ok(laundered(r).includes(text), `${where.label}: "${BARE_PROSE}" must not ground ${text}`);
    }
  }
  for (const { prose, said, span } of MARKED) {
    // A marked quantity grounds alone and next to bare numbers in the same sentence.
    for (const sentence of [prose, `${prose} ${BARE_PROSE}`]) {
      for (const where of proseSources(sentence)) {
        const r = groundAnswer(`The figure is ${said}.`, { scenario, ...where });
        assert.ok(!laundered(r).includes(span), `${where.label}: "${sentence}" grounds ${span}: ${JSON.stringify(r.violations)}`);
        if (sentence !== prose) {
          const bare = groundAnswer('The figure is 50.', { scenario, ...where });
          assert.ok(laundered(bare).includes('50'), `${where.label}: age 50 stays bare next to ${said}`);
        }
      }
    }
  }
  // JSON number fields stay evidence.
  const json = [
    { toolResults: [{ name: 'list_recommendations', args: {}, result: [{ catchUpAge: 50, cap: 560 }] }], data: [] },
    { toolResults: [], data: [{ recommendation: { catchUpAge: 50, cap: 560 } }] },
  ];
  for (const where of json) {
    for (const text of ['50', '$560']) {
      const r = groundAnswer(`The figure is ${text}.`, { scenario, ...where });
      assert.equal(r.ok, true, `${text}: ${JSON.stringify(r.violations)}`);
    }
  }
});

test('R3 B (F1): inline citations (IRS Publication 560) in the active demo packs never ground $560', async t => {
  const s = await demoStore(t);
  const body = readFileSync(join(ROOT, 'packs', 'advanced-retirement', 'contribution-limits-2026.md'), 'utf8');
  assert.ok(body.includes('IRS Publication 560'), 'the pack entry cites Publication 560 inline');
  const said = 'The synthetic limit is $560, and the deferral limit is $24,500.';
  const { engine, requests } = always(s.runtime, said);
  const answerer = createLiveAnswerer({ engine, packs: s.packs });

  // Self-check: with every pack whose entries mention 560 off, nothing else in the demo store grounds $560.
  const citing = new Set(s.packs.loaded().filter(p => p.entries.some(e => e.body.includes('560'))).map(p => p.id));
  assert.ok(citing.has('advanced-retirement'));
  const rows = s.db.prepare('SELECT id, def FROM packs_state').all().filter(r => citing.has(JSON.parse(r.def).manifest)).map(r => r.id);
  const setActive = value => { for (const id of rows) s.db.prepare('UPDATE packs_state SET active = ? WHERE id = ?').run(value, id); };
  setActive(0);
  const off = await answerer.answer({ db: s.db, key: THREAD, text: 'Synthetic publication question' });
  assert.ok(!off.provenance.packIds.some(id => citing.has(id)), JSON.stringify(off.provenance.packIds));
  assert.ok(off.provenance.grounding.unverified.includes('$560'), JSON.stringify(off.provenance.grounding));

  setActive(null);
  const active = await answerer.answer({ db: s.db, key: THREAD, text: 'Synthetic publication question' });
  assert.ok(!active.notice);
  assert.ok(active.provenance.packIds.includes('advanced-retirement'), 'the pack is active');
  assert.ok(requests.at(-1).system.includes('IRS Publication 560'), 'the model still sees the citation');
  assert.ok(active.provenance.grounding.unverified.includes('$560'),
    `Publication 560 must not ground $560: ${JSON.stringify(active.provenance.grounding)}`);
  assert.ok(!active.provenance.grounding.unverified.includes('$24,500'), 'the marked limit in the same entry still grounds');
});

test('a magnitude word followed by percent never grounds on the $1,000 in the self-employed-partnership entry', async t => {
  const s = await demoStore(t);
  const body = readFileSync(join(ROOT, 'packs', 'self-employed-partnership', 'estimated-tax.md'), 'utf8');
  assert.ok(body.includes('$1,000'), 'the pack entry carries $1,000');
  const answerer = createLiveAnswerer({ engine: always(s.runtime, 'The change is 1 thousand percent.').engine, packs: s.packs });
  const reply = await answerer.answer({ db: s.db, key: THREAD, text: 'Synthetic percent question' });
  assert.ok(!reply.notice);
  assert.ok(reply.provenance.packIds.includes('self-employed-partnership'), 'the pack is active');
  assert.ok(reply.provenance.grounding.unverified.includes('1 thousand percent'),
    `1 thousand percent must be ungrounded: ${JSON.stringify(reply.provenance.grounding)}`);
});

test('a spelled number followed by a percent sign never grounds on the $1,000 in the self-employed-partnership entry', async t => {
  const s = await demoStore(t);
  const body = readFileSync(join(ROOT, 'packs', 'self-employed-partnership', 'estimated-tax.md'), 'utf8');
  assert.ok(body.includes('$1,000'), 'the pack entry carries $1,000');
  const answerer = createLiveAnswerer({ engine: always(s.runtime, 'The change is one thousand %.').engine, packs: s.packs });
  const reply = await answerer.answer({ db: s.db, key: THREAD, text: 'Synthetic percent question' });
  assert.ok(!reply.notice);
  assert.ok(reply.provenance.packIds.includes('self-employed-partnership'), 'the pack is active');
  assert.ok(reply.provenance.grounding.unverified.includes('one thousand'),
    `one thousand % must be ungrounded: ${JSON.stringify(reply.provenance.grounding)}`);
});

// A synthetic active pack: bare prose numbers and marked quantities, values nothing in the demo states.
const PROSE_PACK = {
  id: 'synthetic-prose',
  name: 'Synthetic prose',
  appliesWhen: ALWAYS,
  covers: ['synthetic prose limits'],
  entries: [{
    file: 'synthetic-prose.md',
    title: 'Synthetic prose limit',
    body: '# Synthetic prose limit\n\nAt age 57 or older under Publication 4383 the synthetic cap is $7,013, ' +
      'the rate is 6.7%, growth is 3.9 percent and about 23k a year qualifies.\n',
  }],
};

test('R3 B: in an active pack entry body only marked quantities ground, end to end', async t => {
  const s = await demoStore(t, {}, { prepare: dataDir => writeSyntheticPack(dataDir, PROSE_PACK) });
  const said = 'At 57, under 4383, the cap is $7,013, the rate is 6.7%, growth is 3.9 percent and 23k qualifies.';
  const answerer = createLiveAnswerer({ engine: always(s.runtime, said).engine, packs: s.packs });

  // Self-check: without the pack, none of these values ground.
  s.db.prepare("UPDATE packs_state SET active = 0 WHERE id = 'synthetic-prose'").run();
  const off = await answerer.answer({ db: s.db, key: THREAD, text: 'Synthetic prose question' });
  assert.ok(!off.provenance.packIds.includes('synthetic-prose'));
  assert.deepEqual(sorted(off.provenance.grounding.unverified), sorted(['57', '4383', '$7,013', '6.7%', '3.9 percent', '23k']));

  s.db.prepare("UPDATE packs_state SET active = NULL WHERE id = 'synthetic-prose'").run();
  const reply = await answerer.answer({ db: s.db, key: THREAD, text: 'Synthetic prose question' });
  assert.ok(reply.provenance.packIds.includes('synthetic-prose'), 'the synthetic pack is active');
  const { unverified } = reply.provenance.grounding;
  for (const bare of ['57', '4383']) assert.ok(unverified.includes(bare), `bare ${bare} must not ground: ${JSON.stringify(unverified)}`);
  for (const marked of ['$7,013', '6.7%', '3.9 percent', '23k']) {
    assert.ok(!unverified.includes(marked), `${marked} grounds: ${JSON.stringify(unverified)}`);
    const literal = reply.provenance.literals.find(l => l.text === marked);
    assert.equal(literal && literal.source, 'knowledge pack entries', JSON.stringify(reply.provenance.literals));
  }
});

test('R3 D: K-12 and 2026-01 never read as negatives in evidence or in the answer', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const evidence = [
    { name: 'list_recommendations', args: {}, result: [{ status: 'doing', description: 'Private K-12 tuition can qualify.' }] },
    { name: 'list_recommendations', args: {}, result: [{ status: 'doing', grade: 'K-12' }] },
    { name: 'pnl_by_month', args: {}, result: { rows: [{ period: '2026-01', category: 'synthetic', amount: 0 }], totals: {} } },
  ];
  for (const r of evidence) {
    for (const text of ['-12', '−12', '-$12', '-1', '−1', '-$1']) {
      const g = groundAnswer(`The change is ${text}.`, { scenario, data: [], toolResults: [r] });
      assert.equal(g.ok, false, `${JSON.stringify(r.result)} must not ground ${text}`);
    }
  }
  const prose = groundAnswer('Private K-12 tuition can qualify.', { scenario, toolResults: [], data: [] });
  assert.ok(!prose.violations.some(v => v.text.startsWith('-')), `K-12 is not read as a negative: ${JSON.stringify(prose.violations)}`);
});

// Canned demo answers that were unverified before round 3, independent of it.
const KNOWN_UNVERIFIED = new Set(['ask:salary', 'rec:offcycle:1', 'whatif:scorp']);

test('R3 demo regression: every canned demo answer stays grounded except the known pre-existing ones; What if kids is grounded', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const answerer = createLiveAnswerer({ engine: s.runtime, packs: s.packs });
  const outcomes = new Map();
  for (const q of scenario.ask.suggested) {
    outcomes.set(`ask:${q.id}`, (await answerer.answer({ db: s.db, key: THREAD, text: q.q })).provenance.grounding);
  }
  for (const rec of scenario.recs) {
    for (let i = 0; i < (rec.qa || []).length; i++) {
      outcomes.set(`rec:${rec.id}:${i}`, (await answerer.answer({ db: s.db, key: rec.id, questionId: i })).provenance.grounding);
    }
  }
  for (const pack of scenario.packs) {
    if (!pack.whatIf) continue;
    outcomes.set(`whatif:${pack.id}`, (await answerer.whatIf({ db: s.db, packId: pack.id })).provenance.grounding);
  }
  assert.ok(outcomes.size >= 20, `the demo has its canned answers: ${outcomes.size}`);
  assert.ok(outcomes.has('whatif:kids'), 'the kids pack has a What if');
  assert.deepEqual(outcomes.get('whatif:kids').unverified, [], 'the K-12 What if stays grounded');
  const broken = [...outcomes].filter(([id, g]) => !g.ok && !KNOWN_UNVERIFIED.has(id)).map(([id, g]) => `${id} ${JSON.stringify(g.unverified)}`);
  assert.deepEqual(broken, []);
});

// ---------------------------------------------------------------- round 4: URLs, dates, letter codes, atomic numbers

const R4_CONTROL = { prose: 'The synthetic cap is $7,013 this year.', field: { cap: 7013 }, said: '$7,013' };

// R4 F1: digits, k and % inside a URL or a markdown link destination are not quantities.
const URL_PROSE = [
  'See [policy](https://example.invalid/4821k) for details.',
  'See [policy](https://example.invalid/$4821) for details.',
  'See [policy](https://example.invalid/4821%25) for details.',
  'See [policy](/docs/4821k) for details.',
  'See https://example.invalid/4821k/limits for details.',
  'See https://example.invalid/doc?limit=4821k&cap=4821%25 for details.',
  'See http://example.invalid/4821%20limits for details.',
  'See <https://example.invalid/4821k> for details.',
  'See <https://example.invalid/$4821> for details.',
];
const URL_INVENTED = ['$4,821,000', '$4,821', '4821%'];

test('R4 F1: digits, k and % inside URLs, link destinations and autolinks never ground in prose evidence', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  for (const prose of URL_PROSE) {
    for (const where of proseSources(prose)) {
      for (const text of URL_INVENTED) {
        const r = groundAnswer(`The figure is ${text}.`, { scenario, ...where });
        assert.ok(laundered(r).includes(text), `${where.label}: "${prose}" must not ground ${text}`);
      }
    }
  }
});

test('R4 F1: a single-token URL string under an unremarkable key never grounds its digits', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  for (const link of ['https://example.invalid/4821k', 'https://example.invalid/$4821', 'https://example.invalid/4821%25', 'https://example.invalid/4821%']) {
    for (const text of URL_INVENTED) {
      for (const where of [
        { label: 'tool result', data: [], toolResults: [{ name: 'list_recommendations', args: {}, result: [{ status: 'doing', link }] }] },
        { label: 'rec context', toolResults: [], data: [{ recommendation: { status: 'doing', link } }] },
      ]) {
        const r = groundAnswer(`The figure is ${text}.`, { scenario, ...where });
        assert.ok(laundered(r).includes(text), `${where.label}: ${link} must not ground ${text}`);
      }
    }
  }
});

test('R4 F1: a marked quantity in link text outside the URL still grounds', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  for (const prose of [
    'See [the $500 limit](https://example.invalid/x) for details.',
    'See [the $500 limit](https://example.invalid/4821k) for details.',
    'The $500 limit applies (see https://example.invalid/4821k).',
    'The $500 limit applies, see <https://example.invalid/4821k>.',
  ]) {
    for (const where of proseSources(prose)) {
      const ok = groundAnswer('The figure is $500.', { scenario, ...where });
      assert.equal(ok.ok, true, `${where.label}: "${prose}" grounds $500: ${JSON.stringify(ok.violations)}`);
      const bad = groundAnswer('The figure is $4,821,000.', { scenario, ...where });
      assert.ok(laundered(bad).includes('$4,821,000'), `${where.label}: "${prose}" must not ground $4,821,000`);
    }
  }
});

// R4 F2: a month period (YYYY-MM) or another date-shaped single token is a date, not a number.
const DATE_TOKENS = ['2026-11', '2026-11-05', '2026-11-05T10:00:00Z'];
const DATE_INVENTED = ['$11', '11', '-11', '$5', '5', '-5', '$10', '$2,026'];

test('R4 F2: the real pnl_by_month result over the demo store never grounds its month or year as a number', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const result = await callTool('pnl_by_month', {}, { db: s.db, now: clockNow(s.db) });
  assert.ok(result.rows.length > 0, 'the demo store has P&L rows');
  const period = result.rows.map(r => r.period).sort().at(-1);
  assert.match(period, /^\d{4}-\d{2}$/);
  const month = String(Number(period.slice(5)));
  const year = Number(period.slice(0, 4)).toLocaleString('en-US');
  const said = [`$${month}`, month, `$${year}`];
  const ground = (r, text) => groundAnswer(`The figure is ${text}.`, { scenario, data: [], toolResults: [{ name: 'pnl_by_month', args: {}, result: r }] });

  // Self-check: without the periods nothing in the result states these values.
  const stripped = { rows: result.rows.map(({ period: _p, ...row }) => row), totals: Object.values(result.totals) };
  for (const text of said) assert.ok(laundered(ground(stripped, text)).includes(text), `self-check: ${text} is not a P&L value`);

  for (const text of said) {
    assert.ok(laundered(ground(result, text)).includes(text), `period ${period} must not ground ${text}`);
  }
  // A stored row amount still grounds, attributed to pnl_by_month.
  const row = result.rows.find(r => r.amount > 0);
  const amount = `$${row.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const kept = ground(result, amount);
  assert.equal(kept.ok, true, `${amount}: ${JSON.stringify(kept.violations)}`);
  assert.equal(kept.literals.find(l => l.text === amount).source, 'pnl_by_month');
});

test('R4 F2: a synthetic period next to an unrelated amount grounds the amount and not $11 or 11', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const toolResults = [{ name: 'pnl_by_month', args: {},
    result: { rows: [{ period: '2026-11', category: 'synthetic', amount: 4321.5 }], totals: { '2026-11': 4321.5 } } }];
  for (const text of ['$11', '11', '$2,026']) {
    const r = groundAnswer(`The figure is ${text}.`, { scenario, data: [], toolResults });
    assert.ok(laundered(r).includes(text), `period 2026-11 must not ground ${text}`);
  }
  assert.equal(groundAnswer('The figure is $4,321.50.', { scenario, data: [], toolResults }).ok, true);
});

test('R4 F2: date-shaped single-token strings under unremarkable keys ground no number', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  for (const value of DATE_TOKENS) {
    for (const key of ['asOf', 'month', 'note', 'when']) {
      const wheres = [
        { label: 'tool result', data: [], toolResults: [{ name: 'list_recommendations', args: {}, result: [{ status: 'doing', [key]: value }] }] },
        { label: 'tool result array', data: [], toolResults: [{ name: 'list_recommendations', args: {}, result: { [key]: [value] } }] },
        { label: 'household summary', toolResults: [], data: [{ facts: { [`synthetic.${key}`]: value } }] },
        { label: 'rec context', toolResults: [], data: [{ recommendation: { status: 'doing', [key]: value } }] },
      ];
      for (const where of wheres) {
        for (const text of DATE_INVENTED) {
          const r = groundAnswer(`The figure is ${text}.`, { scenario, ...where });
          assert.ok(laundered(r).includes(text), `${where.label}: ${key}=${value} must not ground ${text}`);
        }
      }
    }
  }
});

// R4 F3: only recognized letter-code vocabulary is masked in the answer.
test('R4 F3: arbitrary short letter codes in the answer are ungrounded numbers, recognized forms stay masked', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  for (const [text, number] of [['Your benefit is X-873 dollars.', '873'], ['Your benefit is AB-500 dollars.', '500'],
    ['You get Q-12 more.', '12'], ['The credit is ZZ-40 this year.', '40']]) {
    const r = groundAnswer(text, { scenario, toolResults: [], data: [] });
    assert.equal(r.ok, false, `"${text}" must not pass unchecked`);
    assert.ok(laundered(r).includes(number), `"${text}" flags ${number}: ${JSON.stringify(r.violations)}`);
  }
  for (const text of ['Private K-12 tuition can qualify.', 'Her Schedule K-1 arrives later.', 'File a new Form I-9.',
    'Your W-2 shows wages.', 'Update your W-4.', 'A 1099-K reports card payments.', 'Your 1099-NEC arrives in January.']) {
    const r = groundAnswer(text, { scenario, toolResults: [], data: [] });
    assert.equal(r.ok, true, `"${text}" is vocabulary: ${JSON.stringify(r.violations)}`);
  }
});

test('R4 F3: the What if kids canned answer (K-12) stays grounded', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const kids = scenario.packs.find(p => p.id === 'kids');
  assert.ok(kids && kids.whatIf && kids.whatIf.a.some(a => a.includes('K-12')), 'the kids What if says K-12');
  const reply = await createLiveAnswerer({ engine: s.runtime, packs: s.packs }).whatIf({ db: s.db, packId: 'kids' });
  assert.ok(joined(reply).includes('K-12'), joined(reply));
  assert.equal(reply.provenance.grounding.ok, true, JSON.stringify(reply.provenance.grounding));
  assert.deepEqual(reply.provenance.grounding.unverified, []);
});

// R4 F4: a numeric expression in prose evidence is one quantity. literal() parses an exponent
// (the engine reads 1e3 in an answer as 1000), so $1e3 in evidence is read as $1,000, never as
// $1 next to a bare 3.
test('R4 F4: scientific notation and decimals in prose evidence ground the whole number, never its parts', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const cases = [
    { prose: 'The allowance is $1e3.', grounds: ['$1,000', '$1e3'], not: ['$1', '1', '3', '$3'] },
    { prose: 'The allowance is $1.5e3 now.', grounds: ['$1,500'], not: ['$1.5', '$1', '5', '3'] },
    { prose: 'The fee is $4.50 per month.', grounds: ['$4.50'], not: ['$4', '4', '50', '$50'] },
    { prose: 'The rate is 12.5% this year.', grounds: ['12.5%'], not: ['12', '5', '12%', '5%'] },
    { prose: 'The cap is $1,000.50 in total.', grounds: ['$1,000.50'], not: ['50', '$50', '$1'] },
  ];
  for (const { prose, grounds, not } of cases) {
    for (const where of proseSources(prose)) {
      for (const text of grounds) {
        const r = groundAnswer(`The figure is ${text}.`, { scenario, ...where });
        assert.equal(r.ok, true, `${where.label}: "${prose}" grounds ${text}: ${JSON.stringify(r.violations)}`);
      }
      for (const text of not) {
        const r = groundAnswer(`The figure is ${text}.`, { scenario, ...where });
        assert.ok(laundered(r).includes(text), `${where.label}: "${prose}" must not ground ${text}`);
      }
    }
  }
});

// R4 adversarial table: every evidence source times every laundering form found so far. Each
// carrier also states one real quantity (the positive control), which must still ground.
const LAUNDERING_FORMS = [
  { form: 'URL digits',
    prose: 'See [policy](https://example.invalid/4821k), https://example.invalid/4821%25 and <https://example.invalid/$4821>.',
    field: { link: 'https://example.invalid/4821k', doc: 'https://example.invalid/$4821', more: ['https://example.invalid/4821%25'] },
    invented: ['$4,821,000', '$4,821', '4821%'] },
  { form: 'identifier tokens',
    prose: 'Ask about plan4821, acct-4821k, plan_4821k and plan-4821% today.',
    field: { ref: 'plan4821', accountNumber: 4821, accountId: 'acct-4821k', tag: 'plan_4821k', code: 'plan-4821%' },
    invented: ['$4,821,000', '$4,821', '4821', '4821%'] },
  { form: 'citation numbers',
    prose: 'See IRS Publication 4821, Section 4821(b), page 4821 and Notice 2026-48.',
    field: { page: 4821, cites: ['Publication 4821'], source: { name: 'guide 4821' }, file: 'guide-4821.md' },
    invented: ['$4,821', '4821', '48', '-48'] },
  { form: 'month periods',
    prose: 'For the period 2026-11 the total rose, as of 2026-11-05T10:00:00Z.',
    field: { period: '2026-11', asOf: '2026-11', month: '2026-11-05', when: '2026-11-05T10:00:00Z' },
    invented: ['$11', '11', '-11', '$5', '$10', '$2,026'] },
  { form: 'letter codes',
    prose: 'Plan AB-500 and code X-873 apply under Q-12.',
    field: { code: 'AB-500', plan: 'X-873', grade: 'Q-12' },
    invented: ['$500', '500', '-500', '$873', '873', '-12'] },
  { form: 'scaled quantities',
    prose: 'The benefit is 8.7 million, the fee is 2 thousand and the pool is 1.5 billion.',
    field: { note: 'The benefit is 8.7 million, the fee is 2 thousand and the pool is 1.5 billion.' },
    invented: ['$8.70', '8.7', '$8.7', '$2', '2', '$1.50', '1.5', '$1.5'] },
  { form: 'parenthesized link destinations',
    prose: 'See [policy](https://example.invalid/a(b)/$4821), [nested](https://example.invalid/a(b(c))/d(e)/4821k) and https://example.invalid/w(x)/$4821 today.',
    field: { link: 'https://example.invalid/a(b)/$4821', doc: 'https://example.invalid/a(b(c))/d(e)/4821k' },
    invented: ['$4,821', '4821', '$4,821,000'] },
];

const EVIDENCE_SOURCES = [
  { label: 'pack entry body', make: ({ prose }) => ({ toolResults: [], data: [[`# Synthetic entry\n\n${prose}\n`]] }) },
  { label: 'tool result prose', make: ({ prose }) => ({ data: [],
    toolResults: [{ name: 'list_recommendations', args: {}, result: [{ status: 'doing', description: prose }] }] }) },
  { label: 'tool result JSON', make: ({ field }) => ({ data: [],
    toolResults: [{ name: 'list_recommendations', args: {}, result: [{ status: 'doing', ...field }] }] }) },
  { label: 'household summary', make: ({ prose, field }) => ({ toolResults: [], data: [{ facts: { 'synthetic.note': prose }, ...field }] }) },
  { label: 'rec context', make: ({ prose, field }) => ({ toolResults: [], data: [{ recommendation: { status: 'doing', why: prose, ...field } }] }) },
];

test('R4 adversarial table: no evidence source launders an invented amount through any known form; real quantities still ground', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const failures = [];
  for (const source of EVIDENCE_SOURCES) {
    const control = groundAnswer(`The figure is ${R4_CONTROL.said}.`, { scenario, ...source.make(R4_CONTROL) });
    if (!control.ok) failures.push(`${source.label}: control ${R4_CONTROL.said} does not ground`);
    for (const form of LAUNDERING_FORMS) {
      const carrier = { prose: `${form.prose} ${R4_CONTROL.prose}`, field: { ...form.field, ...R4_CONTROL.field } };
      const where = source.make(carrier);
      const kept = groundAnswer(`The figure is ${R4_CONTROL.said}.`, { scenario, ...where });
      if (!kept.ok) failures.push(`${source.label} / ${form.form}: control ${R4_CONTROL.said} no longer grounds`);
      for (const text of form.invented) {
        const r = groundAnswer(`The figure is ${text}.`, { scenario, ...where });
        if (!laundered(r).includes(text)) failures.push(`${source.label} / ${form.form}: grounds ${text}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

// ---------------------------------------------------------------- round 5: scaled quantities, parenthesized URLs

const SCALED_PROSE = [
  { prose: 'The benefit is 8.7 million.', grounds: ['$8.7 million', '$8,700,000', '8.7 million'], not: ['$8.70', '8.7', '$8.7', '$8'] },
  { prose: 'The fee is 2 thousand.', grounds: ['2 thousand', '$2,000', '$2 thousand'], not: ['$2', '2', '$2.00'] },
  { prose: 'The pool is 1.5 billion.', grounds: ['1.5 billion', '$1.5 billion', '$1,500,000,000'], not: ['$1.50', '1.5', '$1.5', '$1'] },
];

test('R5 F1: a scaled quantity in prose evidence grounds its full value, never the bare coefficient', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const failures = [];
  for (const { prose, grounds, not } of SCALED_PROSE) {
    for (const where of proseSources(prose)) {
      for (const text of grounds) {
        const r = groundAnswer(`The figure is ${text}.`, { scenario, ...where });
        if (!r.ok) failures.push(`${where.label}: "${prose}" should ground ${text}: ${JSON.stringify(laundered(r))}`);
      }
      for (const text of not) {
        const r = groundAnswer(`The figure is ${text}.`, { scenario, ...where });
        if (!laundered(r).includes(text)) failures.push(`${where.label}: "${prose}" must not ground ${text}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

const PAREN_PROSE = [
  'See [policy](https://example.invalid/a(b)/$4821).',
  'See [policy](https://example.invalid/a(b(c))/$4821) for details.',
  'See [policy](https://example.invalid/a(b)/c(d)/4821k) for details.',
  'See [policy](/docs/a(b)/$4821).',
  'See https://example.invalid/a(b)/$4821 for details.',
  'See https://example.invalid/w(x)/y(z)/4821k today.',
  'See <https://example.invalid/a(b)/$4821> for details.',
];

test('R5 F2: link destinations and bare URLs with parentheses never ground their digits', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const failures = [];
  for (const prose of PAREN_PROSE) {
    for (const where of proseSources(prose)) {
      for (const text of ['$4,821', '4821']) {
        const r = groundAnswer(`The figure is ${text}.`, { scenario, ...where });
        if (!laundered(r).includes(text)) failures.push(`${where.label}: "${prose}" must not ground ${text}`);
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('R5 F2: a marked amount in the link text of a parenthesized destination still grounds', async t => {
  const s = await demoStore(t);
  const scenario = buildScenario(s.db);
  const failures = [];
  for (const prose of [
    'See [the $500 limit](https://example.invalid/a(b)/$4821) for details.',
    'See [the $500 limit](https://example.invalid/a(b(c))/d(e)/4821k) for details.',
  ]) {
    for (const where of proseSources(prose)) {
      const ok = groundAnswer('The figure is $500.', { scenario, ...where });
      if (!ok.ok) failures.push(`${where.label}: "${prose}" should ground $500: ${JSON.stringify(laundered(ok))}`);
      const bad = groundAnswer('The figure is $4,821.', { scenario, ...where });
      if (!laundered(bad).includes('$4,821')) failures.push(`${where.label}: "${prose}" must not ground $4,821`);
    }
  }
  assert.deepEqual(failures, []);
});
