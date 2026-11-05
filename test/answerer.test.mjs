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
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '@anthropic-ai/claude-agent-sdk';
import { seedDemo } from '../demo/seed.mjs';
import { loadConfig } from '../src/config.mjs';
import { setSetting } from '../src/store/db.mjs';
import { buildScenario } from '../src/scenario/build.mjs';
import { callTool } from '../src/tools/index.mjs';
import { sdkOptions } from '../src/engine/live.mjs';
import { createRuntimeEngine } from '../src/engine/runtime.mjs';
import { createPackRefresher } from '../src/packs/state.mjs';
import { PRODUCT_RULES, buildChatPrompt, groundAnswer, renderAnswer, createLiveAnswerer } from '../src/api/answerer.mjs';
import { tempDb } from './helpers/server.mjs';

const ACTIVE_DEMO_PACKS = ['advanced-retirement', 'kids-dependents', 's-corp-owner', 'self-employed-partnership', 'virginia-resident', 'w2-benefits'];
const UNVERIFIED = '<span class="fx-unverified" title="Not found in your data or tool results">';
const INVENTED = '$987,654';

async function demoStore(t, env = {}) {
  const s = await tempDb();
  t.after(async () => { s.close(); await rm(s.dataDir, { recursive: true, force: true }); });
  seedDemo(s.db);
  const config = loadConfig({ FATHOM_DATA: s.dataDir, FATHOM_ENGINE: 'fake', ...env });
  const runtime = createRuntimeEngine({ db: s.db, config });
  const packs = createPackRefresher(s.db, { dataDir: s.dataDir });
  packs.refresh();
  return { ...s, config, runtime, packs };
}

// The runtime with call() intercepted: records each request and, while scripts remain, sends the
// next one as request.fake. `before(n)` runs before call n (0-based) is delegated.
function scripted(runtime, scripts = [], { before } = {}) {
  const queue = [...scripts];
  const requests = [];
  const engine = new Proxy(runtime, {
    get(target, key) {
      if (key === 'call') {
        return async request => {
          const n = requests.length;
          requests.push(request);
          if (before) before(n);
          const next = queue.shift();
          return target.call(next ? { ...request, fake: next } : request);
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { engine, requests };
}

const spendCount = db => db.prepare('SELECT count(*) AS n FROM spend_ledger').get().n;
const joined = reply => reply.paragraphs.join('\n');
const toolNames = request => (request.tools || []).map(tool => tool.name);
const sorted = list => [...list].sort();

// ---------------------------------------------------------------- prompt assembly

test('PRODUCT_RULES states the advisory boundaries, the figure token rule and the write tool rule', () => {
  assert.equal(typeof PRODUCT_RULES, 'string');
  assert.match(PRODUCT_RULES, /advisory/i);
  assert.ok(PRODUCT_RULES.includes('{f:'), 'figure tokens are explained');
  assert.ok(PRODUCT_RULES.includes('get_figures'));
  assert.ok(PRODUCT_RULES.includes('set_recommendation_status'));
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

test('when the corrective retry is refused over the cap, the first answer is kept and marked', async t => {
  const s = await demoStore(t);
  const { engine, requests } = scripted(s.runtime, [
    [{ text: `You could save ${INVENTED} this year.` }],
    [{ text: 'must not run' }],
  ], { before: n => { if (n === 1) setSetting(s.db, 'cap', { usd: 0 }); } });
  const reply = await createLiveAnswerer({ engine, packs: s.packs }).answer({ db: s.db, key: 'ask', text: 'Synthetic retry question' });
  assert.equal(requests.length, 2);
  assert.ok(!reply.notice, 'the first answer is kept, not replaced by a notice');
  assert.ok(joined(reply).includes(`${UNVERIFIED}${INVENTED}</span>`), joined(reply));
  assert.ok(!joined(reply).includes('must not run'));
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

test('the recommendation status write tool is offered only for a status request that is not a question', async t => {
  const s = await demoStore(t);
  const { engine, requests } = scripted(s.runtime);
  const answerer = createLiveAnswerer({ engine, packs: s.packs });
  await answerer.answer({ db: s.db, key: 'deferral', text: 'Please mark this done' });
  await answerer.answer({ db: s.db, key: 'deferral', text: 'Snooze this until next month' });
  await answerer.answer({ db: s.db, key: 'deferral', text: 'Should I mark this done?' });
  await answerer.answer({ db: s.db, key: 'deferral', text: 'Tell me about the payroll cash' });
  const offered = requests.map(r => toolNames(r).includes('set_recommendation_status'));
  assert.deepEqual(offered, [true, true, false, false]);
  for (const r of requests) assert.ok(toolNames(r).includes('household_summary'), 'read tools are always offered');
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
