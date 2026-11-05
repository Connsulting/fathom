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
import { seedDemo } from '../demo/seed.mjs';
import { loadConfig } from '../src/config.mjs';
import { setSetting } from '../src/store/db.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { callTool } from '../src/tools/index.mjs';
import { sdkOptions } from '../src/engine/live.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { createPackRefresher } from '../src/packs/state.mjs';
import { PRODUCT_RULES, NOTICES, buildChatPrompt, groundAnswer, renderAnswer, createLiveAnswerer } from '../src/api/answerer.mjs';
import { ACTION_STATUS } from '../src/shared/rules.mjs';
import { ROOT, tempDb } from './helpers/server.mjs';
import { writeSyntheticPack, ALWAYS } from './helpers/packs.mjs';

const ACTIVE_DEMO_PACKS = ['advanced-retirement', 'kids-dependents', 's-corp-owner', 'self-employed-partnership', 'virginia-resident', 'w2-benefits'];
const UNVERIFIED = '<span class="fx-unverified" title="Not found in your data or tool results">';
const INVENTED = '$987,654';

// `prepare(dataDir)` runs before the pack refresher first loads, so a test can put a synthetic
// pack in the data volume pack directory.
async function demoStore(t, env = {}, { prepare } = {}) {
  const s = await tempDb();
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  seedDemo(s.db);
  if (prepare) prepare(s.dataDir);
  const config = loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake', ...env });
  const runtime = createRuntimeEngine({ db: s.db, config });
  const packs = createPackRefresher(s.db, { dataDir: s.dataDir });
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
    // A number echoed under another key, compared numerically.
    { name: 'query_transactions', args: { minAmount: 4821 }, result: { rows: [], floor: 4821.0, total: 0 } },
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
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: 'ask', text: 'Synthetic metadata question' });
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
  const reply = await answerer.answer({ db: s.db, key: 'ask', questionId: 'leave' });
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
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: 'ask', text: 'Synthetic retry question' });
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
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: 'ask', text: 'Synthetic retry question' });
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
const monthOf = engine => engine.now().slice(0, 7).replace('-', '');

test('B1: a corrective retry refused by the engine switch answers with the engine-off notice and keeps the first spend row', async t => {
  const s = await demoStore(t);
  const { engine, requests } = scripted(s.runtime, [
    [{ text: `You could save ${INVENTED} this year.` }],
    [{ text: 'must not run' }],
  ], { before: n => { if (n === 1) setSetting(s.db, 'engine', { on: false }); } });
  const before = chatRows(s.db).length;
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: 'ask', text: 'Synthetic retry question' });
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
  setSetting(s.db, 'cap', { usd: s.runtime.ledger.monthSpendUsd(monthOf(s.runtime)) + 0.5 });
  const { engine, requests } = scripted(s.runtime, [
    [{ text: `You could save ${INVENTED} this year.`, costUsd: 1 }],
    [{ text: 'must not run' }],
  ]);
  const before = chatRows(s.db).length;
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: 'ask', text: 'Synthetic retry question' });
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
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: 'ask', text: 'Synthetic retry question' });
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
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: 'ask', text: 'How many items need me?' });
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
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: 'ask', text: 'Synthetic invoice question' });
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
  const off = await answerer.answer({ db: s.db, key: 'ask', questionId: 'leave' });
  assert.equal(off.notice, true);
  assert.ok(joined(off).includes('Engine is off, so answers are paused.'), joined(off));
  assert.equal(spendCount(s.db), before);
  setSetting(s.db, 'engine', { on: true });
  const on = await answerer.answer({ db: s.db, key: 'ask', questionId: 'leave' });
  assert.ok(!on.notice);
  assert.ok(on.provenance);
});

test('engine off by configuration answers with the configuration notice and spends nothing', async t => {
  const s = await demoStore(t);
  const off = createRuntimeEngine({ db: s.db, config: loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'off' }) });
  const before = spendCount(s.db);
  const reply = await createLiveAnswerer({ engine: off, packs: s.packs }).answer({ db: s.db, key: 'ask', questionId: 'leave' });
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
  const capped = await answerer.answer({ db: s.db, key: 'ask', questionId: 'leave' });
  assert.equal(capped.notice, true);
  assert.ok(joined(capped).includes('{f:engine.budget.monthly}'), joined(capped));
  assert.ok(joined(capped).includes('is used up, so answers are paused'), joined(capped));
  assert.equal(spendCount(s.db), before);
  setSetting(s.db, 'cap', { usd: 200 });
  assert.ok(!(await answerer.answer({ db: s.db, key: 'ask', questionId: 'leave' })).notice);
});

test('a model error answers with the model-error notice and never stores the failed text', async t => {
  const s = await demoStore(t);
  const { engine } = scripted(s.runtime, [[{ text: 'Fabricated $123,456 figure', is_error: true, status: 'error_during_execution' }]]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: 'ask', text: 'Synthetic question' });
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
  for (const key of ['deferral', 'ask']) {
    for (const text of STATUS_TEXTS) await answerer.answer({ db: s.db, key, text });
  }
  await answerer.answer({ db: s.db, key: 'deferral', questionId: 0 });
  await answerer.answer({ db: s.db, key: 'ask', questionId: 'leave' });
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
  await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: 'ask', text: 'Synthetic question' });
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
    { toolCalls: [{ name: PROPOSE, args: { id: 'dcfsa', action: 'accept' } }] },
    { toolCalls: [{ name: PROPOSE, args: { id: 'dcfsa', action: 'snooze', wake: 'Next month' } }] },
    { toolCalls: [{ name: PROPOSE, args: { id: 'daf', action: 'dismiss' } }] },
    { text: 'You can confirm the snooze below.' },
  ]]);
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: 'ask', text: 'Snooze the dependent care one' });
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
    { id: 'no-such-rec', action: 'accept' },
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
    const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: 'ask', text: 'Synthetic proposal question' });
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
    ['ask', 'Please accept dcfsa', { recId: 'dcfsa', action: 'accept' }],
    ['ask', `Dismiss ${dcfsaTitle}`, { recId: 'dcfsa', action: 'dismiss' }],
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
    ['ask', 'dismiss something'],
    ['ask', 'Do not dismiss dcfsa'],
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
  const base = await answerer.answer({ db: s.db, key: 'ask', text: 'Synthetic override question' });
  assert.deepEqual(sorted(base.provenance.packIds), ACTIVE_DEMO_PACKS);
  s.db.prepare("UPDATE packs_state SET active = 1 WHERE id = 'giving'").run();
  const on = await answerer.answer({ db: s.db, key: 'ask', text: 'Synthetic override question' });
  assert.ok(on.provenance.packIds.includes('charitable-giving'));
  assert.notEqual(requests[1].system, requests[0].system, 'pack context follows the override');
  s.db.prepare("UPDATE packs_state SET active = 0 WHERE id = 'scorp'").run();
  const off = await answerer.answer({ db: s.db, key: 'ask', text: 'Synthetic override question' });
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

  const active = await answerer.answer({ db: s.db, key: 'ask', text: 'Which entry matters' });
  assert.ok(active.provenance.packEntries.includes(scorpTitle), 'active pack entries are still found');
  assert.ok(!active.provenance.packEntries.includes(givingTitle));
});

test('a what-if runs a live conversation seeded with the pack prompt and pack metadata', async t => {
  const s = await demoStore(t);
  const { engine, requests } = scripted(s.runtime);
  const def = buildScenario(s.db).packs.find(p => p.id === 'giving');
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
